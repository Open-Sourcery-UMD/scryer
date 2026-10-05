"""Strict browser-outbox wire validation; no financial plaintext is accepted here."""

from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
import hmac
import json
import re
from typing import Any, Sequence


ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
HEX256 = re.compile(r"[0-9a-f]{64}\Z")
B64URL = re.compile(r"[A-Za-z0-9_-]*\Z")
CHUNK_KEYS = ("schemaVersion", "kind", "accountId", "caseId", "revisionId",
              "packageId", "index", "chunkCount", "nonce", "ciphertext", "tag")
MANIFEST_KEYS = ("schemaVersion", "kind", "format", "algorithm", "accountId",
                 "caseId", "revisionId", "deviceId", "keyGeneration", "packageId",
                 "chunkCount", "chunkDigests", "packageDigest")
DEVICE_REGISTRATION_KEYS = ("schemaVersion", "deviceId")
PACKAGE_KEYS = ("schemaVersion", "format", "algorithm", "accountId", "caseId",
                "revisionId", "deviceId", "keyGeneration", "packageId", "chunks")
CHUNK_BYTES = 4 * 1024 * 1024
ENVELOPE_BYTES = 8 * 1024 * 1024
CHUNK_BODY_BYTES = 8 * 1024 * 1024
MANIFEST_BODY_BYTES = 16 * 1024
DEVICE_BODY_BYTES = 256
MAX_CHUNKS = 8
FORMAT = "scryer-case-v1"
ALGORITHM = "AES-256-GCM+HKDF-SHA-256"


class ProtocolError(ValueError):
    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class ChunkRequest:
    body: bytes
    digest: str
    account_id: str
    case_id: str
    revision_id: str
    package_id: str
    index: int
    chunk_count: int
    nonce: str
    ciphertext: str
    tag: str
    cipher_bytes: int


@dataclass(frozen=True)
class ManifestRequest:
    body: bytes
    digest: str
    account_id: str
    case_id: str
    revision_id: str
    device_id: str
    key_generation: int
    package_id: str
    chunk_count: int
    chunk_digests: tuple[str, ...]
    package_digest: str


def _serialize(value: dict[str, Any]) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolError("INVALID_WIRE")
        result[key] = value
    return result


def _bad_constant(_value: str) -> None:
    raise ProtocolError("INVALID_WIRE")


def _load(body: bytes, keys: tuple[str, ...], max_bytes: int) -> dict[str, Any]:
    if not isinstance(body, bytes):
        raise ProtocolError("INVALID_WIRE")
    if len(body) > max_bytes:
        raise ProtocolError("CASE_TOO_LARGE", 413)
    try:
        value = json.loads(body.decode("utf-8", errors="strict"),
                           object_pairs_hook=_pairs, parse_constant=_bad_constant)
        if not isinstance(value, dict) or tuple(value) != keys or _serialize(value) != body:
            raise ProtocolError("INVALID_WIRE")
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as error:
        if isinstance(error, ProtocolError):
            raise
        raise ProtocolError("INVALID_WIRE") from None
    return value


def _id(value: object) -> str:
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ProtocolError("INVALID_WIRE")
    return value


def _b64(value: object, minimum: int, maximum: int) -> bytes:
    if not isinstance(value, str) or not B64URL.fullmatch(value) or len(value) % 4 == 1:
        raise ProtocolError("INVALID_WIRE")
    if len(value) > ((maximum + 2) // 3) * 4:
        raise ProtocolError("CASE_TOO_LARGE", 413)
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, base64.binascii.Error):
        raise ProtocolError("INVALID_WIRE") from None
    if len(decoded) > maximum:
        raise ProtocolError("CASE_TOO_LARGE", 413)
    if len(decoded) < minimum or \
            base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=") != value:
        raise ProtocolError("INVALID_WIRE")
    return decoded


def _common(value: dict[str, Any], expected_account: str) -> tuple[str, str, str, str]:
    if value["schemaVersion"] != "1":
        raise ProtocolError("UNSUPPORTED_VERSION")
    account_id = _id(value["accountId"])
    if account_id != _id(expected_account):
        raise ProtocolError("WRONG_ACCOUNT")
    case_id = _id(value["caseId"])
    revision_id = _id(value["revisionId"])
    package_id = value["packageId"]
    _b64(package_id, 16, 16)
    return account_id, case_id, revision_id, package_id


def parse_device_registration(body: bytes) -> str:
    value = _load(body, DEVICE_REGISTRATION_KEYS, DEVICE_BODY_BYTES)
    if value["schemaVersion"] != "1":
        raise ProtocolError("INVALID_WIRE")
    return parse_device_id(value["deviceId"])


def parse_device_id(value: object) -> str:
    _b64(value, 16, 16)
    return value


