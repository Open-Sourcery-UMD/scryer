"""Bounded Keycloak admin client for durable account-deletion jobs.

The issuer is fixed at worker startup. Job data can select only a UUID user
under that same realm. This module never prints tokens, provider bodies, or
the stored subject. HTTPS is required except for a literal loopback test URL.
"""

from __future__ import annotations

from contextlib import contextmanager
import json
import math
import re
import signal
from threading import current_thread, main_thread
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import (HTTPRedirectHandler, ProxyHandler, Request,
                            build_opener)
from uuid import UUID

from .deletion_worker import ProviderNotFound


TOKEN = re.compile(r"[A-Za-z0-9._~-]{1,8192}\Z")
REALM_PATH = re.compile(r"/realms/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\Z")


class ProviderError(RuntimeError):
    """Bounded provider failure code with no credential or identity detail."""


class _WallDeadlineReached(BaseException):
    pass


@contextmanager
def _wall_deadline(seconds: float):
    """Bound an entire provider call, including slow response bodies and DNS."""
    if current_thread() is not main_thread():
        raise ProviderError("PROVIDER_DEADLINE_UNAVAILABLE")
    remaining, interval = signal.getitimer(signal.ITIMER_REAL)
    if remaining or interval:
        raise ProviderError("PROVIDER_DEADLINE_UNAVAILABLE")
    previous = signal.getsignal(signal.SIGALRM)

    def expire(_signum, _frame):
        raise _WallDeadlineReached

    signal.signal(signal.SIGALRM, expire)
    try:
        signal.setitimer(signal.ITIMER_REAL, seconds)
        try:
            yield
        except _WallDeadlineReached:
            raise ProviderError("PROVIDER_DELETE_FAILED") from None
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class TokenSource(Protocol):
    max_duration_seconds: float

    def __call__(self) -> str: ...


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def _issuer_parts(issuer: str) -> tuple[str, str]:
    if not isinstance(issuer, str) or len(issuer) > 256:
        raise ValueError("INVALID_KEYCLOAK_ISSUER")
    parts = urlsplit(issuer)
    match = REALM_PATH.fullmatch(parts.path)
    if not parts.hostname or not match or parts.query or parts.fragment or \
            parts.username or parts.password or issuer.endswith("/") or \
            (parts.scheme != "https" and not
             (parts.scheme == "http" and parts.hostname in ("127.0.0.1", "::1"))):
        raise ValueError("INVALID_KEYCLOAK_ISSUER")
    try:
        port = parts.port
    except ValueError:
        raise ValueError("INVALID_KEYCLOAK_ISSUER") from None
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("INVALID_KEYCLOAK_ISSUER")
    return f"{parts.scheme}://{parts.netloc}", match.group(1)


