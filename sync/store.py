"""Atomic ciphertext-only revision storage under a signed tenant transaction.

Each caller opens a PostgreSQL transaction and establishes its verified tenant
context before calling these functions. The HTTP layer must exit that
transaction successfully before returning a receipt to the browser.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
import re

from psycopg import Connection
from psycopg.pq import TransactionStatus

from .protocol import (
    ChunkRequest, ProtocolError, assemble_package, parse_chunk, parse_manifest,
    parse_precondition, request_digest,
)
from .recovery import parse_generation_precondition, parse_recovery_wrapper


QUOTA = 256 * 1024 * 1024
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
IDEMPOTENCY_KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9:_-]{0,159}\Z")


class StoreError(RuntimeError):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class Head:
    case_id: str
    revision_id: str
    package_digest: str
    ciphertext: bytes


@dataclass(frozen=True)
class CaseSummary:
    case_id: str
    head_revision_id: str
    updated_at: datetime


@dataclass(frozen=True)
class StoredRecovery:
    generation: int
    digest: str
    body: bytes


def _id(value: str) -> str:
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise StoreError("INVALID_ID", 400)
    return value


def _key(value: str) -> str:
    if not isinstance(value, str) or not IDEMPOTENCY_KEY.fullmatch(value):
        raise StoreError("INVALID_IDEMPOTENCY_KEY", 400)
    return value


def _transaction(conn: Connection) -> None:
    if conn.info.transaction_status != TransactionStatus.INTRANS:
        raise RuntimeError("TENANT_TRANSACTION_REQUIRED")


def _parse(fn, *args):
    try:
        return fn(*args)
    except ProtocolError as error:
        raise StoreError(error.code, error.status) from None


def _receipt_bytes(value: dict) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def _lock_account(conn: Connection, account_id: str) -> int:
    row = conn.execute("SELECT status, used_bytes FROM scryer.accounts "
                       "WHERE account_id=%s FOR UPDATE", (account_id,)).fetchone()
    if row is None:
        raise StoreError("ACCOUNT_UNAVAILABLE", 404)
    if row[0] != "active":
        raise StoreError("ACCOUNT_DISABLED", 403)
    return row[1]


def _prune_expired(conn: Connection, account_id: str, used: int) -> int:
    expired = conn.execute(
        "DELETE FROM scryer.staged_chunks WHERE account_id=%s "
        "AND expires_at<=now() RETURNING octet_length(body)", (account_id,)
    ).fetchall()
    released = sum(row[0] for row in expired)
    if released:
        used -= released
        if used < 0:
            raise StoreError("CORRUPT_QUOTA", 500)
        conn.execute("UPDATE scryer.accounts SET used_bytes=%s WHERE account_id=%s",
                     (used, account_id))
    conn.execute("DELETE FROM scryer.idempotency WHERE account_id=%s "
                 "AND expires_at<=now()", (account_id,))
    return used


def _tombstoned(conn: Connection, account_id: str, case_id: str) -> bool:
    return conn.execute("SELECT 1 FROM scryer.case_tombstones "
                        "WHERE account_id=%s AND case_id=%s",
                        (account_id, case_id)).fetchone() is not None


def _idempotent(conn: Connection, account_id: str, key: str,
                digest: str, operation: str, case_id: str | None) -> dict | None:
    row = conn.execute("SELECT request_digest, operation, case_id, response "
                       "FROM scryer.idempotency WHERE account_id=%s AND key=%s",
                       (account_id, key)).fetchone()
    if row is None:
        return None
    if row[:3] != (digest, operation, case_id):
        raise StoreError("IDEMPOTENCY_CONFLICT", 409)
    try:
        value = json.loads(row[3])
    except (TypeError, ValueError):
        raise StoreError("CORRUPT_RECEIPT", 500) from None
    if not isinstance(value, dict):
        raise StoreError("CORRUPT_RECEIPT", 500)
    return value


def _save_receipt(conn: Connection, account_id: str, key: str, digest: str,
                  operation: str, case_id: str | None, receipt: dict) -> None:
    conn.execute("INSERT INTO scryer.idempotency "
                 "(account_id, key, request_digest, operation, case_id, response) "
                 "VALUES (%s,%s,%s,%s,%s,%s)",
                 (account_id, key, digest, operation, case_id, _receipt_bytes(receipt)))


def stage_chunk(conn: Connection, account_id: str, idempotency_key: str,
                body: bytes) -> dict:
    _transaction(conn)
    account_id, idempotency_key = _id(account_id), _key(idempotency_key)
    chunk = _parse(parse_chunk, body, account_id)
    used = _prune_expired(conn, account_id, _lock_account(conn, account_id))
    if _tombstoned(conn, account_id, chunk.case_id):
        raise StoreError("CASE_DELETED")
    digest = request_digest("POST", f"/v1/cases/{chunk.case_id}/chunks", body, None)
    existing = conn.execute(
        "SELECT body_digest FROM scryer.staged_chunks WHERE account_id=%s AND case_id=%s "
        "AND revision_id=%s AND package_id=%s AND chunk_index=%s",
        (account_id, chunk.case_id, chunk.revision_id, chunk.package_id, chunk.index)
    ).fetchone()
    committed = conn.execute("SELECT 1 FROM scryer.case_revisions WHERE account_id=%s "
                             "AND case_id=%s AND revision_id=%s",
                             (account_id, chunk.case_id, chunk.revision_id)).fetchone() is not None
    cached = _idempotent(conn, account_id, idempotency_key, digest, "chunk", chunk.case_id)
    if cached is not None:
        if existing is not None and existing[0] != chunk.digest:
            raise StoreError("CHUNK_CONFLICT")
        if existing is not None or committed:
            return cached
        # The staged bytes expired after the first receipt. Preserve the
        # browser's saved key/body and make its exact retry stage bytes again.
        conn.execute("DELETE FROM scryer.idempotency WHERE account_id=%s AND key=%s",
                     (account_id, idempotency_key))
    if committed:
        raise StoreError("REVISION_EXISTS")
    if existing is not None:
        if existing[0] != chunk.digest:
            raise StoreError("CHUNK_CONFLICT")
    else:
        if used + len(body) > QUOTA:
            raise StoreError("QUOTA_EXCEEDED", 413)
        conn.execute("INSERT INTO scryer.staged_chunks "
                     "(account_id,case_id,revision_id,package_id,chunk_index,body,body_digest,decoded_bytes) "
                     "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                     (account_id, chunk.case_id, chunk.revision_id, chunk.package_id,
                      chunk.index, body, chunk.digest, chunk.cipher_bytes))
        conn.execute("UPDATE scryer.accounts SET used_bytes=%s WHERE account_id=%s",
                     (used + len(body), account_id))
    receipt = {"kind": "chunk", "caseId": chunk.case_id,
               "revisionId": chunk.revision_id, "packageId": chunk.package_id,
               "index": chunk.index, "digest": chunk.digest}
    _save_receipt(conn, account_id, idempotency_key, digest,
                  "chunk", chunk.case_id, receipt)
    return receipt


def commit_manifest(conn: Connection, account_id: str, idempotency_key: str,
                    body: bytes, precondition: str | None) -> dict:
    _transaction(conn)
    account_id, idempotency_key = _id(account_id), _key(idempotency_key)
    manifest = _parse(parse_manifest, body, account_id)
    creating = precondition == "*"
    expected = _parse(parse_precondition, precondition, creating)
    used = _prune_expired(conn, account_id, _lock_account(conn, account_id))
    if _tombstoned(conn, account_id, manifest.case_id):
        raise StoreError("CASE_DELETED")
    digest = request_digest("POST", f"/v1/cases/{manifest.case_id}/revisions",
                            body, precondition)
    cached = _idempotent(conn, account_id, idempotency_key, digest,
                         "manifest", manifest.case_id)
    if cached is not None:
        return cached
    case = conn.execute("SELECT head_revision, deleted_at FROM scryer.cases "
                        "WHERE account_id=%s AND case_id=%s FOR UPDATE",
                        (account_id, manifest.case_id)).fetchone()
    if case is not None and case[1] is not None:
        raise StoreError("CASE_DELETED")
    if creating and case is not None or not creating and (case is None or case[0] != expected):
        raise StoreError("STALE_REVISION", 412)
    if conn.execute("SELECT 1 FROM scryer.case_revisions WHERE account_id=%s "
                    "AND case_id=%s AND revision_id=%s",
                    (account_id, manifest.case_id, manifest.revision_id)).fetchone():
        raise StoreError("REVISION_EXISTS")
    rows = conn.execute(
        "SELECT body, body_digest FROM scryer.staged_chunks WHERE account_id=%s "
        "AND case_id=%s AND revision_id=%s AND package_id=%s "
        "AND expires_at>now() ORDER BY chunk_index",
        (account_id, manifest.case_id, manifest.revision_id, manifest.package_id)
    ).fetchall()
    if len(rows) != manifest.chunk_count:
        raise StoreError("MISSING_CHUNK")
    chunks: list[ChunkRequest] = []
    for staged_body, stored_digest in rows:
        chunk = _parse(parse_chunk, staged_body, account_id)
        if chunk.digest != stored_digest:
            raise StoreError("CHUNK_MISMATCH")
        chunks.append(chunk)
    package = _parse(assemble_package, manifest, chunks)
    released = sum(len(row[0]) for row in rows)
    next_used = used - released + len(package)
    if next_used < 0:
        raise StoreError("CORRUPT_QUOTA", 500)
    if next_used > QUOTA:
        raise StoreError("QUOTA_EXCEEDED", 413)
    if creating:
        conn.execute("INSERT INTO scryer.cases(account_id,case_id) VALUES (%s,%s)",
                     (account_id, manifest.case_id))
    conn.execute("INSERT INTO scryer.case_revisions "
                 "(account_id,case_id,revision_id,parent_revision,ciphertext,package_digest,decoded_bytes) "
                 "VALUES (%s,%s,%s,%s,%s,%s,%s)",
                 (account_id, manifest.case_id, manifest.revision_id, expected,
                  package, manifest.package_digest,
                  sum(chunk.cipher_bytes + 28 for chunk in chunks)))
    conn.execute("UPDATE scryer.cases SET head_revision=%s, updated_at=clock_timestamp() "
                 "WHERE account_id=%s AND case_id=%s",
                 (manifest.revision_id, account_id, manifest.case_id))
    conn.execute("DELETE FROM scryer.staged_chunks WHERE account_id=%s AND case_id=%s "
                 "AND revision_id=%s AND package_id=%s",
                 (account_id, manifest.case_id, manifest.revision_id, manifest.package_id))
    conn.execute("UPDATE scryer.accounts SET used_bytes=%s WHERE account_id=%s",
                 (next_used, account_id))
    receipt = {"kind": "manifest", "caseId": manifest.case_id,
               "revisionId": manifest.revision_id, "packageDigest": manifest.package_digest,
               "etag": f'"{manifest.revision_id}"'}
    _save_receipt(conn, account_id, idempotency_key, digest,
                  "manifest", manifest.case_id, receipt)
    return receipt


def get_head(conn: Connection, account_id: str, case_id: str) -> Head | None:
    _transaction(conn)
    account_id, case_id = _id(account_id), _id(case_id)
    _lock_account(conn, account_id)
    case = conn.execute("SELECT head_revision, deleted_at FROM scryer.cases "
                        "WHERE account_id=%s AND case_id=%s",
                        (account_id, case_id)).fetchone()
    if case is None or case[1] is not None:
        return None
    if case[0] is None:
        raise StoreError("CORRUPT_RECORD", 500)
    row = conn.execute("SELECT package_digest, ciphertext FROM scryer.case_revisions "
                       "WHERE account_id=%s AND case_id=%s AND revision_id=%s",
                       (account_id, case_id, case[0])).fetchone()
    if row is None or hashlib.sha256(row[1]).hexdigest() != row[0]:
        raise StoreError("CORRUPT_RECORD", 500)
    return Head(case_id, case[0], row[0], row[1])


def get_revision(conn: Connection, account_id: str, case_id: str,
                 revision_id: str) -> Head | None:
    _transaction(conn)
    account_id, case_id, revision_id = _id(account_id), _id(case_id), _id(revision_id)
    _lock_account(conn, account_id)
    active = conn.execute("SELECT 1 FROM scryer.cases WHERE account_id=%s "
                          "AND case_id=%s AND deleted_at IS NULL",
                          (account_id, case_id)).fetchone()
    if active is None:
        return None
    row = conn.execute("SELECT package_digest, ciphertext FROM scryer.case_revisions "
                       "WHERE account_id=%s AND case_id=%s AND revision_id=%s",
                       (account_id, case_id, revision_id)).fetchone()
    if row is None:
        return None
    if hashlib.sha256(row[1]).hexdigest() != row[0]:
        raise StoreError("CORRUPT_RECORD", 500)
    return Head(case_id, revision_id, row[0], row[1])


def list_cases(conn: Connection, account_id: str, limit: int,
               after: tuple[datetime, str] | None = None) -> tuple[list[CaseSummary], bool]:
    _transaction(conn)
    account_id = _id(account_id)
    if type(limit) is not int or not 1 <= limit <= 200:
        raise StoreError("INVALID_LIMIT", 400)
    _lock_account(conn, account_id)
    query = ("SELECT c.case_id, c.head_revision, c.updated_at, "
             "EXISTS (SELECT 1 FROM scryer.case_revisions r WHERE "
             "r.account_id=c.account_id AND r.case_id=c.case_id AND "
             "r.revision_id=c.head_revision) FROM scryer.cases c "
             "WHERE c.account_id=%s AND c.deleted_at IS NULL ")
    parameters = [account_id]
    if after is not None:
        timestamp, case_id = after
        _id(case_id)
        query += "AND (c.updated_at, c.case_id) < (%s, %s) "
        parameters.extend((timestamp, case_id))
    query += "ORDER BY c.updated_at DESC, c.case_id DESC LIMIT %s"
    parameters.append(limit + 1)
    rows = conn.execute(query, parameters).fetchall()
    page = rows[:limit]
    if any(not head or not exists for _case_id, head, _updated, exists in page):
        raise StoreError("CORRUPT_RECORD", 500)
    return ([CaseSummary(*row[:3]) for row in page], len(rows) > limit)


def _stored_recovery(conn: Connection, account_id: str) -> StoredRecovery | None:
    row = conn.execute("SELECT generation, wrapper_digest, wrapper FROM "
                       "scryer.recovery_wrappers WHERE account_id=%s",
                       (account_id,)).fetchone()
    if row is None:
        return None
    if hashlib.sha256(row[2]).hexdigest() != row[1]:
        raise StoreError("CORRUPT_RECORD", 500)
    try:
        parse_recovery_wrapper(row[2], account_id)
    except ProtocolError:
        raise StoreError("CORRUPT_RECORD", 500) from None
    return StoredRecovery(*row)


def get_recovery_envelope(conn: Connection, account_id: str) -> StoredRecovery | None:
    _transaction(conn)
    account_id = _id(account_id)
    _lock_account(conn, account_id)
    return _stored_recovery(conn, account_id)


def put_recovery_envelope(conn: Connection, account_id: str, idempotency_key: str,
                          body: bytes, precondition: str | None) -> dict:
    _transaction(conn)
    account_id, idempotency_key = _id(account_id), _key(idempotency_key)
    parsed = _parse(parse_recovery_wrapper, body, account_id)
    creating = precondition == "*"
    expected = _parse(parse_generation_precondition, precondition, creating)
    _prune_expired(conn, account_id, _lock_account(conn, account_id))
    digest = request_digest("PUT", "/v1/account/recovery-envelope", body, precondition)
    cached = _idempotent(conn, account_id, idempotency_key, digest, "recovery", None)
    current = _stored_recovery(conn, account_id)
    if cached is not None:
        if current is None or current.generation != cached.get("generation") or \
                current.digest != cached.get("wrapperDigest"):
            raise StoreError("STALE_RECOVERY_ENVELOPE", 412)
        return cached
    if creating:
        if current is not None:
            raise StoreError("STALE_RECOVERY_ENVELOPE", 412)
        generation = 1
        conn.execute("INSERT INTO scryer.recovery_wrappers "
                     "(account_id,generation,wrapper,wrapper_digest) "
                     "VALUES (%s,%s,%s,%s)",
                     (account_id, generation, parsed.body, parsed.digest))
    else:
        if current is None or current.generation != expected:
            raise StoreError("STALE_RECOVERY_ENVELOPE", 412)
        # Switching this wrapper alone can strand cases under the old root.
        # M8 must atomically coordinate wrapper, encrypted heads, and devices.
        raise StoreError("RECOVERY_ROTATION_UNSUPPORTED")
    receipt = {"kind": "recovery", "generation": generation,
               "wrapperDigest": parsed.digest, "etag": f'"{generation}"'}
    _save_receipt(conn, account_id, idempotency_key, digest, "recovery", None, receipt)
    return receipt


def delete_case(conn: Connection, account_id: str, case_id: str,
                precondition: str | None, idempotency_key: str) -> dict:
    _transaction(conn)
    account_id, case_id, idempotency_key = _id(account_id), _id(case_id), _key(idempotency_key)
    expected = _parse(parse_precondition, precondition, False)
    used = _prune_expired(conn, account_id, _lock_account(conn, account_id))
    digest = request_digest("DELETE", f"/v1/cases/{case_id}", b"", precondition)
    cached = _idempotent(conn, account_id, idempotency_key, digest, "delete", case_id)
    if cached is not None:
        if not _tombstoned(conn, account_id, case_id):
            raise StoreError("CORRUPT_TOMBSTONE", 500)
        return cached
    if _tombstoned(conn, account_id, case_id):
        raise StoreError("CASE_DELETED")
    row = conn.execute("SELECT head_revision, deleted_at FROM scryer.cases "
                       "WHERE account_id=%s AND case_id=%s FOR UPDATE",
                       (account_id, case_id)).fetchone()
    if row is None:
        raise StoreError("CASE_NOT_FOUND", 404)
    if row[1] is not None:
        raise StoreError("CASE_DELETED")
    if row[0] != expected:
        raise StoreError("STALE_REVISION", 412)
    retained = conn.execute("SELECT coalesce(sum(octet_length(ciphertext)),0) "
                            "FROM scryer.case_revisions WHERE account_id=%s AND case_id=%s",
                            (account_id, case_id)).fetchone()[0]
    staged = conn.execute("SELECT coalesce(sum(octet_length(body)),0) "
                          "FROM scryer.staged_chunks WHERE account_id=%s AND case_id=%s",
                          (account_id, case_id)).fetchone()[0]
    if used < retained + staged:
        raise StoreError("CORRUPT_QUOTA", 500)
    conn.execute("DELETE FROM scryer.case_revisions WHERE account_id=%s AND case_id=%s",
                 (account_id, case_id))
    conn.execute("DELETE FROM scryer.staged_chunks WHERE account_id=%s AND case_id=%s",
                 (account_id, case_id))
    conn.execute("DELETE FROM scryer.idempotency WHERE account_id=%s AND case_id=%s",
                 (account_id, case_id))
    conn.execute("UPDATE scryer.cases SET deleted_at=now(), updated_at=now() "
                 "WHERE account_id=%s AND case_id=%s", (account_id, case_id))
    conn.execute("INSERT INTO scryer.case_tombstones(account_id,case_id,deleted_head) "
                 "VALUES (%s,%s,%s)", (account_id, case_id, expected))
    conn.execute("UPDATE scryer.accounts SET used_bytes=%s WHERE account_id=%s",
                 (used - retained - staged, account_id))
    receipt = {"kind": "delete", "caseId": case_id,
               "deletedHead": expected, "tombstone": True}
    _save_receipt(conn, account_id, idempotency_key, digest, "delete", case_id, receipt)
    return receipt


def delete_account(conn: Connection, account_id: str, idempotency_key: str,
                   confirmation: str) -> dict:
    """Deny access and remove all live account data in one tenant transaction."""
    _transaction(conn)
    account_id, idempotency_key = _id(account_id), _key(idempotency_key)
    if confirmation != account_id:
        raise StoreError("ACCOUNT_CONFIRMATION_MISMATCH", 412)
    digest = request_digest("DELETE", "/v1/account", b"", confirmation)
    outcome = conn.execute("SELECT scryer.begin_account_deletion(%s,%s,%s)",
                           (account_id, idempotency_key, digest)).fetchone()[0]
    receipt = {"kind": "account-deletion", "accountId": account_id,
               "status": "deleting"}
    if outcome in ("created", "retry"):
        return receipt
    if outcome == "conflict":
        raise StoreError("ACCOUNT_DELETION_CONFLICT")
    if outcome == "key-conflict":
        raise StoreError("IDEMPOTENCY_CONFLICT")
    if outcome == "stalled":
        raise StoreError("ACCOUNT_DELETION_STALLED", 503)
    if outcome == "disabled":
        raise StoreError("ACCOUNT_DISABLED", 403)
    if outcome == "missing":
        raise StoreError("ACCOUNT_UNAVAILABLE", 404)
    raise StoreError("ACCOUNT_DELETION_FAILURE", 500)
