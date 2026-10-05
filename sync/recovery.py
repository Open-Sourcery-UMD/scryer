"""Strict encrypted recovery-envelope wire validation; no decryption keys live here."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re

from .protocol import ALGORITHM, ProtocolError, _b64, _id, _load


RECOVERY_KEYS = ("schemaVersion", "format", "algorithm", "accountId", "salt",
                 "nonce", "ciphertext", "tag")
RECOVERY_FORMAT = "scryer-recovery-wrap-v1"
RECOVERY_BODY_BYTES = 4096
GENERATION_ETAG = re.compile(r'"([1-9][0-9]{0,9})"\Z')
MAX_GENERATION = 2_147_483_647


@dataclass(frozen=True)
class RecoveryEnvelope:
    body: bytes
    digest: str
    account_id: str


def parse_recovery_wrapper(body: bytes, expected_account: str) -> RecoveryEnvelope:
    value = _load(body, RECOVERY_KEYS, RECOVERY_BODY_BYTES)
    if value["schemaVersion"] != "1" or value["format"] != RECOVERY_FORMAT or \
            value["algorithm"] != ALGORITHM:
        raise ProtocolError("UNSUPPORTED_VERSION")
    account_id = _id(value["accountId"])
    if account_id != _id(expected_account):
        raise ProtocolError("WRONG_ACCOUNT")
    _b64(value["salt"], 16, 16)
    _b64(value["nonce"], 12, 12)
    _b64(value["ciphertext"], 32, 32)
    _b64(value["tag"], 16, 16)
    return RecoveryEnvelope(body, hashlib.sha256(body).hexdigest(), account_id)


def parse_generation_precondition(value: str | None, creating: bool) -> int | None:
    if value is None:
        raise ProtocolError("PRECONDITION_REQUIRED", 428)
    if creating:
        if value != "*":
            raise ProtocolError("INVALID_PRECONDITION")
        return None
    matched = GENERATION_ETAG.fullmatch(value)
    if matched is None or int(matched[1]) > MAX_GENERATION:
        raise ProtocolError("INVALID_PRECONDITION")
    return int(matched[1])