def _timeout(value: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or \
            not math.isfinite(value) or not 0 < value <= 10:
        raise ValueError("INVALID_KEYCLOAK_TIMEOUT")
    return float(value)


def _token(value: str) -> str:
    if not isinstance(value, str) or not TOKEN.fullmatch(value):
        raise ProviderError("PROVIDER_TOKEN_INVALID")
    return value


def _no_duplicate_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("DUPLICATE_FIELD")
        result[key] = value
    return result


class ClientCredentialsTokenSource:
    """Fetch a short-lived service-account token per deletion attempt."""

    def __init__(self, issuer: str, client_id: str, client_secret: str,
                 *, timeout_seconds: float = 5):
        _issuer_parts(issuer)
        if not isinstance(client_id, str) or not re.fullmatch(
                r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", client_id):
            raise ValueError("INVALID_KEYCLOAK_CLIENT")
        if not isinstance(client_secret, str) or not 1 <= len(client_secret) <= 4096:
            raise ValueError("INVALID_KEYCLOAK_CLIENT")
        self.issuer = issuer
        self.client_id = client_id
        self.client_secret = client_secret
        self.timeout_seconds = _timeout(timeout_seconds)
        self.max_duration_seconds = self.timeout_seconds + 1
        self._opener = build_opener(ProxyHandler({}), _NoRedirect())

    def __call__(self) -> str:
        form = urlencode({"grant_type": "client_credentials",
                          "client_id": self.client_id,
                          "client_secret": self.client_secret}).encode("ascii")
        request = Request(
            self.issuer + "/protocol/openid-connect/token", data=form,
            method="POST", headers={"Content-Type": "application/x-www-form-urlencoded",
                                    "Accept": "application/json"})
        try:
            with self._opener.open(request, timeout=self.timeout_seconds) as response:
                if response.status != 200 or not response.headers.get(
                        "Content-Type", "").lower().startswith("application/json"):
                    raise ProviderError("PROVIDER_TOKEN_FAILED")
                raw = response.read(16385)
        except HTTPError as error:
            error.close()
            raise ProviderError("PROVIDER_TOKEN_FAILED") from None
        except (URLError, OSError, TimeoutError):
            raise ProviderError("PROVIDER_TOKEN_FAILED") from None
        if len(raw) > 16384:
            raise ProviderError("PROVIDER_TOKEN_INVALID")
        try:
            value = json.loads(raw, object_pairs_hook=_no_duplicate_pairs)
        except (UnicodeDecodeError, ValueError):
            raise ProviderError("PROVIDER_TOKEN_INVALID") from None
        if not isinstance(value, dict) or value.get("token_type") != "Bearer" or \
                isinstance(value.get("expires_in"), bool) or \
                not isinstance(value.get("expires_in"), int) or \
                not 1 <= value["expires_in"] <= 86400:
            raise ProviderError("PROVIDER_TOKEN_INVALID")
        return _token(value.get("access_token"))


class KeycloakAdminProvider:
    """Delete only a canonical UUID from the configured issuer realm."""

    def __init__(self, issuer: str, token_source: TokenSource,
                 *, timeout_seconds: float = 5):
        origin, realm = _issuer_parts(issuer)
        timeout = _timeout(timeout_seconds)
        source_duration = getattr(token_source, "max_duration_seconds", None)
        if not callable(token_source) or isinstance(source_duration, bool) or \
                not isinstance(source_duration, (int, float)) or \
                not math.isfinite(source_duration) or not 0 < source_duration <= 15:
            raise ValueError("INVALID_KEYCLOAK_TOKEN_SOURCE")
        # This is a hard wall limit; extra absence-confirmation calls retry if
        # they cannot finish within it, rather than extending the SQL lease.
        self.max_duration_seconds = source_duration + 3 * timeout + 2
        if self.max_duration_seconds > 30:
            raise ValueError("INVALID_KEYCLOAK_TIMEOUT")
        self.issuer = issuer
        self.admin_users_url = f"{origin}/admin/realms/{realm}/users/"
        self.token_source = token_source
        self.timeout_seconds = timeout
        self._opener = build_opener(ProxyHandler({}), _NoRedirect())

    def _get_user(self, token: str, subject: str) -> bool:
        request = Request(self.admin_users_url + subject, method="GET",
                          headers={"Authorization": "Bearer " + token,
                                   "Accept": "application/json"})
        try:
            with self._opener.open(request, timeout=self.timeout_seconds) as response:
                if response.status != 200 or not response.headers.get(
                        "Content-Type", "").lower().startswith("application/json"):
                    raise ProviderError("PROVIDER_LOOKUP_FAILED")
                raw = response.read(65537)
        except HTTPError as error:
            code = error.code
            error.close()
            if code == 404:
                return False
            raise ProviderError("PROVIDER_LOOKUP_FAILED") from None
        except (URLError, OSError, TimeoutError):
            raise ProviderError("PROVIDER_LOOKUP_FAILED") from None
        if len(raw) > 65536:
            raise ProviderError("PROVIDER_LOOKUP_FAILED")
        try:
            value = json.loads(raw, object_pairs_hook=_no_duplicate_pairs)
        except (UnicodeDecodeError, ValueError):
            raise ProviderError("PROVIDER_LOOKUP_FAILED") from None
        if not isinstance(value, dict) or value.get("id") != subject:
            raise ProviderError("PROVIDER_LOOKUP_FAILED")
        return True

    def _confirm_user_api(self, token: str, subject: str) -> None:
        """Prove absence through one complete, bounded collection snapshot."""
        request = Request(self.admin_users_url + "count", method="GET",
                          headers={"Authorization": "Bearer " + token,
                                   "Accept": "application/json"})
        try:
            with self._opener.open(request, timeout=self.timeout_seconds) as response:
                if response.status != 200 or not response.headers.get(
                        "Content-Type", "").lower().startswith("application/json"):
                    raise ProviderError("PROVIDER_LOOKUP_FAILED")
                raw = response.read(65)
        except HTTPError as error:
            error.close()
            raise ProviderError("PROVIDER_LOOKUP_FAILED") from None
        except (URLError, OSError, TimeoutError):
            raise ProviderError("PROVIDER_LOOKUP_FAILED") from None
        if len(raw) > 64:
            raise ProviderError("PROVIDER_LOOKUP_FAILED")
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, ValueError):
            raise ProviderError("PROVIDER_LOOKUP_FAILED") from None
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ProviderError("PROVIDER_LOOKUP_FAILED")
        if value > 5000:
            raise ProviderError("PROVIDER_LOOKUP_INCONCLUSIVE")
        # Keycloak's search query does not match UUID user IDs. Request one
        # complete page instead; a truncated or changing collection retries.
        list_url = self.admin_users_url[:-1] + (
            f"?first=0&max={value + 1}&briefRepresentation=true")
        request = Request(list_url, method="GET",
                          headers={"Authorization": "Bearer " + token,
                                   "Accept": "application/json"})
        try:
            with self._opener.open(request, timeout=self.timeout_seconds) as response:
                if response.status != 200 or not response.headers.get(
                        "Content-Type", "").lower().startswith("application/json"):
                    raise ProviderError("PROVIDER_LOOKUP_FAILED")
                raw = response.read(16_777_217)
        except HTTPError as error:
            error.close()
            raise ProviderError("PROVIDER_LOOKUP_FAILED") from None
        except (URLError, OSError, TimeoutError):
            raise ProviderError("PROVIDER_LOOKUP_FAILED") from None
        if len(raw) > 16_777_216:
            raise ProviderError("PROVIDER_LOOKUP_INCONCLUSIVE")
        try:
            users = json.loads(raw, object_pairs_hook=_no_duplicate_pairs)
        except (UnicodeDecodeError, ValueError):
            raise ProviderError("PROVIDER_LOOKUP_FAILED") from None
        if not isinstance(users, list) or len(users) != value:
            raise ProviderError("PROVIDER_LOOKUP_INCONCLUSIVE")
        ids = [user.get("id") for user in users if isinstance(user, dict)]
        if len(ids) != value or any(not isinstance(item, str) or not item
                                   for item in ids) or len(set(ids)) != value:
            raise ProviderError("PROVIDER_LOOKUP_INCONCLUSIVE")
        if subject in ids:
            raise ProviderError("PROVIDER_LOOKUP_FAILED")

    def delete_user(self, issuer: str, subject: str) -> None:
        if issuer != self.issuer:
            raise ProviderError("PROVIDER_ISSUER_MISMATCH")
        if not isinstance(subject, str):
            raise ProviderError("PROVIDER_SUBJECT_INVALID")
        try:
            parsed = UUID(subject)
        except (ValueError, AttributeError):
            raise ProviderError("PROVIDER_SUBJECT_INVALID") from None
        if str(parsed) != subject or parsed.version != 4:
            raise ProviderError("PROVIDER_SUBJECT_INVALID")
        with _wall_deadline(self.max_duration_seconds):
            token = _token(self.token_source())
            if not self._get_user(token, subject):
                self._confirm_user_api(token, subject)
                raise ProviderNotFound
            request = Request(self.admin_users_url + subject, method="DELETE",
                              headers={"Authorization": "Bearer " + token,
                                       "Accept": "application/json"})
            try:
                with self._opener.open(request, timeout=self.timeout_seconds) as response:
                    if response.status != 204:
                        raise ProviderError("PROVIDER_DELETE_FAILED")
            except HTTPError as error:
                error.close()
                raise ProviderError("PROVIDER_DELETE_FAILED") from None
            except (URLError, OSError, TimeoutError):
                raise ProviderError("PROVIDER_DELETE_FAILED") from None
            if self._get_user(token, subject):
                raise ProviderError("PROVIDER_DELETE_FAILED")
            self._confirm_user_api(token, subject)
