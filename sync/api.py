"""Fail-closed, versioned ciphertext HTTP boundary.

The factory requires a real verified-token implementation for production. There
is intentionally no default token parser or permissive development mode.
"""

from __future__ import annotations

from collections.abc import Callable
import re
import secrets
from typing import Literal

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from psycopg import Connection
import psycopg
from starlette.concurrency import run_in_threadpool

from .auth import TokenVerifier, VerifiedIdentity, derive_account_id
from .db_context import begin_tenant_transaction
from .pagination import CaseCursorCodec, CursorError
from .protocol import (CHUNK_BODY_BYTES, MANIFEST_BODY_BYTES, ID, ProtocolError,
                       parse_chunk, parse_manifest)
from .store import (StoreError, commit_manifest, delete_case, get_head,
                    get_revision, list_cases, stage_chunk)


HTTP_BODY_BYTES = 12 * 1024 * 1024
TOKEN_BYTES = 8192


class StrictWireModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ChunkWire(StrictWireModel):
    schemaVersion: Literal["1"]
    kind: Literal["chunk"]
    accountId: str
    caseId: str
    revisionId: str
    packageId: str
    index: int
    chunkCount: int
    nonce: str
    ciphertext: str
    tag: str


class ManifestWire(StrictWireModel):
    schemaVersion: Literal["1"]
    kind: Literal["manifest"]
    format: Literal["scryer-case-v1"]
    algorithm: Literal["AES-256-GCM+HKDF-SHA-256"]
    accountId: str
    caseId: str
    revisionId: str
    deviceId: str
    keyGeneration: int
    packageId: str
    chunkCount: int
    chunkDigests: list[str]
    packageDigest: str


class CipherChunk(StrictWireModel):
    index: int
    nonce: str
    ciphertext: str
    tag: str


class CipherPackage(StrictWireModel):
    schemaVersion: Literal["1"]
    format: Literal["scryer-case-v1"]
    algorithm: Literal["AES-256-GCM+HKDF-SHA-256"]
    accountId: str
    caseId: str
    revisionId: str
    deviceId: str
    keyGeneration: int
    packageId: str
    chunks: list[CipherChunk]


class AccountStatus(StrictWireModel):
    accountId: str
    status: Literal["active"]
    usedBytes: int
    quotaBytes: int
    capabilities: list[str]


class CaseListItem(StrictWireModel):
    caseId: str
    headRevisionId: str


class CaseListResponse(StrictWireModel):
    cases: list[CaseListItem]
    nextCursor: str | None


class ChunkReceipt(StrictWireModel):
    kind: Literal["chunk"]
    caseId: str
    revisionId: str
    packageId: str
    index: int
    digest: str


class ManifestReceipt(StrictWireModel):
    kind: Literal["manifest"]
    caseId: str
    revisionId: str
    packageDigest: str
    etag: str


class DeleteReceipt(StrictWireModel):
    kind: Literal["delete"]
    caseId: str
    deletedHead: str
    tombstone: Literal[True]


class ErrorDetail(StrictWireModel):
    code: str
    requestId: str


class ErrorEnvelope(StrictWireModel):
    error: ErrorDetail


ERROR_RESPONSES = {status: {"model": ErrorEnvelope} for status in
                   (400, 401, 403, 404, 409, 412, 413, 415, 428, 500, 503)}
IDEMPOTENCY_HEADER = {"name": "Idempotency-Key", "in": "header", "required": True,
                      "schema": {"type": "string", "minLength": 1, "maxLength": 160}}


def raw_json_body(model: type[BaseModel]) -> dict:
    # OpenAPI describes shape; runtime deliberately validates exact raw bytes.
    return {"requestBody": {"required": True, "content": {
        "application/json": {"schema": model.model_json_schema()}}},
        "parameters": [IDEMPOTENCY_HEADER]}


class ApiError(Exception):
    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.code = code
        self.status = status


