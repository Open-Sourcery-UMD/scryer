"""Credentials for disposable local SQL tests; never a production role setup."""

import os

import psycopg
from psycopg import sql


APP = "scryer_test_app"
APP_PASSWORD = os.environ.get("SCRYER_TEST_PG_APP_PASSWORD")


def ensure_test_app_role(admin):
    admin.execute("DO $$ BEGIN IF NOT EXISTS "
                  "(SELECT 1 FROM pg_roles WHERE rolname='scryer_test_app') THEN "
                  "CREATE ROLE scryer_test_app LOGIN IN ROLE scryer_app; "
                  "END IF; END $$")
    if APP_PASSWORD:
        admin.execute(sql.SQL("ALTER ROLE scryer_test_app PASSWORD {}").format(
            sql.Literal(APP_PASSWORD)))


def app_connect(socket, dbname):
    options = {"password": APP_PASSWORD} if APP_PASSWORD else {}
    return psycopg.connect(host=socket, dbname=dbname, user=APP, **options)
