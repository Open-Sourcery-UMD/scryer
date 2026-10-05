"""Account deletion uses a disposable database and synthetic unit identity."""

import getpass
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import secrets
from threading import Event
import time
import unittest

from fastapi.testclient import TestClient
import psycopg

from _db_harness import (APP, app_connect, ensure_test_app_role,
                         ensure_test_worker_role, worker_connect)
from sync.api import create_sync_app
from sync.auth import derive_account_id
from sync.db_context import begin_tenant_transaction
from sync.migrate import apply_migrations
from test_api import AUDIENCE, FixtureVerifier, ISSUER
from test_store import DEVICE, prepared, wire
from test_recovery import wrapper


SOCKET = os.environ.get("SCRYER_TEST_PG_SOCKET")
ADMIN = os.environ.get("SCRYER_TEST_PG_ADMIN", getpass.getuser())
MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


class AccountDeletionTests(unittest.TestCase):
    def setUp(self):
        if not SOCKET:
            raise RuntimeError("BLOCKED_TOOLING: SCRYER_TEST_PG_SOCKET is required")
        self.context_key = secrets.token_bytes(32)
        self.account_key = secrets.token_bytes(32)
        self.dbname = "scryer_deletion_" + secrets.token_hex(5)
        with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                             autocommit=True) as admin:
            admin.execute(f'CREATE DATABASE "{self.dbname}"')
        with self.admin() as admin:
            apply_migrations(admin, MIGRATIONS)
            admin.execute("INSERT INTO scryer_private.tenant_key(singleton, secret) "
                          "VALUES (true, %s)", (self.context_key,))
            ensure_test_app_role(admin)
        self.client = TestClient(create_sync_app(
            connect=lambda: app_connect(SOCKET, self.dbname),
            verifier=FixtureVerifier(), context_key=self.context_key,
            account_key=self.account_key, issuer=ISSUER, audience=AUDIENCE,
            allowed_origins=("http://127.0.0.1:39000",)))
        self.client.__enter__()
        self.account_id = derive_account_id(ISSUER, "subject-one", self.account_key)

    def tearDown(self):
        if hasattr(self, "client"):
            self.client.__exit__(None, None, None)
        if hasattr(self, "dbname"):
            with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                                 autocommit=True) as admin:
                admin.execute(f'DROP DATABASE "{self.dbname}" WITH (FORCE)')

    def admin(self):
        return psycopg.connect(host=SOCKET, dbname=self.dbname, user=ADMIN)

    def request(self, method, path, token="one", **kwargs):
        headers = kwargs.pop("headers", {})
        headers["Authorization"] = f"Bearer {token}"
        return self.client.request(method, path, headers=headers, **kwargs)

    def deletion_headers(self, key="delete-account-one", account_id=None):
        return {"Idempotency-Key": key,
                "X-Confirm-Account-ID": account_id or self.account_id}

    def test_deletion_wipes_live_rows_and_denies_old_token(self):
        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        self.assertEqual(self.request("POST", "/v1/account/devices",
            content=wire({"schemaVersion": "1", "deviceId": DEVICE}),
            headers={"Content-Type": "application/json",
                     "Idempotency-Key": f"device:{DEVICE}"}).status_code, 200)
        chunk, manifest, _ = prepared(case_id="case-delete-account",
                                      account_id=self.account_id)
        self.assertEqual(self.request("POST", "/v1/cases/case-delete-account/chunks",
            content=chunk, headers={"Content-Type": "application/json",
                                    "Idempotency-Key": "deletion-chunk"}).status_code, 202)
        self.assertEqual(self.request("POST", "/v1/cases/case-delete-account/revisions",
            content=manifest, headers={"Content-Type": "application/json",
                                       "Idempotency-Key": "deletion-manifest",
                                       "If-None-Match": "*"}).status_code, 201)
        staged, _, _ = prepared(case_id="case-staged", account_id=self.account_id)
        self.assertEqual(self.request("POST", "/v1/cases/case-staged/chunks",
            content=staged, headers={"Content-Type": "application/json",
                                     "Idempotency-Key": "deletion-staged"}).status_code, 202)
        self.assertEqual(self.request("PUT", "/v1/account/recovery-envelope",
            content=wrapper(self.account_id), headers={"Content-Type": "application/json",
                "Idempotency-Key": "deletion-recovery", "If-None-Match": "*"}).status_code, 200)
        with self.admin() as admin:
            admin.execute("INSERT INTO scryer.case_tombstones(account_id,case_id,deleted_head) "
                          "VALUES (%s,'case-old','rev-old')", (self.account_id,))
            self.assertEqual(admin.execute("SELECT count(*) FROM scryer.staged_chunks "
                                           "WHERE account_id=%s", (self.account_id,))
                             .fetchone()[0], 1)
            self.assertEqual(admin.execute("SELECT count(*) FROM scryer.recovery_wrappers "
                                           "WHERE account_id=%s", (self.account_id,))
                             .fetchone()[0], 1)
        response = self.request("DELETE", "/v1/account", headers=self.deletion_headers())
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json(), {"kind": "account-deletion",
                                           "accountId": self.account_id,
                                           "status": "deleting"})
        with self.admin() as admin:
            row = admin.execute("SELECT status,used_bytes FROM scryer.accounts "
                                "WHERE account_id=%s", (self.account_id,)).fetchone()
            self.assertEqual(row, ("deleting", 0))
            for table in ("cases", "case_revisions", "staged_chunks", "idempotency",
                          "recovery_wrappers", "devices", "case_tombstones"):
                self.assertEqual(admin.execute(f"SELECT count(*) FROM scryer.{table} "
                                               "WHERE account_id=%s", (self.account_id,))
                                 .fetchone()[0], 0, table)
            self.assertEqual(admin.execute("SELECT state,attempts FROM scryer.deletion_jobs "
                                           "WHERE account_id=%s", (self.account_id,))
                             .fetchone(), ("pending", 0))
        denied = self.request("GET", "/v1/account")
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(denied.json()["error"]["code"], "ACCOUNT_DISABLED")
        self.assertEqual(self.request("POST", "/v1/cases/case-delete-account/chunks",
            content=chunk, headers={"Content-Type": "application/json",
                                    "Idempotency-Key": "deletion-chunk"}).status_code, 403)
        self.assertEqual(self.request("DELETE", "/v1/account",
            headers=self.deletion_headers()).status_code, 202)

    def test_worker_removes_provider_identity_and_preserves_anonymous_tombstone(self):
        from sync.deletion_worker import run_once

        with self.admin() as admin:
            ensure_test_worker_role(admin)

        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        self.assertEqual(self.request("DELETE", "/v1/account",
            headers=self.deletion_headers()).status_code, 202)
        remote_users = {(ISSUER, "subject-one")}

        class Provider:
            max_duration_seconds = 10

            def delete_user(self, issuer, subject):
                remote_users.remove((issuer, subject))

        self.assertEqual(run_once(lambda: worker_connect(SOCKET, self.dbname),
                                  Provider()), "complete")
        self.assertEqual(remote_users, set())
        with self.admin() as admin:
            self.assertEqual(admin.execute("SELECT status,identity_issuer,identity_subject "
                                           "FROM scryer.accounts WHERE account_id=%s",
                                           (self.account_id,)).fetchone(),
                             ("deleted", None, None))
            self.assertEqual(admin.execute("SELECT count(*) FROM scryer.deletion_jobs "
                                           "WHERE account_id=%s", (self.account_id,))
                             .fetchone()[0], 0)
        self.assertEqual(self.request("GET", "/v1/account").status_code, 403)
        self.assertEqual(self.request("DELETE", "/v1/account",
            headers=self.deletion_headers()).status_code, 403)

    def test_app_sql_role_cannot_bypass_provider_deletion_job(self):
        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        attempts = (
            ("DELETE FROM scryer.accounts WHERE account_id=%s", (self.account_id,)),
            ("UPDATE scryer.accounts SET identity_subject='forged' "
             "WHERE account_id=%s", (self.account_id,)),
            ("UPDATE scryer.accounts SET status='deleting', deletion_key='forged', "
             "deletion_digest=%s WHERE account_id=%s", ("0" * 64, self.account_id)),
        )
        for query, params in attempts:
            with self.subTest(query=query), app_connect(SOCKET, self.dbname) as app:
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    with app.transaction():
                        begin_tenant_transaction(app, self.account_id, self.context_key)
                        app.execute(query, params)
                        self.fail("app SQL role unexpectedly bypassed deletion boundary")
        with self.admin() as admin:
            self.assertEqual(admin.execute("SELECT status,identity_subject FROM scryer.accounts "
                                           "WHERE account_id=%s", (self.account_id,))
                             .fetchone(), ("active", "subject-one"))

    def test_app_sql_role_cannot_create_a_forged_deleting_account(self):
        with app_connect(SOCKET, self.dbname) as app:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                with app.transaction():
                    begin_tenant_transaction(app, "orphan-account", self.context_key)
                    app.execute("INSERT INTO scryer.accounts "
                                "(account_id,identity_issuer,identity_subject,status,"
                                "deletion_key,deletion_digest) "
                                "VALUES ('orphan-account',%s,%s,'deleting','forged',%s)",
                                (ISSUER, "orphan-subject", "0" * 64))
                    self.fail("app SQL created a deleting account without a provider job")

    def test_deleting_account_cannot_be_reactivated_with_signed_app_context(self):
        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        self.assertEqual(self.request("DELETE", "/v1/account",
            headers=self.deletion_headers()).status_code, 202)
        with app_connect(SOCKET, self.dbname) as app:
            with self.assertRaises((psycopg.errors.CheckViolation,
                                    psycopg.errors.InsufficientPrivilege)):
                with app.transaction():
                    begin_tenant_transaction(app, self.account_id, self.context_key)
                    app.execute("UPDATE scryer.accounts SET status='active', "
                                "deletion_key=NULL, deletion_digest=NULL "
                                "WHERE account_id=%s", (self.account_id,))
                    self.fail("deleting account was reactivated")
        self.assertEqual(self.request("GET", "/v1/account").status_code, 403)

    def test_signed_app_sql_cannot_recreate_data_after_account_deletion(self):
        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        self.assertEqual(self.request("DELETE", "/v1/account",
            headers=self.deletion_headers()).status_code, 202)
        attempts = (
            ("INSERT INTO scryer.staged_chunks "
             "(account_id,case_id,revision_id,package_id,chunk_index,body,"
             "body_digest,decoded_bytes) "
             "VALUES (%s,'case-reborn','rev-reborn','AAECAwQFBgcICQoLDA0ODw',0,%s,%s,1)",
             (self.account_id, b"x", "0" * 64)),
            ("INSERT INTO scryer.recovery_wrappers "
             "(account_id,generation,wrapper,wrapper_digest) VALUES (%s,1,%s,%s)",
             (self.account_id, b"x", "0" * 64)),
            ("UPDATE scryer.accounts SET used_bytes=1 WHERE account_id=%s",
             (self.account_id,)),
        )
        for query, params in attempts:
            with self.subTest(query=query), app_connect(SOCKET, self.dbname) as app:
                with self.assertRaises(psycopg.errors.CheckViolation):
                    with app.transaction():
                        begin_tenant_transaction(app, self.account_id, self.context_key)
                        app.execute(query, params)
                        self.fail("deleting account accepted new data or quota")

    def test_deletion_key_cannot_reuse_existing_case_operation_key(self):
        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        chunk, _, _ = prepared(case_id="case-reused-key", account_id=self.account_id)
        self.assertEqual(self.request("POST", "/v1/cases/case-reused-key/chunks",
            content=chunk, headers={"Content-Type": "application/json",
                                    "Idempotency-Key": "reused-key"}).status_code, 202)
        refused = self.request("DELETE", "/v1/account",
                               headers=self.deletion_headers(key="reused-key"))
        self.assertEqual(refused.status_code, 409)
        self.assertEqual(refused.json()["error"]["code"], "IDEMPOTENCY_CONFLICT")
        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        with self.admin() as admin:
            self.assertEqual(admin.execute("SELECT count(*) FROM scryer.staged_chunks "
                                           "WHERE account_id=%s", (self.account_id,))
                             .fetchone()[0], 1)

    def test_confirmation_body_and_changed_retries_are_refused(self):
        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        self.assertEqual(self.request("DELETE", "/v1/account",
            headers={"Idempotency-Key": "delete-no-confirm"}).status_code, 428)
        self.assertEqual(self.request("DELETE", "/v1/account",
            headers=self.deletion_headers(account_id="wrong-account")).status_code, 412)
        self.assertEqual(self.request("DELETE", "/v1/account", content=b"force",
            headers=self.deletion_headers()).status_code, 400)
        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        self.assertEqual(self.request("DELETE", "/v1/account",
            headers=self.deletion_headers()).status_code, 202)
        changed = self.request("DELETE", "/v1/account",
                               headers=self.deletion_headers(key="different-deletion"))
        self.assertEqual(changed.status_code, 409)
        self.assertEqual(changed.json()["error"]["code"], "ACCOUNT_DELETION_CONFLICT")
        other = self.request("GET", "/v1/account", token="two")
        self.assertEqual(other.status_code, 200)
        self.assertNotEqual(other.json()["accountId"], self.account_id)
        openapi = self.client.get("/openapi.json").json()["paths"]["/v1/account"]["delete"]
        self.assertIn("202", openapi["responses"])
        self.assertEqual({item["name"] for item in openapi["parameters"]},
                         {"Idempotency-Key", "X-Confirm-Account-ID"})

    def test_provider_failure_retries_and_missing_user_finalizes(self):
        from sync.deletion_worker import ProviderNotFound, run_once

        with self.admin() as admin:
            ensure_test_worker_role(admin)
        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        self.assertEqual(self.request("DELETE", "/v1/account",
            headers=self.deletion_headers()).status_code, 202)
        remote_users = {(ISSUER, "subject-one")}

        class FlakyProvider:
            max_duration_seconds = 10
            calls = 0

            def delete_user(self, issuer, subject):
                self.calls += 1
                if self.calls == 1:
                    raise OSError("synthetic transient provider failure")
                if (issuer, subject) not in remote_users:
                    raise ProviderNotFound
                remote_users.remove((issuer, subject))

        provider = FlakyProvider()
        run = lambda: run_once(lambda: worker_connect(SOCKET, self.dbname), provider)
        self.assertEqual(run(), "retry")
        with self.admin() as admin:
            self.assertEqual(admin.execute("SELECT state,attempts,lease_token FROM "
                                           "scryer.deletion_jobs WHERE account_id=%s",
                                           (self.account_id,)).fetchone(),
                             ("retry", 1, None))
            admin.execute("UPDATE scryer.deletion_jobs SET next_attempt_at="
                          "clock_timestamp()-interval '1 second' WHERE account_id=%s",
                          (self.account_id,))
        self.assertEqual(run(), "complete")
        self.assertEqual(remote_users, set())
        self.assertEqual(run(), "idle")
        with self.admin() as admin:
            self.assertEqual(admin.execute("SELECT status,identity_issuer,identity_subject "
                                           "FROM scryer.accounts WHERE account_id=%s",
                                           (self.account_id,)).fetchone(),
                             ("deleted", None, None))

    def test_worker_crash_after_provider_success_can_reconcile(self):
        from sync.deletion_worker import ProviderNotFound, run_once

        with self.admin() as admin:
            ensure_test_worker_role(admin)
        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        self.assertEqual(self.request("DELETE", "/v1/account",
            headers=self.deletion_headers()).status_code, 202)
        with self.admin() as admin:
            admin.execute("UPDATE scryer.deletion_jobs SET attempts=19 "
                          "WHERE account_id=%s", (self.account_id,))
        remote_users = {(ISSUER, "subject-one")}

        class Crash(BaseException):
            pass

        class Provider:
            max_duration_seconds = 10

            def delete_user(self, issuer, subject):
                if (issuer, subject) not in remote_users:
                    raise ProviderNotFound
                remote_users.remove((issuer, subject))
                raise Crash

        run = lambda: run_once(lambda: worker_connect(SOCKET, self.dbname), Provider())
        with self.assertRaises(Crash):
            run()
        with self.admin() as admin:
            self.assertEqual(admin.execute("SELECT status FROM scryer.accounts "
                                           "WHERE account_id=%s", (self.account_id,))
                             .fetchone()[0], "deleting")
            admin.execute("UPDATE scryer.deletion_jobs SET lease_until="
                          "clock_timestamp()-interval '1 second' WHERE account_id=%s",
                          (self.account_id,))
        self.assertEqual(run(), "complete")
        self.assertEqual(self.request("GET", "/v1/account").status_code, 403)

    def test_worker_sql_role_cannot_read_ciphertext_or_all_account_identities(self):
        with self.admin() as admin:
            ensure_test_worker_role(admin)
        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        with worker_connect(SOCKET, self.dbname) as worker:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                worker.execute("SELECT * FROM scryer.case_revisions")
        with worker_connect(SOCKET, self.dbname) as worker:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                worker.execute("SELECT identity_subject FROM scryer.accounts")
        with worker_connect(SOCKET, self.dbname) as worker:
            self.assertEqual(worker.execute("SELECT count(*) FROM scryer.accounts")
                             .fetchone()[0], 0)
        with app_connect(SOCKET, self.dbname) as app:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                app.execute("SELECT identity_subject FROM scryer.deletion_jobs")

    def test_terminal_provider_failure_is_exposed_and_keeps_access_denied(self):
        from sync.deletion_worker import run_once

        with self.admin() as admin:
            ensure_test_worker_role(admin)
        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        self.assertEqual(self.request("DELETE", "/v1/account",
            headers=self.deletion_headers()).status_code, 202)
        with self.admin() as admin:
            admin.execute("UPDATE scryer.deletion_jobs SET attempts=19 "
                          "WHERE account_id=%s", (self.account_id,))

        class DownProvider:
            max_duration_seconds = 10

            def delete_user(self, issuer, subject):
                raise OSError("synthetic provider outage")

        run = lambda: run_once(lambda: worker_connect(SOCKET, self.dbname), DownProvider())
        self.assertEqual(run(), "failed")
        self.assertEqual(run(), "idle")
        retry = self.request("DELETE", "/v1/account",
                             headers=self.deletion_headers())
        self.assertEqual(retry.status_code, 503)
        self.assertEqual(retry.json()["error"]["code"], "ACCOUNT_DELETION_STALLED")
        self.assertEqual(self.request("GET", "/v1/account").status_code, 403)
        with self.admin() as admin:
            self.assertEqual(admin.execute("SELECT state,attempts FROM scryer.deletion_jobs "
                                           "WHERE account_id=%s", (self.account_id,))
                             .fetchone(), ("failed", 20))

    def test_two_workers_cannot_claim_the_same_live_lease(self):
        from sync.deletion_worker import run_once

        with self.admin() as admin:
            ensure_test_worker_role(admin)
        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        self.assertEqual(self.request("DELETE", "/v1/account",
            headers=self.deletion_headers()).status_code, 202)
        entered = Event()
        release = Event()

        class SlowProvider:
            max_duration_seconds = 10

            def delete_user(self, issuer, subject):
                entered.set()
                if not release.wait(5):
                    raise TimeoutError("synthetic provider timeout")

        run = lambda: run_once(lambda: worker_connect(SOCKET, self.dbname), SlowProvider())
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(run)
            try:
                self.assertTrue(entered.wait(3))
                self.assertEqual(pool.submit(run).result(timeout=3), "idle")
            finally:
                release.set()
            self.assertEqual(first.result(timeout=5), "complete")
        with self.admin() as admin:
            self.assertEqual(admin.execute("SELECT status FROM scryer.accounts "
                                           "WHERE account_id=%s", (self.account_id,))
                             .fetchone()[0], "deleted")

    def test_worker_refuses_provider_timeout_that_exceeds_lease_margin(self):
        from sync.deletion_worker import run_once

        with self.admin() as admin:
            ensure_test_worker_role(admin)
        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        self.assertEqual(self.request("DELETE", "/v1/account",
            headers=self.deletion_headers()).status_code, 202)

        class UnboundedProvider:
            max_duration_seconds = 120

            def delete_user(self, issuer, subject):
                self.fail("unbounded provider must never be called")

        with self.assertRaisesRegex(ValueError, "PROVIDER_TIMEOUT_REQUIRED"):
            run_once(lambda: worker_connect(SOCKET, self.dbname), UnboundedProvider())
        with self.admin() as admin:
            self.assertEqual(admin.execute("SELECT state,attempts,lease_token "
                                           "FROM scryer.deletion_jobs WHERE account_id=%s",
                                           (self.account_id,)).fetchone(),
                             ("pending", 0, None))

    def test_deletion_job_trigger_refuses_wrong_provider_identity(self):
        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        self.assertEqual(self.request("DELETE", "/v1/account",
            headers=self.deletion_headers()).status_code, 202)
        with self.admin() as admin:
            with self.assertRaises(psycopg.errors.CheckViolation):
                admin.execute("INSERT INTO scryer.deletion_jobs "
                              "(account_id,identity_issuer,identity_subject,state) "
                              "VALUES (%s,%s,%s,'pending')",
                              (self.account_id, ISSUER, "wrong-subject"))

    def test_write_racing_account_deletion_cannot_restore_ciphertext(self):
        self.assertEqual(self.request("GET", "/v1/account").status_code, 200)
        chunk, _, _ = prepared(case_id="case-racing", account_id=self.account_id)
        with self.admin() as blocker, psycopg.connect(
                host=SOCKET, dbname=self.dbname, user=ADMIN,
                autocommit=True) as monitor:
            blocker.execute("SELECT account_id FROM scryer.accounts "
                            "WHERE account_id=%s FOR UPDATE", (self.account_id,))
            with ThreadPoolExecutor(max_workers=2) as pool:
                try:
                    deletion = pool.submit(self.request, "DELETE", "/v1/account",
                                           headers=self.deletion_headers())
                    upload = pool.submit(self.request, "POST", "/v1/cases/case-racing/chunks",
                        content=chunk, headers={"Content-Type": "application/json",
                                                "Idempotency-Key": "racing-chunk"})
                    for _ in range(200):
                        waiting = monitor.execute("SELECT count(*) FROM pg_stat_activity "
                            "WHERE usename=%s AND wait_event_type='Lock'", (APP,)).fetchone()[0]
                        if waiting >= 2:
                            break
                        time.sleep(0.01)
                    self.assertGreaterEqual(waiting, 2)
                finally:
                    blocker.rollback()
                self.assertEqual(deletion.result(timeout=5).status_code, 202)
                self.assertIn(upload.result(timeout=5).status_code, (202, 403))
        with self.admin() as admin:
            self.assertEqual(admin.execute("SELECT count(*) FROM scryer.staged_chunks "
                                           "WHERE account_id=%s", (self.account_id,))
                             .fetchone()[0], 0)
            self.assertEqual(admin.execute("SELECT used_bytes FROM scryer.accounts "
                                           "WHERE account_id=%s", (self.account_id,))
                             .fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
