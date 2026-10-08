"""Real local Keycloak deletion check using disposable synthetic identities only."""

from __future__ import annotations

import json
import getpass
import os
from pathlib import Path
import secrets
import unittest
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener
from uuid import UUID

import psycopg
from psycopg.conninfo import make_conninfo

from _db_harness import ensure_test_worker_role, WORKER
from sync.deletion_worker import ProviderNotFound
from sync.deletion_runner import run_from_env
from sync.keycloak_provider import (ClientCredentialsTokenSource,
                                   KeycloakAdminProvider, ProviderError)
from sync.migrate import apply_migrations


ROOT = Path(__file__).resolve().parents[2]
ISSUER = "http://127.0.0.1:8081/realms/scryer-local-test"
ORIGIN = "http://127.0.0.1:8081"
REALM_API = ORIGIN + "/admin/realms/scryer-local-test"
OPENER = build_opener(ProxyHandler({}))
SOCKET = os.environ.get("SCRYER_TEST_PG_SOCKET")
ADMIN = os.environ.get("SCRYER_TEST_PG_ADMIN", getpass.getuser())


def _request(method, url, *, token=None, value=None, form=None):
    if value is not None and form is not None:
        raise ValueError("AMBIGUOUS_REQUEST")
    headers = {"Accept": "application/json"}
    data = None
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    if value is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(value, separators=(",", ":")).encode("utf-8")
    if form is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        data = urlencode(form).encode("ascii")
    request = Request(url, data=data, method=method, headers=headers)
    try:
        with OPENER.open(request, timeout=5) as response:
            body = response.read(65537)
            if len(body) > 65536:
                raise AssertionError("Local Keycloak response exceeded test bound")
            return response.status, response.headers, (json.loads(body) if body else None)
    except HTTPError as error:
        code = error.code
        error.close()
        return code, {}, None


def _expect(status, actual):
    if actual[0] != status:
        raise AssertionError(f"Local Keycloak status {actual[0]}, expected {status}")
    return actual


def _admin_token():
    credentials = dict(line.split("=", 1) for line in
                       (ROOT / ".backend-artifacts/keycloak-auth-test/admin.env")
                       .read_text().splitlines() if "=" in line)
    return _expect(200, _request("POST", ORIGIN +
        "/realms/master/protocol/openid-connect/token", form={
            "grant_type": "password", "client_id": "admin-cli",
            "username": credentials["KC_BOOTSTRAP_ADMIN_USERNAME"],
            "password": credentials["KC_BOOTSTRAP_ADMIN_PASSWORD"],
        }))[2]["access_token"]


def _create_service_client(admin_token, client_id, client_secret):
    _expect(201, _request("POST", REALM_API + "/clients", token=admin_token,
        value={"clientId": client_id, "enabled": True,
               "secret": client_secret, "publicClient": False,
               "serviceAccountsEnabled": True,
               "standardFlowEnabled": False,
               "directAccessGrantsEnabled": False}))
    clients = _expect(200, _request("GET", REALM_API + "/clients?" +
        urlencode({"clientId": client_id}), token=admin_token))[2]
    if len(clients) != 1:
        raise AssertionError("Expected one disposable service client")
    return clients[0]["id"]


def _create_synthetic_user(admin_token, suffix):
    user_location = _expect(201, _request("POST", REALM_API + "/users",
        token=admin_token,
        value={"username": "deletion-test-" + suffix,
               "email": "deletion-test-" + suffix + "@example.invalid",
               "enabled": True}))[1].get("Location")
    if user_location is None:
        raise AssertionError("Keycloak omitted synthetic user location")
    user_id = user_location.rsplit("/", 1)[-1]
    if str(UUID(user_id, version=4)) != user_id:
        raise AssertionError("Keycloak user ID is not canonical UUIDv4")
    return user_id


def _grant_manage_users(admin_token, client_uuid):
    service_user = _expect(200, _request("GET", REALM_API +
        "/clients/" + client_uuid + "/service-account-user",
        token=admin_token))[2]
    management = _expect(200, _request("GET", REALM_API + "/clients?" +
        urlencode({"clientId": "realm-management"}), token=admin_token))[2]
    if len(management) != 1:
        raise AssertionError("Expected one realm-management client")
    management_id = management[0]["id"]
    role = _expect(200, _request("GET", REALM_API + "/clients/" +
        management_id + "/roles/manage-users", token=admin_token))[2]
    _expect(204, _request("POST", REALM_API + "/users/" + service_user["id"] +
        "/role-mappings/clients/" + management_id, token=admin_token,
        value=[role]))


@unittest.skipUnless(os.environ.get("SCRYER_LOCAL_OIDC") == "1",
                     "requires explicitly enabled disposable local Keycloak")
