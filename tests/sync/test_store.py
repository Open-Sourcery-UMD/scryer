"""Atomic ciphertext-store behavior against a disposable PostgreSQL database."""

import base64
from concurrent.futures import ThreadPoolExecutor
import getpass
import hashlib
import json
import os
from pathlib import Path
import secrets
import unittest

import psycopg

from _db_harness import APP, app_connect, ensure_test_app_role
from sync.db_context import begin_tenant_transaction
from sync.migrate import apply_migrations
from sync.store import (StoreError, stage_chunk, commit_manifest, get_head,
                        delete_case, get_recovery_envelope, put_recovery_envelope)
from test_recovery import wrapper


MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"
SOCKET = os.environ.get("SCRYER_TEST_PG_SOCKET")
ADMIN = os.environ.get("SCRYER_TEST_PG_ADMIN", getpass.getuser())
QUOTA = 256 * 1024 * 1024
PACKAGE = "EBESExQVFhcYGRobHB0eHw"
DEVICE = "AAECAwQFBgcICQoLDA0ODw"


def wire(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def b64(value):
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def prepared(case_id="case-one", revision_id="rev-one", content=b"encrypted",
             package_id=PACKAGE, account_id="acct-a"):
    chunk = {
        "schemaVersion": "1", "kind": "chunk", "accountId": account_id,
        "caseId": case_id, "revisionId": revision_id, "packageId": package_id,
        "index": 0, "chunkCount": 1, "nonce": b64(bytes(12)),
        "ciphertext": b64(content), "tag": b64(bytes(16)),
    }
    package = {
        "schemaVersion": "1", "format": "scryer-case-v1",
        "algorithm": "AES-256-GCM+HKDF-SHA-256", "accountId": account_id,
        "caseId": case_id, "revisionId": revision_id, "deviceId": DEVICE,
        "keyGeneration": 1, "packageId": package_id,
        "chunks": [{key: chunk[key] for key in ("index", "nonce", "ciphertext", "tag")}],
    }
    manifest = {
        "schemaVersion": "1", "kind": "manifest", "format": "scryer-case-v1",
        "algorithm": "AES-256-GCM+HKDF-SHA-256", "accountId": account_id,
        "caseId": case_id, "revisionId": revision_id, "deviceId": DEVICE,
        "keyGeneration": 1, "packageId": package_id, "chunkCount": 1,
        "chunkDigests": [hashlib.sha256(wire(chunk)).hexdigest()],
        "packageDigest": hashlib.sha256(wire(package)).hexdigest(),
    }
    return wire(chunk), wire(manifest), wire(package)


class StoreTests(unittest.TestCase):
    def setUp(self):
        if not SOCKET:
            raise RuntimeError("BLOCKED_TOOLING: SCRYER_TEST_PG_SOCKET is required")
        self.dbname = "scryer_store_" + secrets.token_hex(5)
        self.key = secrets.token_bytes(32)
        with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                             autocommit=True) as admin:
            admin.execute(f'CREATE DATABASE "{self.dbname}"')
        with self.admin() as admin:
            apply_migrations(admin, MIGRATIONS)
            admin.execute("INSERT INTO scryer_private.tenant_key(singleton, secret) "
                          "VALUES (true, %s)", (self.key,))
            admin.execute("INSERT INTO scryer.accounts "
                          "(account_id, identity_issuer, identity_subject) VALUES "
                          "('acct-a', 'https://issuer.invalid', 'subject-a'), "
                          "('acct-b', 'https://issuer.invalid', 'subject-b')")
        with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                             autocommit=True) as admin:
            ensure_test_app_role(admin)

    def tearDown(self):
        with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                             autocommit=True) as admin:
            admin.execute(f'DROP DATABASE "{self.dbname}" WITH (FORCE)')

    def admin(self):
        return psycopg.connect(host=SOCKET, dbname=self.dbname, user=ADMIN)

    def run_as(self, fn, account_id="acct-a"):
        with app_connect(SOCKET, self.dbname) as app:
            with app.transaction():
                begin_tenant_transaction(app, account_id, self.key)
                return fn(app)

    def stage(self, body, key="op-one:chunk:0"):
        return self.run_as(lambda app: stage_chunk(app, "acct-a", key, body))

    def commit(self, body, precondition="*", key="op-one:manifest"):
        return self.run_as(lambda app: commit_manifest(app, "acct-a", key, body, precondition))

    def head(self, case_id="case-one"):
        return self.run_as(lambda app: get_head(app, "acct-a", case_id))

    def assert_code(self, code, fn, *args):
        with self.assertRaises(StoreError) as caught:
            fn(*args)
        self.assertEqual(caught.exception.code, code)

    def test_lost_response_replay_keeps_one_revision_and_exact_ciphertext(self):
        chunk, manifest, package = prepared()
        first_stage = self.stage(chunk)
        self.assertEqual(self.stage(chunk), first_stage)
        first_commit = self.commit(manifest)
        self.assertEqual(self.commit(manifest), first_commit)
        self.assertEqual(first_commit["revisionId"], "rev-one")
        self.assertEqual(self.head().revision_id, "rev-one")
        self.assertEqual(self.head().ciphertext, package)
        with self.admin() as admin:
            revision = admin.execute("SELECT ciphertext FROM scryer.case_revisions").fetchall()
            self.assertEqual(revision, [(package,)])
            self.assertEqual(admin.execute("SELECT count(*) FROM scryer.staged_chunks").fetchone()[0], 0)
            self.assertEqual(admin.execute("SELECT used_bytes FROM scryer.accounts "
                                           "WHERE account_id='acct-a'").fetchone()[0], len(package))

    def test_expired_staging_can_be_retried_with_the_same_saved_key(self):
        chunk, manifest, _ = prepared()
        self.stage(chunk)
        with self.admin() as admin:
            admin.execute("UPDATE scryer.staged_chunks SET expires_at=now()-interval '1 second'")
        self.stage(chunk)
        with self.admin() as admin:
            self.assertEqual(admin.execute("SELECT count(*) FROM scryer.staged_chunks").fetchone()[0], 1)
            self.assertEqual(admin.execute("SELECT used_bytes FROM scryer.accounts "
                                           "WHERE account_id='acct-a'").fetchone()[0], len(chunk))
        self.assertEqual(self.commit(manifest)["revisionId"], "rev-one")

    def test_idempotency_key_with_changed_bytes_or_precondition_conflicts(self):
        chunk, manifest, _ = prepared()
        self.stage(chunk)
        changed, _, _ = prepared(content=b"different")
        self.assert_code("IDEMPOTENCY_CONFLICT", self.stage, changed)
        self.commit(manifest)
        self.assert_code("IDEMPOTENCY_CONFLICT", self.commit, manifest, '"rev-other"')

    def test_concurrent_same_key_manifest_retries_publish_once(self):
        chunk, manifest, _ = prepared()
        self.stage(chunk)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _index: self.commit(manifest), range(2)))
        self.assertEqual(results[0], results[1])
        with self.admin() as admin:
            self.assertEqual(admin.execute("SELECT count(*) FROM scryer.case_revisions").fetchone()[0], 1)

    def test_case_sort_timestamp_reflects_publication_after_transaction_start(self):
        early_chunk, early_manifest, _ = prepared(case_id="case-early")
        late_chunk, late_manifest, _ = prepared(case_id="case-late")
        self.stage(early_chunk, "sort:early:chunk")
        self.stage(late_chunk, "sort:late:chunk")
        with app_connect(SOCKET, self.dbname) as stale:
            with stale.transaction():
                begin_tenant_transaction(stale, "acct-a", self.key)
                stale.execute("SELECT now()")
                self.commit(early_manifest, "*", "sort:early:manifest")
                stale.execute("SELECT pg_sleep(0.01)")
                commit_manifest(stale, "acct-a", "sort:late:manifest", late_manifest, "*")
        with self.admin() as admin:
            rows = admin.execute("SELECT case_id, updated_at FROM scryer.cases "
                                 "WHERE account_id='acct-a'").fetchall()
        updated = dict(rows)
        self.assertGreater(updated["case-late"], updated["case-early"])

    def test_recovery_wrapper_cas_retry_and_tenant_boundary(self):
        first = wrapper()
        changed = wrapper(nonce_seed=1)
        put = lambda key, raw, precondition: self.run_as(lambda app:
            put_recovery_envelope(app, "acct-a", key, raw, precondition))
        get = lambda: self.run_as(lambda app: get_recovery_envelope(app, "acct-a"))
        self.assertIsNone(get())
        created = put("recovery:create", first, "*")
        self.assertEqual(created["generation"], 1)
        self.assertEqual(created["etag"], '"1"')
        self.assertEqual(get().body, first)
        self.assertEqual(get().generation, 1)
        self.assertEqual(put("recovery:create", first, "*"), created)
        self.assertIsNone(self.run_as(lambda app: get_recovery_envelope(app, "acct-b"),
                                      account_id="acct-b"))
        self.assert_code("WRONG_ACCOUNT", put, "recovery:wrong", wrapper("acct-b"), "*")
        self.assert_code("IDEMPOTENCY_CONFLICT", put, "recovery:create", changed, "*")
        self.assert_code("PRECONDITION_REQUIRED", put, "recovery:none", changed, None)
        self.assert_code("STALE_RECOVERY_ENVELOPE", put, "recovery:stale", changed, '"2"')
        self.assert_code("RECOVERY_ROTATION_UNSUPPORTED", put, "recovery:update",
                         changed, '"1"')
        self.assertEqual(get().body, first)
        self.assertEqual(put("recovery:create", first, "*"), created)
        with self.admin() as admin:
            self.assertEqual(admin.execute("SELECT count(*) FROM scryer.recovery_wrappers")
                             .fetchone()[0], 1)
            admin.execute("UPDATE scryer.recovery_wrappers SET generation=2, wrapper=%s, "
                          "wrapper_digest=%s WHERE account_id='acct-a'",
                          (changed, hashlib.sha256(changed).hexdigest()))
        self.assert_code("STALE_RECOVERY_ENVELOPE", put, "recovery:create", first, "*")
        self.assertEqual(get().body, changed)
        with self.admin() as admin:
            admin.execute("UPDATE scryer.recovery_wrappers SET wrapper=%s "
                          "WHERE account_id='acct-a'", (b"corrupt",))
        self.assert_code("CORRUPT_RECORD", get)
        with self.admin() as admin:
            admin.execute("UPDATE scryer.recovery_wrappers SET wrapper_digest=%s "
                          "WHERE account_id='acct-a'", (hashlib.sha256(b"corrupt").hexdigest(),))
        self.assert_code("CORRUPT_RECORD", get)

    def test_stale_and_absent_head_preconditions_preserve_head(self):
        chunk, manifest, _ = prepared()
        self.stage(chunk)
        self.commit(manifest)
        second_chunk, second_manifest, _ = prepared(revision_id="rev-two")
        self.stage(second_chunk, "op-two:chunk:0")
        self.assert_code("STALE_REVISION", self.commit, second_manifest,
                         '"rev-wrong"', "op-two:manifest")
        self.assert_code("STALE_REVISION", self.commit, second_manifest,
                         "*", "op-two:manifest")
        self.assertEqual(self.head().revision_id, "rev-one")
        updated = self.commit(second_manifest, '"rev-one"', "op-two:manifest")
        self.assertEqual(updated["revisionId"], "rev-two")

    def test_two_distinct_updates_from_one_head_preserve_the_losing_branch(self):
        base_chunk, base_manifest, _ = prepared()
        self.stage(base_chunk)
        self.commit(base_manifest)
        left_chunk, left_manifest, _ = prepared(revision_id="rev-left", content=b"left")
        right_chunk, right_manifest, _ = prepared(revision_id="rev-right", content=b"right")
        self.stage(left_chunk, "op-left:chunk:0")
        self.stage(right_chunk, "op-right:chunk:0")
        def attempt(item):
            body, key = item
            try:
                return self.commit(body, '"rev-one"', key)["revisionId"]
            except StoreError as error:
                return error.code
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, [(left_manifest, "op-left:manifest"),
                                              (right_manifest, "op-right:manifest")]))
        self.assertIn("STALE_REVISION", results)
        winner = next(value for value in results if value != "STALE_REVISION")
        self.assertEqual(self.head().revision_id, winner)
        with self.admin() as admin:
            self.assertEqual(admin.execute("SELECT count(*) FROM scryer.staged_chunks").fetchone()[0], 1)

    def test_delete_and_update_race_has_one_linearized_winner(self):
        base_chunk, base_manifest, _ = prepared()
        self.stage(base_chunk)
        self.commit(base_manifest)
        next_chunk, next_manifest, _ = prepared(revision_id="rev-next")
        self.stage(next_chunk, "op-next:chunk:0")
        def update():
            try:
                return ("update", self.commit(next_manifest, '"rev-one"', "op-next:manifest"))
            except StoreError as error:
                return ("update_error", error.code)
        def delete():
            try:
                return ("delete", self.run_as(lambda app: delete_case(
                    app, "acct-a", "case-one", '"rev-one"', "op-delete")))
            except StoreError as error:
                return ("delete_error", error.code)
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = [future.result() for future in (pool.submit(update), pool.submit(delete))]
        kinds = {kind for kind, _ in outcomes}
        self.assertEqual(len(kinds & {"update", "delete"}), 1)
        if "delete" in kinds:
            self.assertIn(("update_error", "CASE_DELETED"), outcomes)
            self.assertIsNone(self.head())
        else:
            self.assertIn(("delete_error", "STALE_REVISION"), outcomes)
            self.assertEqual(self.head().revision_id, "rev-next")

    def test_missing_or_changed_staged_chunk_cannot_publish(self):
        chunk, manifest, _ = prepared()
        self.assert_code("MISSING_CHUNK", self.commit, manifest)
        self.assertIsNone(self.head())
        self.stage(chunk)
        with self.admin() as admin:
            admin.execute("UPDATE scryer.staged_chunks SET body=%s", (b"{}",))
        self.assert_code("INVALID_WIRE", self.commit, manifest)
        self.assertIsNone(self.head())

    def test_corrupt_published_ciphertext_is_not_served_as_a_valid_head(self):
        chunk, manifest, _ = prepared()
        self.stage(chunk)
        self.commit(manifest)
        with self.admin() as admin:
            admin.execute("UPDATE scryer.case_revisions SET ciphertext=%s", (b"broken",))
        self.assert_code("CORRUPT_RECORD", self.head)

    def test_quota_lock_allows_only_one_of_two_concurrent_stages(self):
        first, _, _ = prepared(revision_id="rev-one")
        second, _, _ = prepared(revision_id="rev-two", content=b"other")
        with self.admin() as admin:
            admin.execute("UPDATE scryer.accounts SET used_bytes=%s "
                          "WHERE account_id='acct-a'", (QUOTA - max(len(first), len(second)),))
        def attempt(item):
            body, key = item
            try:
                self.stage(body, key)
                return "staged"
            except StoreError as error:
                return error.code
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, [(first, "op-one:chunk:0"),
                                              (second, "op-two:chunk:0")]))
        self.assertEqual(sorted(results), ["QUOTA_EXCEEDED", "staged"])

    def test_delete_frees_ciphertext_and_old_retry_cannot_resurrect(self):
        chunk, manifest, _ = prepared()
        self.stage(chunk)
        self.commit(manifest)
        deleted = self.run_as(lambda app: delete_case(app, "acct-a", "case-one",
                                                      '"rev-one"', "op-delete"))
        self.assertTrue(deleted["tombstone"])
        self.assertEqual(self.run_as(lambda app: delete_case(app, "acct-a", "case-one",
                                                            '"rev-one"', "op-delete")), deleted)
        self.assertIsNone(self.head())
        self.assert_code("CASE_DELETED", self.commit, manifest)
        self.assert_code("CASE_DELETED", self.stage, chunk)
        with self.admin() as admin:
            self.assertEqual(admin.execute("SELECT count(*) FROM scryer.case_revisions").fetchone()[0], 0)
            self.assertEqual(admin.execute("SELECT used_bytes FROM scryer.accounts "
                                           "WHERE account_id='acct-a'").fetchone()[0], 0)

    def test_disabled_account_rejects_cached_success_and_new_write(self):
        chunk, manifest, _ = prepared()
        self.stage(chunk)
        self.commit(manifest)
        with self.admin() as admin:
            admin.execute("UPDATE scryer.accounts SET status='disabled' "
                          "WHERE account_id='acct-a'")
        self.assert_code("ACCOUNT_DISABLED", self.commit, manifest)
        self.assert_code("ACCOUNT_DISABLED", self.stage, chunk)

    def test_second_account_cannot_read_or_stage_first_account_package(self):
        chunk, manifest, _ = prepared()
        self.stage(chunk)
        self.commit(manifest)
        self.assertIsNone(self.run_as(lambda app: get_head(app, "acct-b", "case-one"), "acct-b"))
        self.assert_code("WRONG_ACCOUNT", self.run_as,
                         lambda app: stage_chunk(app, "acct-b", "other:chunk:0", chunk), "acct-b")


if __name__ == "__main__":
    unittest.main()
