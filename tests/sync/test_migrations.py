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
            self.assertEqual(apply_migrations(conn, MIGRATIONS),
                             ["0001_sync.sql", "0002_account_identity.sql",
                              "0003_case_listing.sql", "0004_account_deletion.sql"])
            self.assertEqual(apply_migrations(conn, MIGRATIONS), [])
            rows = conn.execute("SELECT filename, checksum FROM "
                                "scryer_private.schema_migrations").fetchall()
            self.assertEqual([row[0] for row in rows],
                             ["0001_sync.sql", "0002_account_identity.sql",
                              "0003_case_listing.sql", "0004_account_deletion.sql"])
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
            self.assertEqual(apply_migrations(conn, MIGRATIONS),
                             ["0001_sync.sql", "0002_account_identity.sql",
                              "0003_case_listing.sql", "0004_account_deletion.sql"])

    def test_existing_active_account_survives_forward_deletion_migration(self):
        with self.connect() as conn, tempfile.TemporaryDirectory() as temp:
            for name in ("0001_sync.sql", "0002_account_identity.sql",
                         "0003_case_listing.sql"):
                (Path(temp) / name).write_bytes((MIGRATIONS / name).read_bytes())
            self.assertEqual(len(apply_migrations(conn, Path(temp))), 3)
            conn.execute("INSERT INTO scryer.accounts "
                         "(account_id,identity_issuer,identity_subject) "
                         "VALUES ('existing','https://issuer.invalid','old-user')")
            conn.execute("INSERT INTO scryer.cases(account_id,case_id) "
                         "VALUES ('existing','case-existing')")
            conn.commit()
            self.assertEqual(apply_migrations(conn, MIGRATIONS),
                             ["0004_account_deletion.sql"])
            self.assertEqual(conn.execute("SELECT status,identity_subject "
                                          "FROM scryer.accounts WHERE account_id='existing'")
                             .fetchone(), ("active", "old-user"))
            self.assertEqual(conn.execute("SELECT case_id FROM scryer.cases "
                                          "WHERE account_id='existing'").fetchone()[0],
                             "case-existing")

    def test_legacy_lifecycle_row_requires_operator_review_before_forward_migration(self):
        with self.connect() as conn, tempfile.TemporaryDirectory() as temp:
            for name in ("0001_sync.sql", "0002_account_identity.sql",
                         "0003_case_listing.sql"):
                (Path(temp) / name).write_bytes((MIGRATIONS / name).read_bytes())
            apply_migrations(conn, Path(temp))
            conn.execute("INSERT INTO scryer.accounts "
                         "(account_id,identity_issuer,identity_subject,status) "
                         "VALUES ('legacy','https://issuer.invalid','old-user','deleting')")
            conn.commit()
            with self.assertRaisesRegex(psycopg.errors.CheckViolation,
                                        "LEGACY_ACCOUNT_LIFECYCLE_REVIEW_REQUIRED"):
                apply_migrations(conn, MIGRATIONS)
            conn.rollback()
            self.assertEqual(conn.execute("SELECT filename FROM "
                                          "scryer_private.schema_migrations ORDER BY filename")
                             .fetchall(), [("0001_sync.sql",),
                                           ("0002_account_identity.sql",),
                                           ("0003_case_listing.sql",)])

    def test_existing_duplicate_identity_blocks_forward_migration_without_partial_apply(self):
        with self.connect() as conn, tempfile.TemporaryDirectory() as temp:
            (Path(temp) / "0001_sync.sql").write_bytes((MIGRATIONS / "0001_sync.sql").read_bytes())
            self.assertEqual(apply_migrations(conn, Path(temp)), ["0001_sync.sql"])
            conn.execute("INSERT INTO scryer.accounts "
                         "(account_id,identity_issuer,identity_subject) VALUES "
                         "('one','https://issuer.invalid','same'), "
                         "('two','https://issuer.invalid','same')")
            conn.commit()
            with self.assertRaises(psycopg.errors.UniqueViolation):
                apply_migrations(conn, MIGRATIONS)
            conn.rollback()
            self.assertEqual(conn.execute("SELECT filename FROM "
                                          "scryer_private.schema_migrations ORDER BY filename").fetchall(),
                             [("0001_sync.sql",)])

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
