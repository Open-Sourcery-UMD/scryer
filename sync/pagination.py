"""Short-lived tenant-bound cursors for opaque ciphertext case listing."""

from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import re
import time

from .protocol import ID


EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
TOKEN = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\Z")
TTL_SECONDS = 15 * 60


class CursorError(ValueError):
    pass


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if _encode(raw) != value:
        raise CursorError("INVALID_CURSOR")
    return raw


class CaseCursorCodec:
    def __init__(self, key: bytes):
        if not isinstance(key, bytes) or len(key) != 32:
            raise ValueError("INVALID_CURSOR_KEY")
        self._key = key

    def _signature(self, body: bytes) -> bytes:
        return hmac.new(self._key, b"scryer-case-cursor-v1\0" + body,
                        hashlib.sha256).digest()

    def encode(self, account_id: str, updated_at: datetime, case_id: str,
               *, now: int | None = None) -> str:
        if not isinstance(account_id, str) or not ID.fullmatch(account_id) or \
                not isinstance(case_id, str) or not ID.fullmatch(case_id) or \
                not isinstance(updated_at, datetime) or updated_at.tzinfo is None:
            raise CursorError("INVALID_CURSOR")
        utc = updated_at.astimezone(timezone.utc)
        delta = utc - EPOCH
        microseconds = ((delta.days * 86400 + delta.seconds) * 1_000_000 +
                        delta.microseconds)
        issued = int(time.time()) if now is None else now
        if type(issued) is not int or issued < 0:
            raise CursorError("INVALID_CURSOR")
        body = json.dumps({"v": 1, "a": account_id, "t": microseconds,
                           "i": case_id, "e": issued + TTL_SECONDS},
                          separators=(",", ":"), ensure_ascii=True).encode("ascii")
        return _encode(body) + "." + _encode(self._signature(body))

    def decode(self, token: str, account_id: str, *, now: int | None = None
               ) -> tuple[datetime, str]:
        if not isinstance(token, str) or len(token) > 512 or not TOKEN.fullmatch(token) or \
                not isinstance(account_id, str) or not ID.fullmatch(account_id):
            raise CursorError("INVALID_CURSOR")
        try:
            payload, signature = token.split(".")
            body = _decode(payload)
            if not hmac.compare_digest(_decode(signature), self._signature(body)):
                raise CursorError("INVALID_CURSOR")
            value = json.loads(body)
            if type(value) is not dict or tuple(value) != ("v", "a", "t", "i", "e") or \
                    json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("ascii") != body or \
                    type(value["v"]) is not int or value["v"] != 1 or \
                    value["a"] != account_id or type(value["t"]) is not int or \
                    type(value["e"]) is not int or \
                    not isinstance(value["i"], str) or not ID.fullmatch(value["i"]):
                raise CursorError("INVALID_CURSOR")
            current = int(time.time()) if now is None else now
            if type(current) is not int or current > value["e"] or \
                    value["e"] - current > TTL_SECONDS or value["t"] < 0:
                raise CursorError("INVALID_CURSOR")
            timestamp = EPOCH + timedelta(microseconds=value["t"])
            return timestamp, value["i"]
        except (ValueError, OverflowError, TypeError, KeyError, UnicodeDecodeError) as error:
            raise CursorError("INVALID_CURSOR") from error
