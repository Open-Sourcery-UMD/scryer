"""Loopback protocol tests for the bounded Keycloak admin deletion adapter."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer
from threading import Thread
import time
import unittest
from urllib.parse import parse_qs, urlsplit


USER_ID = "11111111-2222-4333-8444-555555555555"


class LoopbackServer(ThreadingHTTPServer):
    def server_bind(self):
        # Avoid a host reverse-DNS lookup in HTTPServer.server_bind().
        TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = self.server_address[1]


class ProviderHttpTests(unittest.TestCase):
    def setUp(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _format, *_args):
                pass

            def do_GET(self):
                state = self.server.state
                state["get_calls"] += 1
                if self.headers.get("Authorization") != "Bearer synthetic.token":
                    self.send_error(403)
                    return
                if self.path == f"/admin/realms/scryer-test/users/{USER_ID}":
                    if state["get_status_after_delete"] is not None and \
                            state["delete_calls"]:
                        self.send_response(state["get_status_after_delete"])
                        self.end_headers()
                        return
                    if state["get_status"] is not None:
                        self.send_response(state["get_status"])
                        self.end_headers()
                        return
                    if USER_ID not in state["users"]:
                        self.send_response(404)
                        self.end_headers()
                        return
                    if state["slow_body"]:
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", "100")
                        self.end_headers()
                        for _ in range(100):
                            try:
                                self.wfile.write(b"x")
                                self.wfile.flush()
                            except BrokenPipeError:
                                break
                            time.sleep(0.05)
                        return
                    body = ('{"id":"' + USER_ID + '"}').encode("ascii")
                elif self.path == "/admin/realms/scryer-test/users/count":
                    if state["count_status"] is not None:
                        self.send_response(state["count_status"])
                        self.end_headers()
                        return
                    body = str(len(state["users"])).encode("ascii")
                elif urlsplit(self.path).path == "/admin/realms/scryer-test/users":
                    if state["list_status"] is not None:
                        self.send_response(state["list_status"])
                        self.end_headers()
                        return
                    query = parse_qs(urlsplit(self.path).query)
                    if query.get("first") != ["0"] or \
                            query.get("briefRepresentation") != ["true"] or \
                            int(query.get("max", ["0"])[0]) < len(state["users"]):
                        self.send_error(400)
                        return
                    body = ("[" + ",".join('{"id":"' + user + '"}'
                        for user in sorted(state["users"])) + "]").encode("ascii")
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                state = self.server.state
                state["token_calls"] += 1
                length = int(self.headers.get("Content-Length", "0"))
                form = parse_qs(self.rfile.read(length).decode("ascii"))
                if self.path != "/realms/scryer-test/protocol/openid-connect/token" or \
                        form != {"grant_type": ["client_credentials"],
                                 "client_id": ["worker-client"],
                                 "client_secret": ["synthetic-secret"]}:
                    self.send_error(400)
                    return
                if state["token_status"] != 200:
                    self.send_error(state["token_status"])
                    return
                body = b'{"access_token":"synthetic.token","token_type":"Bearer","expires_in":60}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_DELETE(self):
                state = self.server.state
                state["delete_calls"] += 1
                if self.path != f"/admin/realms/scryer-test/users/{USER_ID}" or \
                        self.headers.get("Authorization") != "Bearer synthetic.token":
                    self.send_error(403)
                    return
                if state["delete_status"] is not None:
                    self.send_response(state["delete_status"])
                    if state["delete_status"] == 302:
                        self.send_header("Location", "http://example.invalid/steal")
                    self.end_headers()
                    return
                if USER_ID not in state["users"]:
                    self.send_response(404)
                    self.end_headers()
                    return
                state["users"].remove(USER_ID)
                self.send_response(204)
                self.end_headers()

        self.server = LoopbackServer(("127.0.0.1", 0), Handler)
        self.server.state = {"users": {USER_ID}, "token_calls": 0,
                             "delete_calls": 0, "get_calls": 0,
                             "token_status": 200, "delete_status": None,
                             "get_status": None, "count_status": None,
                             "get_status_after_delete": None, "list_status": None,
                             "slow_body": False}
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.issuer = f"http://127.0.0.1:{self.server.server_port}/realms/scryer-test"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def provider(self):
        from sync.keycloak_provider import (ClientCredentialsTokenSource,
                                             KeycloakAdminProvider)

        source = ClientCredentialsTokenSource(
            self.issuer, "worker-client", "synthetic-secret", timeout_seconds=5)
        return KeycloakAdminProvider(self.issuer, source, timeout_seconds=5)

    def test_real_http_token_then_delete_and_missing_user_are_bounded(self):
        from sync.deletion_worker import ProviderNotFound

        provider = self.provider()
        self.assertLessEqual(provider.max_duration_seconds, 30)
        provider.delete_user(self.issuer, USER_ID)
        self.assertEqual(self.server.state["users"], set())
        with self.assertRaises(ProviderNotFound):
            provider.delete_user(self.issuer, USER_ID)
        self.assertEqual(self.server.state["token_calls"], 2)
        self.assertEqual(self.server.state["delete_calls"], 1)
        self.assertEqual(self.server.state["get_calls"], 7)

    def test_delete_404_for_existing_user_is_retryable(self):
        from sync.keycloak_provider import ProviderError

        self.server.state["delete_status"] = 404
        with self.assertRaises(ProviderError) as caught:
            self.provider().delete_user(self.issuer, USER_ID)
        self.assertEqual(str(caught.exception), "PROVIDER_DELETE_FAILED")
        self.assertIn(USER_ID, self.server.state["users"])

    def test_lookup_404_needs_a_working_list_endpoint(self):
        from sync.keycloak_provider import ProviderError

        self.server.state["get_status"] = 404
        self.server.state["count_status"] = 404
        with self.assertRaises(ProviderError):
            self.provider().delete_user(self.issuer, USER_ID)
        self.assertEqual(self.server.state["delete_calls"], 0)

    def test_lookup_404_and_healthy_count_cannot_hide_listed_user(self):
        from sync.keycloak_provider import ProviderError

        self.server.state["get_status"] = 404
        with self.assertRaises(ProviderError):
            self.provider().delete_user(self.issuer, USER_ID)
        self.assertIn(USER_ID, self.server.state["users"])
        self.assertEqual(self.server.state["delete_calls"], 0)

    def test_delete_success_without_actual_removal_is_retryable(self):
        from sync.keycloak_provider import ProviderError

        self.server.state["delete_status"] = 204
        with self.assertRaises(ProviderError):
            self.provider().delete_user(self.issuer, USER_ID)
        self.assertIn(USER_ID, self.server.state["users"])

    def test_false_delete_success_and_false_post_lookup_cannot_finalize(self):
        from sync.keycloak_provider import ProviderError

        self.server.state["delete_status"] = 204
        self.server.state["get_status_after_delete"] = 404
        with self.assertRaises(ProviderError):
            self.provider().delete_user(self.issuer, USER_ID)
        self.assertIn(USER_ID, self.server.state["users"])

    def test_slow_http_body_cannot_extend_whole_attempt(self):
        from sync.keycloak_provider import (ClientCredentialsTokenSource,
                                             KeycloakAdminProvider, ProviderError)

        self.server.state["slow_body"] = True
        source = ClientCredentialsTokenSource(
            self.issuer, "worker-client", "synthetic-secret", timeout_seconds=0.1)
        provider = KeycloakAdminProvider(self.issuer, source, timeout_seconds=0.1)
        start = time.monotonic()
        with self.assertRaises(ProviderError) as caught:
            provider.delete_user(self.issuer, USER_ID)
        self.assertLess(time.monotonic() - start, 4.5)
        self.assertEqual(str(caught.exception), "PROVIDER_DELETE_FAILED")
        self.assertEqual(self.server.state["delete_calls"], 0)

    def test_wrong_issuer_or_subject_never_contacts_provider(self):
        from sync.keycloak_provider import ProviderError

        provider = self.provider()
        for issuer, subject in (("https://other.invalid/realms/scryer-test", USER_ID),
                                (self.issuer, "../other-user")):
            with self.subTest(issuer=issuer, subject=subject):
                with self.assertRaises(ProviderError):
                    provider.delete_user(issuer, subject)
        self.assertEqual(self.server.state["token_calls"], 0)
        self.assertEqual(self.server.state["delete_calls"], 0)

    def test_provider_redirect_and_token_failure_never_expose_secret(self):
        from sync.keycloak_provider import ProviderError

        provider = self.provider()
        self.server.state["delete_status"] = 302
        with self.assertRaises(ProviderError) as caught:
            provider.delete_user(self.issuer, USER_ID)
        self.assertNotIn("synthetic-secret", str(caught.exception))
        self.assertNotIn("synthetic.token", str(caught.exception))
        self.server.state["delete_status"] = None
        self.server.state["token_status"] = 503
        with self.assertRaises(ProviderError):
            provider.delete_user(self.issuer, USER_ID)
        self.assertEqual(self.server.state["delete_calls"], 1)

    def test_config_rejects_public_cleartext_and_long_timeouts(self):
        from sync.keycloak_provider import (ClientCredentialsTokenSource,
                                             KeycloakAdminProvider)

        with self.assertRaises(ValueError):
            ClientCredentialsTokenSource(
                "http://example.invalid/realms/scryer-test",
                "worker-client", "synthetic-secret", timeout_seconds=5)
        with self.assertRaises(ValueError):
            KeycloakAdminProvider(self.issuer, lambda: "synthetic.token",
                                  timeout_seconds=45)

    def test_whole_provider_attempt_has_a_wall_clock_deadline(self):
        from sync.keycloak_provider import KeycloakAdminProvider, ProviderError

        class StalledTokenSource:
            max_duration_seconds = 0.1

            def __call__(self):
                time.sleep(4)
                return "synthetic.token"

        provider = KeycloakAdminProvider(self.issuer, StalledTokenSource(),
                                        timeout_seconds=0.1)
        start = time.monotonic()
        with self.assertRaises(ProviderError) as caught:
            provider.delete_user(self.issuer, USER_ID)
        self.assertLess(time.monotonic() - start, 3)
        self.assertEqual(str(caught.exception), "PROVIDER_DELETE_FAILED")
        self.assertEqual(self.server.state["delete_calls"], 0)


if __name__ == "__main__":
    unittest.main()
