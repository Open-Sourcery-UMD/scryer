-- Preserve an opaque account tombstone while allowing provider identity to be
-- removed only after the durable deletion job has completed.
-- Earlier schema versions allowed lifecycle markers but had no deletion
-- protocol. Refuse to guess whether such a row represents a real deletion.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM scryer.accounts
             WHERE status IN ('deleting', 'deleted')) THEN
    RAISE EXCEPTION 'LEGACY_ACCOUNT_LIFECYCLE_REVIEW_REQUIRED'
      USING ERRCODE = '23514';
  END IF;
END $$;

SET ROLE scryer_owner;
ALTER TABLE scryer.accounts
  ALTER COLUMN identity_issuer DROP NOT NULL,
  ALTER COLUMN identity_subject DROP NOT NULL,
  ADD COLUMN deletion_key text,
  ADD COLUMN deletion_digest text,
  ADD CONSTRAINT account_deletion_identity_shape CHECK (
    (status = 'deleted' AND identity_issuer IS NULL AND identity_subject IS NULL)
    OR (status <> 'deleted' AND identity_issuer IS NOT NULL AND identity_subject IS NOT NULL)
  ),
  ADD CONSTRAINT account_deletion_request_shape CHECK (
    (status IN ('deleting', 'deleted')) =
    (deletion_key IS NOT NULL AND deletion_digest IS NOT NULL)
    AND (deletion_key IS NULL OR deletion_key ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$')
    AND (deletion_digest IS NULL OR deletion_digest ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT account_deletion_zero_usage CHECK (
    status NOT IN ('deleting', 'deleted') OR used_bytes = 0
  );

ALTER TABLE scryer.deletion_jobs
  ADD COLUMN lease_token text,
  ADD COLUMN lease_until timestamptz,
  ADD CONSTRAINT deletion_lease_shape CHECK (
    (lease_token IS NULL) = (lease_until IS NULL)
    AND (lease_token IS NULL OR lease_token ~ '^[A-Za-z0-9_-]{22}$')
  );

CREATE FUNCTION scryer.check_initial_deletion_job()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, scryer AS $$
BEGIN
  IF NEW.state <> 'pending' OR NEW.attempts <> 0 OR
     NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL OR
     NEW.next_attempt_at > clock_timestamp() + interval '1 minute' OR
     NOT EXISTS (
       SELECT 1 FROM scryer.accounts
       WHERE account_id = NEW.account_id AND status = 'deleting'
         AND identity_issuer = NEW.identity_issuer
         AND identity_subject = NEW.identity_subject
     ) THEN
    RAISE EXCEPTION 'INVALID_DELETION_JOB' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_initial_deletion_job
BEFORE INSERT ON scryer.deletion_jobs
FOR EACH ROW EXECUTE FUNCTION scryer.check_initial_deletion_job();

-- Keep the database boundary nonresurrecting even if ordinary app-role SQL
-- bypasses the API/store helpers. Row locking orders a write against DELETE.
CREATE FUNCTION scryer.require_active_account_write()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, scryer AS $$
DECLARE
  lifecycle text;
BEGIN
  SELECT status INTO lifecycle FROM scryer.accounts
    WHERE account_id = NEW.account_id FOR SHARE;
  IF lifecycle IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_ACTIVE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'cases', 'case_revisions', 'staged_chunks', 'idempotency',
    'recovery_wrappers', 'devices', 'case_tombstones'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER require_active_account_write '
      || 'BEFORE INSERT OR UPDATE ON scryer.%I '
      || 'FOR EACH ROW EXECUTE FUNCTION scryer.require_active_account_write()',
      table_name);
  END LOOP;
END $$;
RESET ROLE;

REVOKE INSERT, UPDATE, DELETE ON scryer.accounts FROM scryer_app;
GRANT INSERT (account_id, identity_issuer, identity_subject)
  ON scryer.accounts TO scryer_app;
GRANT UPDATE (used_bytes, updated_at)
  ON scryer.accounts TO scryer_app;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scryer_worker') THEN
    CREATE ROLE scryer_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA scryer TO scryer_worker;
GRANT SELECT (account_id, status) ON scryer.accounts TO scryer_worker;
GRANT UPDATE (status, identity_issuer, identity_subject, updated_at)
  ON scryer.accounts TO scryer_worker;
GRANT SELECT, DELETE ON scryer.deletion_jobs TO scryer_worker;
GRANT UPDATE (state, attempts, next_attempt_at, lease_token, lease_until)
  ON scryer.deletion_jobs TO scryer_worker;

SET ROLE scryer_owner;
CREATE POLICY deletion_worker_read ON scryer.accounts FOR SELECT TO scryer_worker
  USING (status = 'deleting' OR
         (status = 'deleted' AND EXISTS (
           SELECT 1 FROM scryer.deletion_jobs
           WHERE deletion_jobs.account_id = accounts.account_id)));
CREATE POLICY deletion_worker_finalize ON scryer.accounts FOR UPDATE TO scryer_worker
  USING (status = 'deleting')
  WITH CHECK (status = 'deleted' AND identity_issuer IS NULL
              AND identity_subject IS NULL);
CREATE POLICY deletion_worker_jobs ON scryer.deletion_jobs FOR ALL TO scryer_worker
  USING (true) WITH CHECK (true);

-- The ordinary app role can invoke exactly this account transition, but
-- cannot directly change lifecycle fields or insert provider jobs. The
-- definer remains subject to FORCE RLS; these policies still require the
-- current transaction's signed tenant capability on every touched row.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'accounts', 'cases', 'case_revisions', 'staged_chunks', 'idempotency',
    'recovery_wrappers', 'devices', 'case_tombstones', 'deletion_jobs'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY deletion_owner_tenant ON scryer.%I FOR ALL TO scryer_owner '
      || 'USING (scryer_private.tenant_ok(account_id)) '
      || 'WITH CHECK (scryer_private.tenant_ok(account_id))', table_name);
  END LOOP;
END $$;

CREATE FUNCTION scryer.begin_account_deletion(
  p_account_id text, p_key text, p_digest text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, scryer, scryer_private AS $$
DECLARE
  account_row record;
  job_state text;
BEGIN
  IF NOT scryer_private.tenant_ok(p_account_id) THEN
    RAISE EXCEPTION 'INVALID_TENANT_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF p_key !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$' OR
     p_digest !~ '^[0-9a-f]{64}$' THEN
    RETURN 'invalid-request';
  END IF;
  SELECT status, deletion_key, deletion_digest
    INTO account_row FROM scryer.accounts
    WHERE account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;
  IF account_row.status = 'deleting' THEN
    IF account_row.deletion_key <> p_key OR account_row.deletion_digest <> p_digest THEN
      RETURN 'conflict';
    END IF;
    SELECT state INTO job_state FROM scryer.deletion_jobs
      WHERE account_id = p_account_id;
    IF job_state NOT IN ('pending', 'retry') OR job_state IS NULL THEN
      RETURN 'stalled';
    END IF;
    RETURN 'retry';
  END IF;
  IF account_row.status <> 'active' THEN
    RETURN 'disabled';
  END IF;
  IF EXISTS (SELECT 1 FROM scryer.idempotency
             WHERE account_id = p_account_id AND key = p_key) THEN
    RETURN 'key-conflict';
  END IF;

  UPDATE scryer.accounts SET status = 'deleting', deletion_key = p_key,
    deletion_digest = p_digest, used_bytes = 0,
    updated_at = clock_timestamp() WHERE account_id = p_account_id;
  DELETE FROM scryer.case_revisions WHERE account_id = p_account_id;
  DELETE FROM scryer.cases WHERE account_id = p_account_id;
  DELETE FROM scryer.staged_chunks WHERE account_id = p_account_id;
  DELETE FROM scryer.idempotency WHERE account_id = p_account_id;
  DELETE FROM scryer.recovery_wrappers WHERE account_id = p_account_id;
  DELETE FROM scryer.devices WHERE account_id = p_account_id;
  DELETE FROM scryer.case_tombstones WHERE account_id = p_account_id;
  INSERT INTO scryer.deletion_jobs
    (account_id, identity_issuer, identity_subject, state)
    SELECT account_id, identity_issuer, identity_subject, 'pending'
    FROM scryer.accounts WHERE account_id = p_account_id;
  RETURN 'created';
END $$;
REVOKE ALL ON FUNCTION scryer.begin_account_deletion(text, text, text) FROM PUBLIC;
RESET ROLE;
GRANT EXECUTE ON FUNCTION scryer.begin_account_deletion(text, text, text)
  TO scryer_app;
