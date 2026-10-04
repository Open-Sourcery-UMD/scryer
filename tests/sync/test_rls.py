"""Real PostgreSQL tenant-boundary tests using a disposable synthetic database."""

import getpass
import os
from pathlib import Path
import secrets
import unittest

import psycopg

from sync.db_context import begin_tenant_transaction
from sync.migrate import apply_migrations


MIGRATION = Path(__file__).resolve().parents[2] / "migrations" / "0001_sync.sql"
SOCKET = os.environ.get("SCRYER_TEST_PG_SOCKET")
ADMIN = os.environ.get("SCRYER_TEST_PG_ADMIN", getpass.getuser())
APP = "scryer_test_app"


class TenantBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SOCKET:
            raise RuntimeError("BLOCKED_TOOLING: SCRYER_TEST_PG_SOCKET is required")
        cls.key = secrets.token_bytes(32)
        cls.dbname = "scryer_test_" + secrets.token_hex(5)
        with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                             autocommit=True) as admin:
            admin.execute(f'CREATE DATABASE "{cls.dbname}"')
        try:
            with psycopg.connect(host=SOCKET, dbname=cls.dbname, user=ADMIN,
                                 autocommit=True) as admin:
                apply_migrations(admin, MIGRATION.parent)
                admin.execute("INSERT INTO scryer_private.tenant_key(singleton, secret) "
                              "VALUES (true, %s)", (cls.key,))
                admin.execute("INSERT INTO scryer.accounts "
                              "(account_id, identity_issuer, identity_subject) VALUES "
                              "('acct-a', 'https://issuer.invalid', 'subject-a'), "
                              "('acct-b', 'https://issuer.invalid', 'subject-b')")
                admin.execute("INSERT INTO scryer.cases(account_id, case_id) VALUES "
                              "('acct-a', 'case-a'), ('acct-b', 'case-b')")
            with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                                 autocommit=True) as admin:
                admin.execute("DO $$ BEGIN IF NOT EXISTS "
                              "(SELECT 1 FROM pg_roles WHERE rolname='scryer_test_app') THEN "
                              "CREATE ROLE scryer_test_app LOGIN IN ROLE scryer_app; "
                              "END IF; END $$")
        except BaseException:
            with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                                 autocommit=True) as admin:
                admin.execute(f'DROP DATABASE "{cls.dbname}" WITH (FORCE)')
            raise

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "dbname"):
            with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                                 autocommit=True) as admin:
                admin.execute(f'DROP DATABASE "{cls.dbname}" WITH (FORCE)')

    def app(self):
        return psycopg.connect(host=SOCKET, dbname=self.dbname, user=APP)

    def test_no_context_and_fake_set_cannot_read_tenant_rows(self):
        with self.app() as app:
            with app.transaction():
                self.assertEqual(app.execute("SELECT count(*) FROM scryer.cases").fetchone()[0], 0)
                txid = app.execute("SELECT txid_current()").fetchone()[0]
                app.execute("SELECT set_config('scryer.account_id', 'acct-b', true)")
                app.execute("SELECT set_config('scryer.txid', %s, true)", (str(txid),))
                app.execute("SELECT set_config('scryer.signature', %s, true)", ("0" * 64,))
                self.assertEqual(app.execute("SELECT count(*) FROM scryer.cases").fetchone()[0], 0)

    def test_wrong_context_key_and_pool_reuse_do_not_cross_tenants(self):
        with self.app() as app:
            with app.transaction():
                begin_tenant_transaction(app, "acct-a", secrets.token_bytes(32))
                self.assertEqual(app.execute("SELECT count(*) FROM scryer.cases").fetchone()[0], 0)
            with app.transaction():
                begin_tenant_transaction(app, "acct-b", self.key)
                self.assertEqual(app.execute("SELECT case_id FROM scryer.cases").fetchall(),
                                 [("case-b",)])
            with app.transaction():
                self.assertEqual(app.execute("SELECT count(*) FROM scryer.cases").fetchone()[0], 0)

    def test_signed_context_cannot_be_switched_to_another_account(self):
        with self.app() as app:
            with app.transaction():
                begin_tenant_transaction(app, "acct-a", self.key)
                self.assertGreaterEqual(app.execute("SELECT count(*) FROM scryer.cases").fetchone()[0], 1)
                app.execute("SELECT set_config('scryer.account_id', 'acct-b', true)")
                self.assertEqual(app.execute("SELECT count(*) FROM scryer.cases").fetchone()[0], 0)

    def test_valid_context_sees_only_own_rows_and_cannot_write_another_tenant(self):
        with self.app() as app:
            with app.transaction():
                begin_tenant_transaction(app, "acct-a", self.key)
                rows = app.execute("SELECT case_id FROM scryer.cases ORDER BY case_id").fetchall()
                self.assertEqual(rows, [("case-a",)])
                app.execute("INSERT INTO scryer.cases(account_id, case_id) "
                            "VALUES ('acct-a', 'case-created')")
            with app.transaction():
                begin_tenant_transaction(app, "acct-a", self.key)
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    app.execute("INSERT INTO scryer.cases(account_id, case_id) "
                                "VALUES ('acct-b', 'case-forged')")

    def test_valid_signature_cannot_be_replayed_in_a_later_transaction(self):
        with self.app() as app:
            with app.transaction():
                begin_tenant_transaction(app, "acct-a", self.key)
                signature = app.execute("SELECT current_setting('scryer.signature')").fetchone()[0]
                prior_txid = app.execute("SELECT current_setting('scryer.txid')").fetchone()[0]
                self.assertGreaterEqual(app.execute("SELECT count(*) FROM scryer.cases").fetchone()[0], 1)
            with app.transaction():
                app.execute("SELECT txid_current()")
                app.execute("SELECT set_config('scryer.account_id', 'acct-a', true)")
                app.execute("SELECT set_config('scryer.txid', %s, true)", (prior_txid,))
                app.execute("SELECT set_config('scryer.signature', %s, true)", (signature,))
                self.assertEqual(app.execute("SELECT count(*) FROM scryer.cases").fetchone()[0], 0)

    def test_app_role_cannot_read_context_secret_and_every_tenant_table_has_forced_rls(self):
        with self.app() as app:
            attributes = app.execute("SELECT rolsuper, rolbypassrls, rolcanlogin "
                                     "FROM pg_roles WHERE rolname='scryer_app'").fetchone()
            self.assertEqual(attributes, (False, False, False))
            self.assertFalse(app.execute("SELECT pg_has_role('scryer_test_app', "
                                         "'scryer_owner', 'MEMBER')").fetchone()[0])
            self.assertFalse(app.execute("SELECT pg_has_role('scryer_test_app', "
                                         "'scryer_security', 'MEMBER')").fetchone()[0])
            tables = app.execute("SELECT relname, relrowsecurity, relforcerowsecurity "
                                 "FROM pg_class JOIN pg_namespace ON pg_namespace.oid=relnamespace "
                                 "WHERE nspname='scryer' AND relkind='r' ORDER BY relname").fetchall()
            self.assertGreaterEqual(len(tables), 7)
            self.assertTrue(all(rls and forced for _, rls, forced in tables))
        with self.app() as app:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                app.execute("SELECT secret FROM scryer_private.tenant_key")
        with self.app() as app:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                app.execute("SELECT account_id FROM scryer.deletion_jobs")
        with self.app() as app:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                app.execute("SELECT checksum FROM scryer_private.schema_migrations")


if __name__ == "__main__":
    unittest.main()
