"""Identity values accepted only after a separate trusted token verifier succeeds.

This module deliberately does not parse JWTs. Production must supply a maintained
verifier; unit tests may inject a synthetic verifier at the API boundary.
"""

from __future__ import annotations

from dataclasses import dataclass
import base64
import hashlib
import hmac
from typing import Protocol


@dataclass(frozen=True)
class VerifiedIdentity:
    issuer: str
    subject: str
    audience: str


class TokenVerifier(Protocol):
    ready: bool

    def verify(self, token: str) -> VerifiedIdentity: ...


def derive_account_id(issuer: str, subject: str, key: bytes) -> str:
    """Return a server-secret pseudonym, never a plaintext identity or public hash."""
    if not isinstance(key, bytes) or len(key) != 32:
        raise ValueError("INVALID_ACCOUNT_KEY")
    if not isinstance(issuer, str) or not 1 <= len(issuer) <= 256 or "\n" in issuer or \
            not isinstance(subject, str) or not 1 <= len(subject) <= 256 or "\n" in subject:
        raise ValueError("INVALID_IDENTITY")
    digest = hmac.new(key, f"scryer-account-v1\n{issuer}\n{subject}".encode("utf-8"),
                      hashlib.sha256).digest()
    return "a" + base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