class RealKeycloakDeletionTests(unittest.TestCase):
    def test_service_account_requires_manage_users_then_deletes_synthetic_user(self):
        admin_token = _admin_token()
        suffix = secrets.token_hex(8)
        client_id = "scryer-deletion-test-" + suffix
        client_secret = secrets.token_urlsafe(32)
        user_id = None
        client_uuid = None
        try:
            client_uuid = _create_service_client(admin_token, client_id, client_secret)
            user_id = _create_synthetic_user(admin_token, suffix)

            source = ClientCredentialsTokenSource(
                ISSUER, client_id, client_secret, timeout_seconds=5)
            provider = KeycloakAdminProvider(ISSUER, source, timeout_seconds=5)
            with self.assertRaises(ProviderError) as denied:
                provider.delete_user(ISSUER, user_id)
            self.assertEqual(str(denied.exception), "PROVIDER_LOOKUP_FAILED")
            _expect(200, _request("GET", REALM_API + "/users/" + user_id,
                                  token=admin_token))

            _grant_manage_users(admin_token, client_uuid)

            provider.delete_user(ISSUER, user_id)
            _expect(404, _request("GET", REALM_API + "/users/" + user_id,
                                  token=admin_token))
            with self.assertRaises(ProviderNotFound):
                provider.delete_user(ISSUER, user_id)
        finally:
            if user_id:
                _request("DELETE", REALM_API + "/users/" + user_id,
                         token=admin_token)
            if client_uuid:
                _request("DELETE", REALM_API + "/clients/" + client_uuid,
                         token=admin_token)

    @unittest.skipUnless(SOCKET, "requires disposable local PostgreSQL")
    def test_one_shot_runner_retries_permission_failure_then_anonymizes_account(self):
        admin_token = _admin_token()
        suffix = secrets.token_hex(8)
        client_id = "scryer-deletion-test-" + suffix
        client_secret = secrets.token_urlsafe(32)
        dbname = "scryer_provider_" + secrets.token_hex(5)
        client_uuid = None
        user_id = None
        database_created = False
        try:
            client_uuid = _create_service_client(admin_token, client_id, client_secret)
            user_id = _create_synthetic_user(admin_token, suffix)
            with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                                 autocommit=True) as admin:
                admin.execute(f'CREATE DATABASE "{dbname}"')
            database_created = True
            account_id = "synthetic_" + suffix
            with psycopg.connect(host=SOCKET, dbname=dbname, user=ADMIN,
                                 autocommit=True) as admin:
                apply_migrations(admin, ROOT / "migrations")
                ensure_test_worker_role(admin)
                admin.execute("INSERT INTO scryer.accounts "
                    "(account_id,identity_issuer,identity_subject,status,"
                    "deletion_key,deletion_digest) "
                    "VALUES (%s,%s,%s,'deleting','synthetic-delete',%s)",
                    (account_id, ISSUER, user_id, "0" * 64))
                admin.execute("INSERT INTO scryer.deletion_jobs "
                    "(account_id,identity_issuer,identity_subject,state) "
                    "VALUES (%s,%s,%s,'pending')",
                    (account_id, ISSUER, user_id))
            conninfo = make_conninfo(host=SOCKET, dbname=dbname, user=WORKER,
                **({"password": os.environ["SCRYER_TEST_PG_APP_PASSWORD"]}
                   if "SCRYER_TEST_PG_APP_PASSWORD" in os.environ else {}))
            env = {"SCRYER_WORKER_DATABASE_URL": conninfo,
                   "SCRYER_KEYCLOAK_ISSUER": ISSUER,
                   "SCRYER_KEYCLOAK_CLIENT_ID": client_id,
                   "SCRYER_KEYCLOAK_CLIENT_SECRET": client_secret}
            self.assertEqual(run_from_env(env), "retry")
            _expect(200, _request("GET", REALM_API + "/users/" + user_id,
                                  token=admin_token))
            with psycopg.connect(host=SOCKET, dbname=dbname, user=ADMIN) as admin:
                self.assertEqual(admin.execute("SELECT state,attempts FROM "
                    "scryer.deletion_jobs WHERE account_id=%s", (account_id,)).fetchone(),
                    ("retry", 1))
            _grant_manage_users(admin_token, client_uuid)
            with psycopg.connect(host=SOCKET, dbname=dbname, user=ADMIN) as admin:
                admin.execute("UPDATE scryer.deletion_jobs "
                    "SET next_attempt_at=clock_timestamp()-interval '1 second' "
                    "WHERE account_id=%s", (account_id,))
            self.assertEqual(run_from_env(env), "complete")
            _expect(404, _request("GET", REALM_API + "/users/" + user_id,
                                  token=admin_token))
            with psycopg.connect(host=SOCKET, dbname=dbname, user=ADMIN) as admin:
                self.assertEqual(admin.execute("SELECT status,identity_issuer,"
                    "identity_subject FROM scryer.accounts WHERE account_id=%s",
                    (account_id,)).fetchone(), ("deleted", None, None))
                self.assertIsNone(admin.execute("SELECT 1 FROM scryer.deletion_jobs "
                    "WHERE account_id=%s", (account_id,)).fetchone())
        finally:
            if database_created:
                with psycopg.connect(host=SOCKET, dbname="postgres", user=ADMIN,
                                     autocommit=True) as admin:
                    admin.execute(f'DROP DATABASE "{dbname}" WITH (FORCE)')
            if user_id:
                _request("DELETE", REALM_API + "/users/" + user_id,
                         token=admin_token)
            if client_uuid:
                _request("DELETE", REALM_API + "/clients/" + client_uuid,
                         token=admin_token)
