"""HTTP and PostgreSQL boundary tests. Tokens here are a unit-only verifier stub.

The real-provider browser PKCE test is separate; this suite cannot validate JWTs.
"""

import getpass
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import secrets
import time
import unittest

from fastapi.testclient import TestClient
import psycopg

from _db_harness import APP, app_connect, ensure_test_app_role
from sync.auth import VerifiedIdentity, derive_account_id
from sync.api import create_sync_app
from sync.migrate import apply_migrations
from sync.protocol import CHUNK_KEYS, MANIFEST_KEYS
from test_store import prepared


SOCKET = os.environ.get("SCRYER_TEST_PG_SOCKET")
ADMIN = os.environ.get("SCRYER_TEST_PG_ADMIN", getpass.getuser())
ISSUER = "https://issuer.invalid"
AUDIENCE = "scryer-api"
MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


class FixtureVerifier:
    ready = True

    def verify(self, token):
        if token == "wrong-issuer":
            return VerifiedIdentity("https://other.invalid", "subject-one", AUDIENCE)
        if token == "wrong-audience":
            return VerifiedIdentity(ISSUER, "subject-one", "other-api")
        if token == "invalid-subject":
            return VerifiedIdentity(ISSUER, "", AUDIENCE)
        if token not in ("one", "two"):
            raise ValueError("INVALID_TOKEN")
        return VerifiedIdentity(ISSUER, f"subject-{token}", AUDIENCE)


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SOCKET:
            raise RuntimeError("BLOCKED_TOOLING: SCRYER_TEST_PG_SOCKET is required")
        cls.context_key = secrets.token_bytes(32)
        cls.account_key = secrets.token_bytes(32)
        cls.dbname = "scryer_api_" + secrets.token_hex(5)
        with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                             autocommit=True) as admin:
            admin.execute(f'CREATE DATABASE "{cls.dbname}"')
        try:
            with psycopg.connect(host=SOCKET, dbname=cls.dbname, user=ADMIN,
                                 autocommit=True) as admin:
                apply_migrations(admin, MIGRATIONS)
                admin.execute("INSERT INTO scryer_private.tenant_key(singleton, secret) "
                              "VALUES (true, %s)", (cls.context_key,))
                ensure_test_app_role(admin)
            app = create_sync_app(
                connect=lambda: app_connect(SOCKET, cls.dbname),
                verifier=FixtureVerifier(), context_key=cls.context_key,
                account_key=cls.account_key, issuer=ISSUER, audience=AUDIENCE,
                allowed_origins=("http://127.0.0.1:39000",))
            cls.client = TestClient(app)
            cls.client.__enter__()
        except BaseException:
            with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                                 autocommit=True) as admin:
                admin.execute(f'DROP DATABASE "{cls.dbname}" WITH (FORCE)')
            raise

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "client"):
            cls.client.__exit__(None, None, None)
        if hasattr(cls, "dbname"):
            with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                                 autocommit=True) as admin:
                admin.execute(f'DROP DATABASE "{cls.dbname}" WITH (FORCE)')

    def request(self, method, path, token="one", **kwargs):
        headers = kwargs.pop("headers", {})
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        return self.client.request(method, path, headers=headers, **kwargs)

    def account_id(self, token="one"):
        return derive_account_id(ISSUER, f"subject-{token}", self.account_key)

    def test_liveness_readiness_and_authenticated_account_status(self):
        self.assertEqual(self.client.get("/health/live").status_code, 200)
        self.assertEqual(self.client.get("/health/ready").status_code, 200)
        missing = self.request("GET", "/v1/account", token=None)
        self.assertEqual(missing.status_code, 401)
        self.assertEqual(set(missing.json()["error"]), {"code", "requestId"})
        invalid = self.request("GET", "/v1/account", token="garbage")
        self.assertEqual(invalid.status_code, 401)
        for token in ("wrong-issuer", "wrong-audience", "invalid-subject"):
            self.assertEqual(self.request("GET", "/v1/account", token=token).status_code, 401)
        for token in ("one", "two"):
            response = self.request("GET", "/v1/account", token=token)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["accountId"], self.account_id(token))
            self.assertEqual(response.json()["status"], "active")
            self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertNotEqual(self.account_id("one"), self.account_id("two"))
        paths = self.client.get("/openapi.json").json()["paths"]
        self.assertIn("/v1/account", paths)
        self.assertIn("/v1/cases/{case_id}/revisions", paths)
        chunk_operation = paths["/v1/cases/{case_id}/chunks"]["post"]
        self.assertIn("application/json", chunk_operation["requestBody"]["content"])
        self.assertIn("202", chunk_operation["responses"])
        chunk_schema = chunk_operation["requestBody"]["content"]["application/json"]["schema"]
        self.assertEqual(tuple(chunk_schema["required"]), CHUNK_KEYS)
        manifest_operation = paths["/v1/cases/{case_id}/revisions"]["post"]
        self.assertIn("application/json", manifest_operation["requestBody"]["content"])
        self.assertIn("200", manifest_operation["responses"])
        self.assertIn("201", manifest_operation["responses"])
        self.assertIn("401", manifest_operation["responses"])
        manifest_schema = manifest_operation["requestBody"]["content"]["application/json"]["schema"]
        self.assertEqual(tuple(manifest_schema["required"]), MANIFEST_KEYS)
        self.assertIn("application/json", manifest_operation["responses"]["201"]["content"])

    def test_exact_ciphertext_write_read_and_cross_tenant_404(self):
        account = self.account_id()
        self.request("GET", "/v1/account")
        chunk, manifest, package = prepared(case_id="case-http", account_id=account)
        origin = "http://127.0.0.1:39000"
        stage = self.request("POST", "/v1/cases/case-http/chunks", content=chunk,
            headers={"Content-Type": "application/json", "Idempotency-Key": "http:chunk:0",
                     "Origin": origin})
        self.assertEqual(stage.status_code, 202, stage.text)
        self.assertEqual(stage.headers["access-control-allow-origin"], origin)
        create = self.request("POST", "/v1/cases/case-http/revisions", content=manifest,
            headers={"Content-Type": "application/json", "Idempotency-Key": "http:manifest",
                     "If-None-Match": "*"})
        self.assertEqual(create.status_code, 201, create.text)
        self.assertEqual(create.headers["etag"], '"rev-one"')
        self.assertEqual(self.request("POST", "/v1/cases/case-http/revisions",
            content=manifest, headers={"Content-Type": "application/json",
                "Idempotency-Key": "http:manifest", "If-None-Match": "*"}).status_code, 201)
        own = self.request("GET", "/v1/cases/case-http")
        self.assertEqual(own.status_code, 200)
        self.assertEqual(own.content, package)
        self.assertEqual(own.headers["cache-control"], "no-store")
        self.assertEqual(self.request("GET", "/v1/cases/case-http", token="two").status_code, 404)
        self.assertEqual(self.request("GET", "/v1/cases/never-existed", token="two").status_code, 404)

    def test_preconditions_body_bounds_account_disable_and_cors(self):
        account = self.account_id()
        self.request("GET", "/v1/account")
        chunk, manifest, _ = prepared(case_id="case-guards", account_id=account)
        base = {"Content-Type": "application/json", "Idempotency-Key": "guards:manifest"}
        no_precondition = self.request("POST", "/v1/cases/case-guards/revisions",
                                       content=manifest, headers=base)
        self.assertEqual(no_precondition.status_code, 428)
        too_large = self.request("POST", "/v1/cases/case-guards/chunks",
            content=b"x" * (8 * 1024 * 1024 + 1),
            headers={"Content-Type": "application/json", "Idempotency-Key": "guards:big"})
        self.assertEqual(too_large.status_code, 413)
        mismatch = self.request("POST", "/v1/cases/not-the-body/chunks", content=chunk,
            headers={"Content-Type": "application/json", "Idempotency-Key": "guards:mismatch"})
        self.assertEqual(mismatch.status_code, 400)
        forbidden_origin = self.request("GET", "/v1/account",
            headers={"Origin": "http://evil.invalid"})
        self.assertNotIn("access-control-allow-origin", forbidden_origin.headers)
        with psycopg.connect(host=SOCKET, dbname=self.dbname, user=ADMIN) as admin:
            admin.execute("UPDATE scryer.accounts SET status='disabled' WHERE account_id=%s", (account,))
        try:
            disabled = self.request("GET", "/v1/account")
            self.assertEqual(disabled.status_code, 403)
            self.assertEqual(disabled.json()["error"]["code"], "ACCOUNT_DISABLED")
        finally:
            with psycopg.connect(host=SOCKET, dbname=self.dbname, user=ADMIN) as admin:
                admin.execute("UPDATE scryer.accounts SET status='active' WHERE account_id=%s", (account,))

    def test_update_conflict_delete_and_old_retry_do_not_resurrect(self):
        account = self.account_id()
        self.request("GET", "/v1/account")
        first_chunk, first_manifest, _ = prepared(case_id="case-lifecycle", account_id=account)
        second_chunk, second_manifest, _ = prepared(case_id="case-lifecycle",
            revision_id="rev-two", account_id=account)
        chunk_headers = {"Content-Type": "application/json", "Idempotency-Key": "life:first:chunk"}
        self.assertEqual(self.request("POST", "/v1/cases/case-lifecycle/chunks",
            content=first_chunk, headers=chunk_headers).status_code, 202)
        self.assertEqual(self.request("POST", "/v1/cases/case-lifecycle/chunks",
            content=second_chunk, headers=chunk_headers).status_code, 409)
        create_headers = {"Content-Type": "application/json",
                          "Idempotency-Key": "life:first:manifest", "If-None-Match": "*"}
        self.assertEqual(self.request("POST", "/v1/cases/case-lifecycle/revisions",
            content=first_manifest, headers=create_headers).status_code, 201)
        self.assertEqual(self.request("POST", "/v1/cases/case-lifecycle/chunks",
            content=second_chunk, headers={"Content-Type": "application/json",
                                           "Idempotency-Key": "life:second:chunk"}).status_code, 202)
        stale_headers = {"Content-Type": "application/json",
                         "Idempotency-Key": "life:second:manifest", "If-Match": '"wrong"'}
        self.assertEqual(self.request("POST", "/v1/cases/case-lifecycle/revisions",
            content=second_manifest, headers=stale_headers).status_code, 412)
        self.assertEqual(self.request("GET", "/v1/cases/case-lifecycle").headers["etag"],
                         '"rev-one"')
        delete_headers = {"Idempotency-Key": "life:delete", "If-Match": '"rev-one"'}
        self.assertEqual(self.request("DELETE", "/v1/cases/case-lifecycle",
            headers=delete_headers).status_code, 200)
        self.assertEqual(self.request("DELETE", "/v1/cases/case-lifecycle",
            headers=delete_headers).status_code, 200)
        self.assertEqual(self.request("GET", "/v1/cases/case-lifecycle").status_code, 404)
        self.assertEqual(self.request("POST", "/v1/cases/case-lifecycle/revisions",
            content=first_manifest, headers=create_headers).status_code, 409)
        self.assertEqual(self.request("POST", "/v1/cases/case-lifecycle/chunks",
            content=first_chunk, headers=chunk_headers).status_code, 409)

    def test_readiness_requires_schema_and_matching_context_key(self):
        empty_name = "scryer_unmigrated_" + secrets.token_hex(5)
        with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                             autocommit=True) as admin:
            admin.execute(f'CREATE DATABASE "{empty_name}"')
        try:
            app = create_sync_app(
                connect=lambda: psycopg.connect(host=SOCKET, dbname=empty_name, user=ADMIN),
                verifier=FixtureVerifier(), context_key=self.context_key,
                account_key=self.account_key, issuer=ISSUER, audience=AUDIENCE)
            with TestClient(app) as client:
                self.assertEqual(client.get("/health/ready").status_code, 503)
        finally:
            with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                                 autocommit=True) as admin:
                admin.execute(f'DROP DATABASE "{empty_name}" WITH (FORCE)')
        with psycopg.connect(host=SOCKET, dbname=self.dbname, user=ADMIN) as admin:
            admin.execute("DELETE FROM scryer_private.tenant_key")
        try:
            self.assertEqual(self.client.get("/health/ready").status_code, 503)
        finally:
            with psycopg.connect(host=SOCKET, dbname=self.dbname, user=ADMIN) as admin:
                admin.execute("INSERT INTO scryer_private.tenant_key(singleton,secret) "
                              "VALUES (true,%s)", (self.context_key,))
        wrong_key_app = create_sync_app(
            connect=lambda: app_connect(SOCKET, self.dbname),
            verifier=FixtureVerifier(), context_key=secrets.token_bytes(32),
            account_key=self.account_key, issuer=ISSUER, audience=AUDIENCE)
        with TestClient(wrong_key_app) as client:
            self.assertEqual(client.get("/health/ready").status_code, 503)

    def test_delete_body_and_extreme_content_length_are_typed_errors(self):
        nonempty = self.request("DELETE", "/v1/cases/case-never",
            content=b"changed", headers={"Idempotency-Key": "delete:body",
                                         "If-Match": '"rev-one"'})
        self.assertEqual(nonempty.status_code, 400)
        self.assertEqual(nonempty.json()["error"]["code"], "UNEXPECTED_BODY")
        huge = self.request("POST", "/v1/cases/case-never/chunks", content=b"",
            headers={"Content-Type": "application/json", "Idempotency-Key": "huge:length",
                     "Content-Length": "9" * 5000})
        self.assertEqual(huge.status_code, 413)
        self.assertEqual(huge.json()["error"]["code"], "CASE_TOO_LARGE")

    def test_locked_database_write_does_not_block_liveness(self):
        account = self.account_id()
        self.request("GET", "/v1/account")
        chunk, _, _ = prepared(case_id="case-lock", account_id=account)
        with psycopg.connect(host=SOCKET, dbname=self.dbname, user=ADMIN) as admin:
            admin.execute("SELECT account_id FROM scryer.accounts "
                          "WHERE account_id=%s FOR UPDATE", (account,))
            with psycopg.connect(host=SOCKET, dbname=self.dbname, user=ADMIN,
                                 autocommit=True) as monitor, ThreadPoolExecutor(max_workers=2) as pool:
                try:
                    blocked_write = pool.submit(self.request, "POST", "/v1/cases/case-lock/chunks",
                        content=chunk, headers={"Content-Type": "application/json",
                                                "Idempotency-Key": "lock:chunk"})
                    blocked = False
                    for _ in range(200):
                        blocked = monitor.execute("SELECT EXISTS (SELECT 1 FROM pg_stat_activity "
                            "WHERE usename=%s AND wait_event_type='Lock')", (APP,)).fetchone()[0]
                        if blocked:
                            break
                        time.sleep(0.01)
                    self.assertTrue(blocked, "write never reached the account-row lock")
                    health = pool.submit(self.client.get, "/health/live")
                    self.assertEqual(health.result(timeout=2).status_code, 200)
                finally:
                    admin.rollback()
                self.assertEqual(blocked_write.result(timeout=5).status_code, 202)


if __name__ == "__main__":
    unittest.main()
