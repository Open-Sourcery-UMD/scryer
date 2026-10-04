"""Transactional migration and checksum tests against disposable PostgreSQL DBs."""

import getpass
import os
from pathlib import Path
import secrets
import tempfile
import unittest

import psycopg

from sync.migrate import MigrationError, apply_migrations


MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"
SOCKET = os.environ.get("SCRYER_TEST_PG_SOCKET")
ADMIN = os.environ.get("SCRYER_TEST_PG_ADMIN", getpass.getuser())


class MigrationTests(unittest.TestCase):
    def setUp(self):
        if not SOCKET:
            raise RuntimeError("BLOCKED_TOOLING: SCRYER_TEST_PG_SOCKET is required")
        self.dbname = "scryer_migration_" + secrets.token_hex(5)
        with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                             autocommit=True) as admin:
            admin.execute(f'CREATE DATABASE "{self.dbname}"')

    def tearDown(self):
        with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                             autocommit=True) as admin:
            admin.execute(f'DROP DATABASE "{self.dbname}" WITH (FORCE)')

    def connect(self):
        return psycopg.connect(host=SOCKET, dbname=self.dbname, user=ADMIN)

    def test_fresh_apply_is_recorded_and_repeated_apply_is_noop(self):
        with self.connect() as conn:
            self.assertEqual(apply_migrations(conn, MIGRATIONS), ["0001_sync.sql"])
            self.assertEqual(apply_migrations(conn, MIGRATIONS), [])
            rows = conn.execute("SELECT filename, checksum FROM "
                                "scryer_private.schema_migrations").fetchall()
            self.assertEqual(rows[0][0], "0001_sync.sql")
            self.assertEqual(len(rows[0][1]), 64)

    def test_changed_applied_migration_is_rejected(self):
        with self.connect() as conn, tempfile.TemporaryDirectory() as temp:
            copied = Path(temp) / "0001_sync.sql"
            copied.write_bytes((MIGRATIONS / "0001_sync.sql").read_bytes())
            apply_migrations(conn, Path(temp))
            copied.write_bytes(copied.read_bytes() + b"\n-- silent rewrite\n")
            with self.assertRaisesRegex(MigrationError, "CHECKSUM_MISMATCH"):
                apply_migrations(conn, Path(temp))

    def test_failed_migration_rolls_back_then_forward_fix_succeeds(self):
        with self.connect() as conn, tempfile.TemporaryDirectory() as temp:
            copied = Path(temp) / "0001_sync.sql"
            copied.write_bytes((MIGRATIONS / "0001_sync.sql").read_bytes() + b"\nSELECT 1/0;\n")
            with self.assertRaises(psycopg.errors.DivisionByZero):
                apply_migrations(conn, Path(temp))
            self.assertIsNone(conn.execute("SELECT to_regnamespace('scryer')").fetchone()[0])
            self.assertEqual(apply_migrations(conn, MIGRATIONS), ["0001_sync.sql"])

    def test_unknown_applied_future_migration_is_rejected(self):
        with self.connect() as conn:
            apply_migrations(conn, MIGRATIONS)
            conn.execute("INSERT INTO scryer_private.schema_migrations "
                         "(filename, checksum) VALUES ('9999_future.sql', %s)", ("0" * 64,))
            conn.commit()
            with self.assertRaisesRegex(MigrationError, "UNKNOWN_APPLIED_MIGRATION"):
                apply_migrations(conn, MIGRATIONS)


if __name__ == "__main__":
    unittest.main()
