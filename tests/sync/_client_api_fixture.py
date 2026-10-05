"""Disposable loopback API for Chrome integration, with a unit-only token verifier.

This fixture is not an authentication implementation or a production entrypoint.
It uses synthetic identities and a randomly named database, then drops that
database when its local server exits.
"""

from __future__ import annotations

import getpass
import os
from pathlib import Path
import re
import secrets
import sys

import psycopg
import uvicorn


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from _db_harness import app_connect, ensure_test_app_role  # noqa: E402
from sync.api import create_sync_app  # noqa: E402
from sync.auth import VerifiedIdentity  # noqa: E402
from sync.migrate import apply_migrations  # noqa: E402


ISSUER = "https://issuer.invalid"
AUDIENCE = "scryer-api"


class FixtureVerifier:
    ready = True

    def verify(self, token: str) -> VerifiedIdentity:
        if token not in ("one", "two"):
            raise ValueError("INVALID_TOKEN")
        return VerifiedIdentity(ISSUER, f"subject-{token}", AUDIENCE)


def database_config() -> tuple[str, str, str]:
    socket = os.environ["SCRYER_TEST_PG_SOCKET"]
    admin_user = os.environ.get("SCRYER_TEST_PG_ADMIN", getpass.getuser())
    database_name = os.environ["SCRYER_TEST_DBNAME"]
    if not re.fullmatch(r"scryer_browser_[0-9a-f]{12}", database_name):
        raise ValueError("INVALID_LOCAL_TEST_DATABASE")
    return socket, admin_user, database_name


def drop_database(socket: str, admin_user: str, database_name: str) -> None:
    with psycopg.connect(host=socket, dbname="postgres", user=admin_user,
                         autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)')


def main() -> None:
    socket, admin_user, database_name = database_config()
    if len(sys.argv) == 2 and sys.argv[1] == "--cleanup":
        drop_database(socket, admin_user, database_name)
        return
    if len(sys.argv) != 1:
        raise ValueError("INVALID_LOCAL_TEST_COMMAND")
    port = int(os.environ["SCRYER_TEST_API_PORT"])
    browser_origin = os.environ["SCRYER_TEST_BROWSER_ORIGIN"]
    if not 1024 <= port <= 65535 or not browser_origin.startswith("http://127.0.0.1:"):
        raise ValueError("INVALID_LOCAL_TEST_CONFIG")
    context_key = secrets.token_bytes(32)
    account_key = secrets.token_bytes(32)
    with psycopg.connect(host=socket, dbname="postgres", user=admin_user,
                         autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{database_name}"')
    try:
        with psycopg.connect(host=socket, dbname=database_name, user=admin_user,
                             autocommit=True) as admin:
            apply_migrations(admin, ROOT / "migrations")
            admin.execute("INSERT INTO scryer_private.tenant_key(singleton, secret) "
                          "VALUES (true, %s)", (context_key,))
            ensure_test_app_role(admin)
        app = create_sync_app(
            connect=lambda: app_connect(socket, database_name),
            verifier=FixtureVerifier(), context_key=context_key,
            account_key=account_key, issuer=ISSUER, audience=AUDIENCE,
            allowed_origins=(browser_origin,),
        )
        uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                                      log_level="error", access_log=False,
                                      timeout_graceful_shutdown=1)).run()
    finally:
        drop_database(socket, admin_user, database_name)


if __name__ == "__main__":
    main()