def parse_chunk(body: bytes, expected_account: str) -> ChunkRequest:
    value = _load(body, CHUNK_KEYS, CHUNK_BODY_BYTES)
    if value["kind"] != "chunk":
        raise ProtocolError("INVALID_WIRE")
    account_id, case_id, revision_id, package_id = _common(value, expected_account)
    count, index = value["chunkCount"], value["index"]
    if type(count) is not int or not 1 <= count <= MAX_CHUNKS or \
            type(index) is not int or not 0 <= index < count:
        raise ProtocolError("INVALID_WIRE")
    _b64(value["nonce"], 12, 12)
    ciphertext = _b64(value["ciphertext"], 1, CHUNK_BYTES)
    _b64(value["tag"], 16, 16)
    return ChunkRequest(body, hashlib.sha256(body).hexdigest(), account_id,
                        case_id, revision_id, package_id, index, count,
                        value["nonce"], value["ciphertext"], value["tag"], len(ciphertext))


def parse_manifest(body: bytes, expected_account: str) -> ManifestRequest:
    value = _load(body, MANIFEST_KEYS, MANIFEST_BODY_BYTES)
    if value["kind"] != "manifest" or value["format"] != FORMAT or \
            value["algorithm"] != ALGORITHM:
        raise ProtocolError("UNSUPPORTED_VERSION")
    account_id, case_id, revision_id, package_id = _common(value, expected_account)
    _b64(value["deviceId"], 16, 16)
    generation, count = value["keyGeneration"], value["chunkCount"]
    if type(generation) is not int or not 1 <= generation <= 2_147_483_647 or \
            type(count) is not int or not 1 <= count <= MAX_CHUNKS:
        raise ProtocolError("INVALID_WIRE")
    digests = value["chunkDigests"]
    if not isinstance(digests, list) or len(digests) != count or \
            any(not isinstance(digest, str) or not HEX256.fullmatch(digest) for digest in digests):
        raise ProtocolError("INVALID_WIRE")
    package_digest = value["packageDigest"]
    if not isinstance(package_digest, str) or not HEX256.fullmatch(package_digest):
        raise ProtocolError("INVALID_WIRE")
    return ManifestRequest(body, hashlib.sha256(body).hexdigest(), account_id,
                           case_id, revision_id, value["deviceId"], generation,
                           package_id, count, tuple(digests), package_digest)


def assemble_package(manifest: ManifestRequest, chunks: Sequence[ChunkRequest]) -> bytes:
    if len(chunks) != manifest.chunk_count:
        raise ProtocolError("MISSING_CHUNK")
    ordered: list[ChunkRequest | None] = [None] * manifest.chunk_count
    total = 0
    for chunk in chunks:
        if chunk.account_id != manifest.account_id or chunk.case_id != manifest.case_id or \
                chunk.revision_id != manifest.revision_id or chunk.package_id != manifest.package_id or \
                chunk.chunk_count != manifest.chunk_count or not 0 <= chunk.index < manifest.chunk_count or \
                ordered[chunk.index] is not None:
            raise ProtocolError("CHUNK_MISMATCH")
        if not hmac.compare_digest(chunk.digest, manifest.chunk_digests[chunk.index]):
            raise ProtocolError("CHUNK_MISMATCH")
        total += chunk.cipher_bytes + 28  # AES-GCM tag and nonce, in decoded bytes.
        if total > ENVELOPE_BYTES:
            raise ProtocolError("CASE_TOO_LARGE", 413)
        ordered[chunk.index] = chunk
    if any(chunk is None for chunk in ordered):
        raise ProtocolError("MISSING_CHUNK")
    package = {
        "schemaVersion": "1", "format": FORMAT, "algorithm": ALGORITHM,
        "accountId": manifest.account_id, "caseId": manifest.case_id,
        "revisionId": manifest.revision_id, "deviceId": manifest.device_id,
        "keyGeneration": manifest.key_generation, "packageId": manifest.package_id,
        "chunks": [
            {"index": chunk.index, "nonce": chunk.nonce,
             "ciphertext": chunk.ciphertext, "tag": chunk.tag}
            for chunk in ordered if chunk is not None
        ],
    }
    assert tuple(package) == PACKAGE_KEYS
    body = _serialize(package)
    if not hmac.compare_digest(hashlib.sha256(body).hexdigest(), manifest.package_digest):
        raise ProtocolError("PACKAGE_MISMATCH")
    return body


def parse_precondition(value: str | None, creating: bool) -> str | None:
    if value is None:
        raise ProtocolError("PRECONDITION_REQUIRED", 428)
    if creating:
        if value != "*":
            raise ProtocolError("INVALID_PRECONDITION")
        return None
    if not isinstance(value, str) or len(value) < 3 or \
            not value.startswith('"') or not value.endswith('"'):
        raise ProtocolError("INVALID_PRECONDITION")
    if not ID.fullmatch(value[1:-1]):
        raise ProtocolError("INVALID_PRECONDITION")
    return value[1:-1]


def request_digest(method: str, path: str, body: bytes,
                   precondition: str | None) -> str:
    if not isinstance(method, str) or not isinstance(path, str) or \
            not isinstance(body, bytes) or (precondition is not None and not isinstance(precondition, str)):
        raise ProtocolError("INVALID_WIRE")
    pieces = (method.upper().encode("ascii"), path.encode("ascii"),
              b"\xff" if precondition is None else precondition.encode("ascii"), body)
    digest = hashlib.sha256(b"scryer-sync-request-v1\0")
    for piece in pieces:
        digest.update(len(piece).to_bytes(8, "big"))
        digest.update(piece)
    return digest.hexdigest()
