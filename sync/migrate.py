"""Single transactional authority for PostgreSQL schema migrations."""

from __future__ import annotations

import hashlib
from pathlib import Path
import re

from psycopg import Connection


MIGRATION_NAME = re.compile(r"[0-9]{4}_[a-z0-9_]+\.sql\Z")


class MigrationError(RuntimeError):
    pass


def _files(directory: Path) -> list[tuple[str, str, str]]:
    if not directory.is_dir():
        raise MigrationError("MIGRATION_DIRECTORY_MISSING")
    files: list[tuple[str, str, str]] = []
    for path in sorted(directory.glob("*.sql")):
        if not MIGRATION_NAME.fullmatch(path.name) or path.is_symlink():
            raise MigrationError("INVALID_MIGRATION_NAME")
        raw = path.read_bytes()
        if not raw or len(raw) > 1024 * 1024:
            raise MigrationError("INVALID_MIGRATION_SIZE")
        files.append((path.name, hashlib.sha256(raw).hexdigest(), raw.decode("utf-8")))
    if not files or files[0][0] != "0001_sync.sql":
        raise MigrationError("MIGRATION_BASE_MISSING")
    versions = [name[:4] for name, _, _ in files]
    if len(versions) != len(set(versions)):
        raise MigrationError("DUPLICATE_MIGRATION_VERSION")
    return files


def apply_migrations(conn: Connection, directory: Path) -> list[str]:
    """Apply and checksum migrations; fail closed on edits or unknown DB versions.

    The caller must be a dedicated administrative/migration identity. The
    ordinary application role has no privileges on schema_migrations.
    """
    files = _files(directory)
    applied_now: list[str] = []
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(hashtext('scryer-sync-migrations-v1'))")
        initialized = conn.execute(
            "SELECT to_regclass('scryer_private.schema_migrations')"
        ).fetchone()[0] is not None
        if not initialized:
            name, checksum, sql = files[0]
            conn.execute(sql)
            conn.execute("CREATE TABLE scryer_private.schema_migrations ("
                         "filename text PRIMARY KEY, "
                         "checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'), "
                         "applied_at timestamptz NOT NULL DEFAULT now())")
            conn.execute("REVOKE ALL ON scryer_private.schema_migrations FROM PUBLIC")
            conn.execute("INSERT INTO scryer_private.schema_migrations "
                         "(filename, checksum) VALUES (%s, %s)", (name, checksum))
            applied_now.append(name)
        existing = dict(conn.execute(
            "SELECT filename, checksum FROM scryer_private.schema_migrations"
        ).fetchall())
        available = {name: checksum for name, checksum, _ in files}
        for name, checksum in existing.items():
            if name not in available:
                raise MigrationError("UNKNOWN_APPLIED_MIGRATION")
            if checksum != available[name]:
                raise MigrationError("CHECKSUM_MISMATCH")
        latest_applied = max(existing)
        for name, checksum, sql in files:
            if name in existing:
                continue
            if name <= latest_applied:
                raise MigrationError("OUT_OF_ORDER_MIGRATION")
            conn.execute(sql)
            conn.execute("INSERT INTO scryer_private.schema_migrations "
                         "(filename, checksum) VALUES (%s, %s)", (name, checksum))
            applied_now.append(name)
    return applied_now
