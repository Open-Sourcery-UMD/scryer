"""Transaction-local tenant capability for PostgreSQL RLS.

The service supplies this only after verifying an OIDC token and checking the
account lifecycle. A caller who can issue SQL but lacks the 32-byte context
key cannot forge a different tenant by changing PostgreSQL custom settings.
"""

from __future__ import annotations

import hashlib
import hmac
import re

from psycopg import Connection
from psycopg.pq import TransactionStatus


ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")


def begin_tenant_transaction(conn: Connection, account_id: str,
                             context_key: bytes) -> None:
    if not isinstance(account_id, str) or not ID.fullmatch(account_id):
        raise ValueError("INVALID_ACCOUNT_ID")
    if not isinstance(context_key, bytes) or len(context_key) != 32:
        raise ValueError("INVALID_CONTEXT_KEY")
    if conn.info.transaction_status != TransactionStatus.INTRANS:
        raise RuntimeError("TENANT_TRANSACTION_REQUIRED")
    txid = str(conn.execute("SELECT txid_current()").fetchone()[0])
    signature = hmac.new(context_key, f"{account_id}\n{txid}".encode("ascii"),
                         hashlib.sha256).hexdigest()
    conn.execute("SELECT set_config('scryer.account_id', %s, true)", (account_id,))
    conn.execute("SELECT set_config('scryer.txid', %s, true)", (txid,))
    conn.execute("SELECT set_config('scryer.signature', %s, true)", (signature,))
