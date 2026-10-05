"""One-shot account deletion worker; schedule this process outside the API.

Only bounded outcome codes are printed. Secrets, identity values, provider
bodies, and database connection strings must stay out of operational logs.
"""

from __future__ import annotations

from collections.abc import Mapping
import os
import sys

import psycopg

from .deletion_worker import run_once
from .keycloak_provider import ClientCredentialsTokenSource, KeycloakAdminProvider


class WorkerRunnerError(RuntimeError):
    """A bounded operational code with no connection or identity detail."""


def _required(environ: Mapping[str, str], name: str, limit: int) -> str:
    value = environ.get(name)
    if not isinstance(value, str) or not 1 <= len(value) <= limit:
        raise WorkerRunnerError("WORKER_CONFIG_INVALID")
    return value


def run_from_env(environ: Mapping[str, str]) -> str:
    """Attempt one due job with a verified worker login and bounded I/O."""
    conninfo = _required(environ, "SCRYER_WORKER_DATABASE_URL", 4096)
    issuer = _required(environ, "SCRYER_KEYCLOAK_ISSUER", 256)
    client_id = _required(environ, "SCRYER_KEYCLOAK_CLIENT_ID", 128)
    client_secret = _required(environ, "SCRYER_KEYCLOAK_CLIENT_SECRET", 4096)
    try:
        source = ClientCredentialsTokenSource(
            issuer, client_id, client_secret, timeout_seconds=5)
        provider = KeycloakAdminProvider(issuer, source, timeout_seconds=5)
    except ValueError:
        raise WorkerRunnerError("WORKER_CONFIG_INVALID") from None

    def connect():
        try:
            conn = psycopg.connect(
                conninfo, connect_timeout=5,
                options="-c statement_timeout=5000 -c lock_timeout=1000 "
                        "-c idle_in_transaction_session_timeout=5000")
        except Exception:
            raise WorkerRunnerError("WORKER_DATABASE_UNAVAILABLE") from None
        try:
            row = conn.execute(
                "SELECT current_user = session_user, "
                "pg_has_role(current_user, 'scryer_worker', 'USAGE'), "
                "pg_has_role(current_user, 'scryer_app', 'MEMBER'), "
                "pg_has_role(current_user, 'scryer_owner', 'MEMBER'), "
                "pg_has_role(current_user, 'scryer_security', 'MEMBER'), "
                "rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, "
                "rolreplication, "
                "has_schema_privilege(current_user, 'scryer_private', 'USAGE'), "
                "NOT EXISTS (SELECT 1 FROM pg_roles AS other_role "
                "WHERE other_role.rolname NOT IN (current_user, 'scryer_worker') "
                "AND pg_has_role(current_user, other_role.oid, 'MEMBER')), "
                "NOT EXISTS (SELECT 1 FROM (VALUES "
                "('scryer.cases'::regclass), "
                "('scryer.case_revisions'::regclass), "
                "('scryer.staged_chunks'::regclass), "
                "('scryer.idempotency'::regclass), "
                "('scryer.recovery_wrappers'::regclass), "
                "('scryer.devices'::regclass), "
                "('scryer.case_tombstones'::regclass)) AS sensitive(rel) "
                "WHERE has_table_privilege(current_user, rel, "
                "'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') "
                "OR has_any_column_privilege(current_user, rel, "
                "'SELECT,INSERT,UPDATE,REFERENCES')) "
                "FROM pg_roles WHERE rolname = current_user"
            ).fetchone()
            if row != (True, True, False, False, False,
                       False, False, False, False, False, False, True, True):
                raise WorkerRunnerError("WORKER_ROLE_REQUIRED")
            conn.commit()
            return conn
        except WorkerRunnerError:
            conn.close()
            raise
        except Exception:
            conn.close()
            raise WorkerRunnerError("WORKER_DATABASE_UNAVAILABLE") from None

    try:
        return run_once(connect, provider)
    except WorkerRunnerError:
        raise
    except Exception:
        raise WorkerRunnerError("WORKER_EXECUTION_FAILED") from None


def main() -> int:
    try:
        result = run_from_env(os.environ)
    except WorkerRunnerError as error:
        print(str(error), file=sys.stderr)
        return 2
    print(result)
    return 0 if result in ("idle", "complete") else 1


if __name__ == "__main__":
    raise SystemExit(main())
