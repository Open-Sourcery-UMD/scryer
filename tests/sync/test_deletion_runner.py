"""One-shot deletion runner configuration and SQL role boundary."""

import getpass
import os
from pathlib import Path
import secrets
import unittest

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from _db_harness import ensure_test_worker_role, WORKER
from sync.migrate import apply_migrations


SOCKET = os.environ.get("SCRYER_TEST_PG_SOCKET")
ADMIN = os.environ.get("SCRYER_TEST_PG_ADMIN", getpass.getuser())
MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


class DeletionRunnerTests(unittest.TestCase):
    def test_config_refuses_missing_or_unsafe_provider_values_without_secret_echo(self):
        from sync.deletion_runner import WorkerRunnerError, run_from_env

        with self.assertRaises(WorkerRunnerError) as missing:
            run_from_env({})
        self.assertEqual(str(missing.exception), "WORKER_CONFIG_INVALID")
        with self.assertRaises(WorkerRunnerError) as unsafe:
            run_from_env({"SCRYER_WORKER_DATABASE_URL": "postgresql://ignored",
                          "SCRYER_KEYCLOAK_ISSUER": "http://example.invalid/realms/test",
                          "SCRYER_KEYCLOAK_CLIENT_ID": "client",
                          "SCRYER_KEYCLOAK_CLIENT_SECRET": "never-print-this-secret"})
        self.assertEqual(str(unsafe.exception), "WORKER_CONFIG_INVALID")

    def test_real_database_rejects_admin_login_and_accepts_idle_worker(self):
        if not SOCKET:
            self.fail("BLOCKED_TOOLING: SCRYER_TEST_PG_SOCKET is required")
        from sync.deletion_runner import WorkerRunnerError, run_from_env

        dbname = "scryer_runner_" + secrets.token_hex(5)
        overprivileged_role = "scryer_runner_owner_" + secrets.token_hex(5)
        granted_role = "scryer_runner_granted_" + secrets.token_hex(5)
        switch_role = "scryer_runner_switch_" + secrets.token_hex(5)
        role_created = False
        granted_created = False
        switch_created = False
        with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                             autocommit=True) as admin:
            pg16 = admin.info.server_version >= 160000
            admin.execute(f'CREATE DATABASE "{dbname}"')
        try:
            with psycopg.connect(host=SOCKET, dbname=dbname, user=ADMIN,
                                 autocommit=True) as admin:
                apply_migrations(admin, MIGRATIONS)
                ensure_test_worker_role(admin)
                admin.execute(sql.SQL("CREATE ROLE {} LOGIN IN ROLE "
                                      "scryer_worker, scryer_owner").format(
                                          sql.Identifier(overprivileged_role)))
                role_created = True
                if "SCRYER_TEST_PG_APP_PASSWORD" in os.environ:
                    admin.execute(sql.SQL("ALTER ROLE {} PASSWORD {}").format(
                        sql.Identifier(overprivileged_role),
                        sql.Literal(os.environ["SCRYER_TEST_PG_APP_PASSWORD"])))
                admin.execute(sql.SQL("CREATE ROLE {} LOGIN IN ROLE "
                                      "scryer_worker").format(
                                          sql.Identifier(granted_role)))
                granted_created = True
                admin.execute(sql.SQL("GRANT SELECT ON scryer.cases TO {}").format(
                    sql.Identifier(granted_role)))
                if "SCRYER_TEST_PG_APP_PASSWORD" in os.environ:
                    admin.execute(sql.SQL("ALTER ROLE {} PASSWORD {}").format(
                        sql.Identifier(granted_role),
                        sql.Literal(os.environ["SCRYER_TEST_PG_APP_PASSWORD"])))
            common = {"SCRYER_KEYCLOAK_ISSUER":
                          "http://127.0.0.1:8081/realms/scryer-local-test",
                      "SCRYER_KEYCLOAK_CLIENT_ID": "synthetic-worker",
                      "SCRYER_KEYCLOAK_CLIENT_SECRET": "synthetic-secret"}
            with self.assertRaises(WorkerRunnerError) as privileged:
                run_from_env({**common, "SCRYER_WORKER_DATABASE_URL":
                    make_conninfo(host=SOCKET, dbname=dbname, user=ADMIN)})
            self.assertEqual(str(privileged.exception), "WORKER_ROLE_REQUIRED")
            with self.assertRaises(WorkerRunnerError) as schema_owner:
                run_from_env({**common, "SCRYER_WORKER_DATABASE_URL":
                    make_conninfo(host=SOCKET, dbname=dbname,
                        user=overprivileged_role,
                        **({"password": os.environ["SCRYER_TEST_PG_APP_PASSWORD"]}
                           if "SCRYER_TEST_PG_APP_PASSWORD" in os.environ else {}))})
            self.assertEqual(str(schema_owner.exception), "WORKER_ROLE_REQUIRED")
            with self.assertRaises(WorkerRunnerError) as direct_grant:
                run_from_env({**common, "SCRYER_WORKER_DATABASE_URL":
                    make_conninfo(host=SOCKET, dbname=dbname,
                        user=granted_role,
                        **({"password": os.environ["SCRYER_TEST_PG_APP_PASSWORD"]}
                           if "SCRYER_TEST_PG_APP_PASSWORD" in os.environ else {}))})
            self.assertEqual(str(direct_grant.exception), "WORKER_ROLE_REQUIRED")
            worker_conninfo = make_conninfo(host=SOCKET, dbname=dbname, user=WORKER,
                **({"password": os.environ["SCRYER_TEST_PG_APP_PASSWORD"]}
                   if "SCRYER_TEST_PG_APP_PASSWORD" in os.environ else {}))
            if pg16:
                with psycopg.connect(host=SOCKET, dbname=dbname, user=ADMIN,
                                     autocommit=True) as admin:
                    admin.execute(sql.SQL("CREATE ROLE {} NOLOGIN").format(
                        sql.Identifier(switch_role)))
                    switch_created = True
                    admin.execute(sql.SQL("GRANT SELECT ON scryer.case_revisions "
                                          "TO {}").format(sql.Identifier(switch_role)))
                    admin.execute(sql.SQL("GRANT {} TO {} WITH INHERIT FALSE, "
                                          "SET TRUE").format(
                        sql.Identifier(switch_role), sql.Identifier(WORKER)))
                with self.assertRaises(WorkerRunnerError) as settable_role:
                    run_from_env({**common,
                        "SCRYER_WORKER_DATABASE_URL": worker_conninfo})
                self.assertEqual(str(settable_role.exception), "WORKER_ROLE_REQUIRED")
                with psycopg.connect(host=SOCKET, dbname=dbname, user=ADMIN,
                                     autocommit=True) as admin:
                    admin.execute(sql.SQL("REVOKE {} FROM {}").format(
                        sql.Identifier(switch_role), sql.Identifier(WORKER)))
            self.assertEqual(run_from_env({**common,
                "SCRYER_WORKER_DATABASE_URL": worker_conninfo}), "idle")
        finally:
            if granted_created:
                with psycopg.connect(host=SOCKET, dbname=dbname, user=ADMIN,
                                     autocommit=True) as admin:
                    admin.execute(sql.SQL("REVOKE SELECT ON scryer.cases FROM {}").format(
                        sql.Identifier(granted_role)))
                    if switch_created:
                        admin.execute(sql.SQL("REVOKE {} FROM {}").format(
                            sql.Identifier(switch_role), sql.Identifier(WORKER)))
                        admin.execute(sql.SQL("REVOKE SELECT ON scryer.case_revisions "
                                              "FROM {}").format(
                            sql.Identifier(switch_role)))
            with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                                 autocommit=True) as admin:
                admin.execute(f'DROP DATABASE "{dbname}" WITH (FORCE)')
                if role_created:
                    admin.execute(sql.SQL("DROP ROLE {}").format(
                        sql.Identifier(overprivileged_role)))
                if granted_created:
                    admin.execute(sql.SQL("DROP ROLE {}").format(
                        sql.Identifier(granted_role)))
                if switch_created:
                    admin.execute(sql.SQL("DROP ROLE {}").format(
                        sql.Identifier(switch_role)))
