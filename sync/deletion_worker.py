"""Least-privilege provider deletion reconciliation.

The supplied connection must use a login that inherits only ``scryer_worker``.
The provider adapter owns its own bounded network timeout and authentication.
No SQL transaction is held while contacting the provider.
"""

from __future__ import annotations

from collections.abc import Callable
import math
import secrets
from typing import Protocol

from psycopg import Connection


class ProviderNotFound(Exception):
    """The identity provider has already removed this user."""


class IdentityProvider(Protocol):
    max_duration_seconds: float

    def delete_user(self, issuer: str, subject: str) -> None: ...


def run_once(connect: Callable[[], Connection], provider: IdentityProvider) -> str:
    """Attempt at most one due job; return a bounded, non-identifying result."""
    if not callable(connect) or not callable(getattr(provider, "delete_user", None)):
        raise ValueError("DELETION_WORKER_CONFIG_REQUIRED")
    duration = getattr(provider, "max_duration_seconds", None)
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or \
            not math.isfinite(duration) or not 0 < duration <= 30:
        raise ValueError("PROVIDER_TIMEOUT_REQUIRED")

    with connect() as conn:
        with conn.transaction():
            row = conn.execute(
                "SELECT account_id, identity_issuer, identity_subject, attempts "
                "FROM scryer.deletion_jobs "
                "WHERE state IN ('pending','retry') "
                "AND next_attempt_at <= clock_timestamp() "
                "AND (lease_until IS NULL OR lease_until <= clock_timestamp()) "
                "ORDER BY next_attempt_at, account_id "
                "FOR UPDATE SKIP LOCKED LIMIT 1"
            ).fetchone()
            if row is None:
                return "idle"
            account_id, issuer, subject, prior_attempts = row
            if prior_attempts >= 20:
                conn.execute("UPDATE scryer.deletion_jobs "
                             "SET state='failed', lease_token=NULL, lease_until=NULL "
                             "WHERE account_id=%s", (account_id,))
                return "failed"
            lease = secrets.token_urlsafe(16)
            conn.execute("UPDATE scryer.deletion_jobs "
                         "SET lease_token=%s, "
                         "lease_until=clock_timestamp()+interval '60 seconds' "
                         "WHERE account_id=%s", (lease, account_id))

    try:
        provider.delete_user(issuer, subject)
    except ProviderNotFound:
        pass
    except Exception:
        with connect() as conn:
            with conn.transaction():
                failures = prior_attempts + 1
                state = "failed" if failures >= 20 else "retry"
                delay = min(2 ** min(failures - 1, 12), 3600)
                updated = conn.execute(
                    "UPDATE scryer.deletion_jobs SET state=%s, attempts=%s, "
                    "next_attempt_at=clock_timestamp()+(%s * interval '1 second'), "
                    "lease_token=NULL, lease_until=NULL "
                    "WHERE account_id=%s AND lease_token=%s",
                    (state, failures, delay, account_id, lease)).rowcount
                return state if updated else "lost-lease"

    with connect() as conn:
        with conn.transaction():
            job = conn.execute("SELECT identity_issuer, identity_subject, lease_token "
                               "FROM scryer.deletion_jobs WHERE account_id=%s FOR UPDATE",
                               (account_id,)).fetchone()
            if job is None or job != (issuer, subject, lease):
                return "lost-lease"
            updated = conn.execute(
                "UPDATE scryer.accounts SET status='deleted', "
                "identity_issuer=NULL, identity_subject=NULL, "
                "updated_at=clock_timestamp() "
                "WHERE account_id=%s AND status='deleting'", (account_id,)
            ).rowcount
            if updated != 1:
                raise RuntimeError("DELETION_ACCOUNT_STATE_CONFLICT")
            conn.execute("DELETE FROM scryer.deletion_jobs WHERE account_id=%s",
                         (account_id,))
    return "complete"