def create_sync_app(*, connect: Callable[[], Connection], verifier: TokenVerifier,
                    context_key: bytes, account_key: bytes, issuer: str, audience: str,
                    allowed_origins: tuple[str, ...] = ()) -> FastAPI:
    """Construct a service only with explicit keys, database, and token verifier."""
    if not callable(connect) or verifier is None or not callable(getattr(verifier, "verify", None)):
        raise ValueError("VERIFIER_REQUIRED")
    if not isinstance(context_key, bytes) or len(context_key) != 32 or \
            not isinstance(account_key, bytes) or len(account_key) != 32 or \
            context_key == account_key:
        raise ValueError("INDEPENDENT_KEYS_REQUIRED")
    if not isinstance(issuer, str) or not issuer or \
            not isinstance(audience, str) or not audience:
        raise ValueError("IDENTITY_CONFIG_REQUIRED")
    if any(not origin.startswith(("https://", "http://127.0.0.1:", "http://localhost:"))
           for origin in allowed_origins):
        raise ValueError("INVALID_CORS_ORIGIN")
    cursor_codec = CaseCursorCodec(account_key)
    app = FastAPI(title="Scryer Ciphertext Sync API", version="1.0.0",
                  docs_url=None, redoc_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=list(allowed_origins),
                       allow_credentials=False, allow_methods=["GET", "POST", "DELETE"],
                       allow_headers=["Authorization", "Content-Type", "Idempotency-Key",
                                      "If-Match", "If-None-Match"],
                       expose_headers=["ETag", "Retry-After"], max_age=600)

    @app.middleware("http")
    async def safety_headers(request: Request, call_next):
        request.state.request_id = secrets.token_hex(8)
        response = await call_next(request)
        if request.url.path.startswith("/v1/"):
            response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    def error_response(request: Request, code: str, status: int) -> JSONResponse:
        return JSONResponse(status_code=status,
            content={"error": {"code": code, "requestId": request.state.request_id}},
            headers={"Cache-Control": "no-store"})

    @app.exception_handler(ApiError)
    async def api_error(request: Request, error: ApiError):
        return error_response(request, error.code, error.status)

    @app.exception_handler(StoreError)
    async def store_error(request: Request, error: StoreError):
        return error_response(request, error.code, error.status)

    @app.exception_handler(ProtocolError)
    async def protocol_error(request: Request, error: ProtocolError):
        return error_response(request, error.code, error.status)

    @app.exception_handler(psycopg.Error)
    async def database_error(request: Request, _error: psycopg.Error):
        return error_response(request, "STORAGE_UNAVAILABLE", 503)

    def identity(request: Request) -> VerifiedIdentity:
        if not getattr(verifier, "ready", False):
            raise ApiError("AUTH_UNAVAILABLE", 503)
        headers = request.headers.getlist("authorization")
        if len(headers) != 1 or not headers[0].startswith("Bearer "):
            raise ApiError("INVALID_TOKEN", 401)
        token = headers[0][7:]
        if not token or len(token) > TOKEN_BYTES or not re.fullmatch(r"[A-Za-z0-9._~-]+", token):
            raise ApiError("INVALID_TOKEN", 401)
        try:
            verified = verifier.verify(token)
        except Exception:
            raise ApiError("INVALID_TOKEN", 401) from None
        if not isinstance(verified, VerifiedIdentity) or verified.issuer != issuer or \
                verified.audience != audience:
            raise ApiError("INVALID_TOKEN", 401)
        try:
            derive_account_id(verified.issuer, verified.subject, account_key)
        except ValueError:
            raise ApiError("INVALID_TOKEN", 401) from None
        return verified

    def header_one(request: Request, name: str, *, required: bool = True) -> str | None:
        values = request.headers.getlist(name)
        if len(values) > 1 or (required and len(values) != 1):
            raise ApiError("INVALID_HEADER", 400)
        return values[0] if values else None

    def declared_length(request: Request) -> int | None:
        length = header_one(request, "content-length", required=False)
        if length is None:
            return None
        if not length.isascii() or not length.isdecimal():
            raise ApiError("INVALID_CONTENT_LENGTH", 400)
        if len(length) > 16:
            raise ApiError("CASE_TOO_LARGE", 413)
        return int(length)

    async def body(request: Request, limit: int) -> bytes:
        if header_one(request, "content-type") != "application/json":
            raise ApiError("INVALID_CONTENT_TYPE", 415)
        length = declared_length(request)
        if length is not None and length > min(limit, HTTP_BODY_BYTES):
            raise ApiError("CASE_TOO_LARGE", 413)
        chunks: list[bytes] = []
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > min(limit, HTTP_BODY_BYTES):
                raise ApiError("CASE_TOO_LARGE", 413)
            chunks.append(chunk)
        return b"".join(chunks)

    async def require_empty_body(request: Request) -> None:
        length = declared_length(request)
        if length is not None and length > HTTP_BODY_BYTES:
            raise ApiError("CASE_TOO_LARGE", 413)
        if length is not None and length > 0:
            raise ApiError("UNEXPECTED_BODY", 400)
        async for chunk in request.stream():
            if chunk:
                raise ApiError("UNEXPECTED_BODY", 400)

    def validated_case_id(value: str) -> str:
        if not ID.fullmatch(value):
            raise ApiError("INVALID_ID", 400)
        return value

    def tenant(verified: VerifiedIdentity, operation):
        account_id = derive_account_id(verified.issuer, verified.subject, account_key)
        with connect() as conn:
            with conn.transaction():
                begin_tenant_transaction(conn, account_id, context_key)
                conn.execute("INSERT INTO scryer.accounts "
                             "(account_id, identity_issuer, identity_subject) "
                             "VALUES (%s,%s,%s) ON CONFLICT (account_id) DO NOTHING",
                             (account_id, verified.issuer, verified.subject))
                row = conn.execute("SELECT identity_issuer, identity_subject, status, used_bytes "
                                   "FROM scryer.accounts WHERE account_id=%s FOR UPDATE",
                                   (account_id,)).fetchone()
                if row is None or row[:2] != (verified.issuer, verified.subject):
                    raise ApiError("ACCOUNT_UNAVAILABLE", 403)
                if row[2] != "active":
                    raise ApiError("ACCOUNT_DISABLED", 403)
                return operation(conn, account_id, row[3])

    @app.get("/health/live")
    def live():
        return {"status": "live"}

    @app.get("/health/ready", responses={503: {"model": ErrorEnvelope}})
    def ready(request: Request):
        if not getattr(verifier, "ready", False):
            return error_response(request, "AUTH_UNAVAILABLE", 503)
        try:
            with connect() as conn:
                with conn.transaction():
                    begin_tenant_transaction(conn, "readiness-probe", context_key)
                    if not conn.execute("SELECT scryer_private.tenant_ok('readiness-probe')").fetchone()[0]:
                        return error_response(request, "STORAGE_UNAVAILABLE", 503)
                    for table in ("accounts", "cases", "case_revisions", "staged_chunks",
                                  "idempotency", "recovery_wrappers", "devices", "case_tombstones"):
                        conn.execute(f"SELECT 1 FROM scryer.{table} LIMIT 0")
                    if not conn.execute("SELECT 1 FROM pg_constraint WHERE "
                        "conname='accounts_provider_identity_unique' AND "
                        "conrelid='scryer.accounts'::regclass").fetchone():
                        return error_response(request, "STORAGE_UNAVAILABLE", 503)
                    if conn.execute("SELECT to_regclass('scryer.cases_live_updated_keyset')") \
                            .fetchone()[0] is None:
                        return error_response(request, "STORAGE_UNAVAILABLE", 503)
        except psycopg.Error:
            return error_response(request, "STORAGE_UNAVAILABLE", 503)
        return {"status": "ready"}

    @app.get("/v1/account", response_model=AccountStatus, responses=ERROR_RESPONSES)
    def account(request: Request):
        verified = identity(request)
        return tenant(verified, lambda _conn, account_id, used:
                      {"accountId": account_id, "status": "active", "usedBytes": used,
                       "quotaBytes": 256 * 1024 * 1024,
                       "capabilities": ["ciphertext-sync-v1"]})

    @app.get("/v1/cases", response_model=CaseListResponse,
             responses=ERROR_RESPONSES,
             openapi_extra={"parameters": [
                 {"name": "limit", "in": "query", "required": False,
                  "schema": {"type": "integer", "minimum": 1, "maximum": 200,
                             "default": 50}},
                 {"name": "cursor", "in": "query", "required": False,
                  "schema": {"type": "string", "maxLength": 512}}
             ]})
    def cases(request: Request):
        verified = identity(request)
        params = list(request.query_params.multi_items())
        if any(key not in ("limit", "cursor") for key, _value in params) or \
                sum(key == "limit" for key, _value in params) > 1 or \
                sum(key == "cursor" for key, _value in params) > 1:
            raise ApiError("INVALID_QUERY", 400)
        raw_limit = request.query_params.get("limit", "50")
        if not re.fullmatch(r"[1-9][0-9]{0,2}", raw_limit) or int(raw_limit) > 200:
            raise ApiError("INVALID_LIMIT", 400)
        limit = int(raw_limit)
        account_id = derive_account_id(verified.issuer, verified.subject, account_key)
        raw_cursor = request.query_params.get("cursor")
        try:
            after = cursor_codec.decode(raw_cursor, account_id) if raw_cursor is not None else None
        except CursorError:
            raise ApiError("INVALID_CURSOR", 400) from None
        page, has_more = tenant(verified, lambda conn, account_id, _used:
                                list_cases(conn, account_id, limit, after))
        next_cursor = cursor_codec.encode(account_id, page[-1].updated_at,
                                          page[-1].case_id) if has_more else None
        return {"cases": [{"caseId": item.case_id,
                           "headRevisionId": item.head_revision_id} for item in page],
                "nextCursor": next_cursor}

    @app.post("/v1/cases/{case_id}/chunks", status_code=202,
              response_model=ChunkReceipt, responses=ERROR_RESPONSES,
              openapi_extra=raw_json_body(ChunkWire))
    async def chunks(request: Request, case_id: str):
        verified = identity(request)
        case_id = validated_case_id(case_id)
        key = header_one(request, "idempotency-key")
        raw = await body(request, CHUNK_BODY_BYTES)
        account_id = derive_account_id(verified.issuer, verified.subject, account_key)
        parsed = parse_chunk(raw, account_id)
        if parsed.case_id != case_id:
            raise ApiError("CASE_PATH_MISMATCH", 400)
        receipt = await run_in_threadpool(tenant, verified,
            lambda conn, account_id, _used: stage_chunk(conn, account_id, key, raw))
        return JSONResponse(status_code=202, content=receipt)

    @app.post("/v1/cases/{case_id}/revisions", status_code=201,
              response_model=ManifestReceipt,
              responses={**ERROR_RESPONSES, 200: {"model": ManifestReceipt}},
              openapi_extra=raw_json_body(ManifestWire))
    async def revisions(request: Request, case_id: str):
        verified = identity(request)
        case_id = validated_case_id(case_id)
        key = header_one(request, "idempotency-key")
        create_precondition = header_one(request, "if-none-match", required=False)
        update_precondition = header_one(request, "if-match", required=False)
        if create_precondition is not None and update_precondition is not None:
            raise ApiError("INVALID_PRECONDITION", 400)
        precondition = create_precondition if create_precondition is not None else update_precondition
        raw = await body(request, MANIFEST_BODY_BYTES)
        account_id = derive_account_id(verified.issuer, verified.subject, account_key)
        parsed = parse_manifest(raw, account_id)
        if parsed.case_id != case_id:
            raise ApiError("CASE_PATH_MISMATCH", 400)
        receipt = await run_in_threadpool(tenant, verified,
            lambda conn, account_id, _used:
                commit_manifest(conn, account_id, key, raw, precondition))
        return JSONResponse(status_code=201 if precondition == "*" else 200,
                            content=receipt, headers={"ETag": receipt["etag"]})

    @app.get("/v1/cases/{case_id}", response_class=Response,
             responses={200: {"model": CipherPackage}, **ERROR_RESPONSES})
    def head(request: Request, case_id: str):
        verified = identity(request)
        case_id = validated_case_id(case_id)
        found = tenant(verified, lambda conn, account_id, _used:
                       get_head(conn, account_id, case_id))
        if found is None:
            raise ApiError("CASE_NOT_FOUND", 404)
        return Response(content=found.ciphertext, media_type="application/json",
                        headers={"ETag": f'"{found.revision_id}"'})

    @app.get("/v1/cases/{case_id}/revisions/{revision_id}", response_class=Response,
             responses={200: {"model": CipherPackage}, **ERROR_RESPONSES})
    def historical_revision(request: Request, case_id: str, revision_id: str):
        verified = identity(request)
        case_id = validated_case_id(case_id)
        revision_id = validated_case_id(revision_id)
        found = tenant(verified, lambda conn, account_id, _used:
                       get_revision(conn, account_id, case_id, revision_id))
        if found is None:
            raise ApiError("CASE_NOT_FOUND", 404)
        return Response(content=found.ciphertext, media_type="application/json",
                        headers={"ETag": f'"{found.revision_id}"'})

    @app.delete("/v1/cases/{case_id}", response_model=DeleteReceipt,
                responses=ERROR_RESPONSES,
                openapi_extra={"parameters": [IDEMPOTENCY_HEADER]})
    async def delete(request: Request, case_id: str):
        verified = identity(request)
        case_id = validated_case_id(case_id)
        key = header_one(request, "idempotency-key")
        precondition = header_one(request, "if-match", required=False)
        await require_empty_body(request)
        return await run_in_threadpool(tenant, verified,
            lambda conn, account_id, _used:
                delete_case(conn, account_id, case_id, precondition, key))

    return app
