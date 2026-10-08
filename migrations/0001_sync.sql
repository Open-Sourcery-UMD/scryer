-- Scryer ciphertext sync schema v1. Apply to a fresh database as an
-- administrative/migration identity; never as the ordinary application role.
-- This file is immutable after a deployed application records its checksum.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scryer_owner') THEN
    CREATE ROLE scryer_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scryer_security') THEN
    CREATE ROLE scryer_security NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scryer_app') THEN
    CREATE ROLE scryer_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

CREATE SCHEMA scryer AUTHORIZATION scryer_owner;
CREATE SCHEMA scryer_private AUTHORIZATION scryer_security;
REVOKE ALL ON SCHEMA scryer_private FROM PUBLIC;
CREATE EXTENSION pgcrypto WITH SCHEMA scryer_private;

SET ROLE scryer_security;
CREATE TABLE scryer_private.tenant_key (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  secret bytea NOT NULL CHECK (octet_length(secret) = 32)
);
REVOKE ALL ON scryer_private.tenant_key FROM PUBLIC;

CREATE FUNCTION scryer_private.tenant_ok(expected_account text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, scryer_private AS $$
DECLARE
  account_setting text := current_setting('scryer.account_id', true);
  tx_setting text := current_setting('scryer.txid', true);
  sig_setting text := current_setting('scryer.signature', true);
  signing_key bytea;
  expected_sig text;
BEGIN
  IF expected_account IS NULL OR account_setting IS NULL OR
     tx_setting IS NULL OR sig_setting IS NULL OR
     expected_account <> account_setting OR
     tx_setting <> txid_current()::text OR
     sig_setting !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;
  SELECT secret INTO signing_key FROM scryer_private.tenant_key WHERE singleton = true;
  IF signing_key IS NULL THEN
    RETURN false;
  END IF;
  expected_sig := encode(scryer_private.hmac(
    convert_to(account_setting || chr(10) || tx_setting, 'UTF8'),
    signing_key, 'sha256'), 'hex');
  RETURN sig_setting = expected_sig;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION scryer_private.tenant_ok(text) FROM PUBLIC;
RESET ROLE;

GRANT USAGE ON SCHEMA scryer_private TO scryer_owner, scryer_app;
GRANT EXECUTE ON FUNCTION scryer_private.tenant_ok(text) TO scryer_owner, scryer_app;

SET ROLE scryer_owner;
CREATE TABLE scryer.accounts (
  account_id text PRIMARY KEY CHECK (account_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  identity_issuer text NOT NULL CHECK (length(identity_issuer) BETWEEN 1 AND 256),
  identity_subject text NOT NULL CHECK (length(identity_subject) BETWEEN 1 AND 256),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleting', 'deleted')),
  used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0 AND used_bytes <= 268435456),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scryer.cases (
  account_id text NOT NULL REFERENCES scryer.accounts(account_id) ON DELETE CASCADE,
  case_id text NOT NULL CHECK (case_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  head_revision text CHECK (head_revision ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, case_id)
);

CREATE TABLE scryer.case_revisions (
  account_id text NOT NULL,
  case_id text NOT NULL,
  revision_id text NOT NULL CHECK (revision_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  parent_revision text CHECK (parent_revision ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 12582912),
  package_digest text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
  decoded_bytes bigint NOT NULL CHECK (decoded_bytes BETWEEN 1 AND 8388608),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, case_id, revision_id),
  FOREIGN KEY (account_id, case_id) REFERENCES scryer.cases(account_id, case_id) ON DELETE CASCADE
);
CREATE INDEX case_revisions_history ON scryer.case_revisions(account_id, case_id, created_at, revision_id);

CREATE TABLE scryer.staged_chunks (
  account_id text NOT NULL REFERENCES scryer.accounts(account_id) ON DELETE CASCADE,
  case_id text NOT NULL CHECK (case_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  revision_id text NOT NULL CHECK (revision_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  package_id text NOT NULL CHECK (length(package_id) = 22),
  chunk_index integer NOT NULL CHECK (chunk_index BETWEEN 0 AND 7),
  body bytea NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 8388608),
  body_digest text NOT NULL CHECK (body_digest ~ '^[0-9a-f]{64}$'),
  decoded_bytes bigint NOT NULL CHECK (decoded_bytes BETWEEN 1 AND 4194304),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (account_id, case_id, revision_id, package_id, chunk_index)
);
CREATE INDEX staged_chunks_expiry ON scryer.staged_chunks(expires_at);

CREATE TABLE scryer.idempotency (
  account_id text NOT NULL REFERENCES scryer.accounts(account_id) ON DELETE CASCADE,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 160),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  operation text NOT NULL CHECK (operation IN ('chunk', 'manifest', 'delete', 'recovery', 'device')),
  case_id text CHECK (case_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  response bytea NOT NULL CHECK (octet_length(response) BETWEEN 1 AND 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  PRIMARY KEY (account_id, key)
);
CREATE INDEX idempotency_expiry ON scryer.idempotency(expires_at);

CREATE TABLE scryer.recovery_wrappers (
  account_id text PRIMARY KEY REFERENCES scryer.accounts(account_id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 2147483647),
  wrapper bytea NOT NULL CHECK (octet_length(wrapper) BETWEEN 1 AND 4096),
  wrapper_digest text NOT NULL CHECK (wrapper_digest ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scryer.devices (
  account_id text NOT NULL REFERENCES scryer.accounts(account_id) ON DELETE CASCADE,
  device_id text NOT NULL CHECK (length(device_id) = 22),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (account_id, device_id)
);

CREATE TABLE scryer.case_tombstones (
  account_id text NOT NULL REFERENCES scryer.accounts(account_id) ON DELETE CASCADE,
  case_id text NOT NULL CHECK (case_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  deleted_head text NOT NULL CHECK (deleted_head ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, case_id)
);

CREATE TABLE scryer.deletion_jobs (
  account_id text PRIMARY KEY CHECK (account_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  identity_issuer text NOT NULL CHECK (length(identity_issuer) BETWEEN 1 AND 256),
  identity_subject text NOT NULL CHECK (length(identity_subject) BETWEEN 1 AND 256),
  state text NOT NULL CHECK (state IN ('pending', 'retry', 'failed', 'complete')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'accounts', 'cases', 'case_revisions', 'staged_chunks', 'idempotency',
    'recovery_wrappers', 'devices', 'case_tombstones', 'deletion_jobs'
  ] LOOP
    EXECUTE format('ALTER TABLE scryer.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE scryer.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_boundary ON scryer.%I FOR ALL TO scryer_app '
      || 'USING (scryer_private.tenant_ok(account_id)) '
      || 'WITH CHECK (scryer_private.tenant_ok(account_id))', table_name);
  END LOOP;
END $$;
RESET ROLE;

GRANT USAGE ON SCHEMA scryer TO scryer_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA scryer TO scryer_app;
REVOKE ALL ON scryer.deletion_jobs FROM scryer_app;
