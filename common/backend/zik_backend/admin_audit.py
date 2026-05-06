"""Admin API — append-only in-memory audit log (Target 1 demo).

In production (Target 2+) entries would be written to a persistent DB table
with a 90-day TTL enforced by a background job.  Here we keep the last 1 000
entries in a deque.  The log is write-only from the individual action handlers
and read-only from the GET endpoint.
"""

import time
from collections import deque
from dataclasses import asdict, dataclass

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route


@dataclass
class AuditEntry:
    """Single immutable audit-log record."""
    timestamp: float   # Unix epoch (seconds)
    actor:     str     # "admin" or a username
    action:    str     # machine-readable event name (e.g. "user-create")
    detail:    str     # human-readable context (e.g. the affected username)


class AuditLog:
    """Thread-safe in-memory circular log."""
    def __init__(self, maxlen: int = 1000) -> None:
        self._entries: deque[AuditEntry] = deque(maxlen=maxlen)

    def add(self, actor: str, action: str, detail: str = "") -> None:
        """Append a new entry stamped with the current wall-clock time."""
        self._entries.append(AuditEntry(
            timestamp=time.time(), actor=actor, action=action, detail=detail,
        ))

    def entries(self, limit: int = 100) -> list[dict]:
        """Return up to *limit* entries, newest first."""
        rows = list(self._entries)
        rows.reverse()
        return [asdict(e) for e in rows[:limit]]


def make_audit_store() -> AuditLog:
    """Return a fresh empty audit log."""
    return AuditLog()


def make_admin_audit_router(sessions: dict, log: AuditLog) -> list:
    """Return Starlette Route list for the audit-log read endpoint."""

    def _require_admin(request: Request) -> dict | None:
        """Return the session dict if the caller is an authenticated admin, else None."""
        sid = request.cookies.get("__Host-zik-session")
        if not sid or sid not in sessions:
            return None
        s = sessions[sid]
        return s if s.get("is_admin") else None

    async def get_audit(request: Request) -> JSONResponse:
        """Return the most recent audit entries (admin only)."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        limit = min(int(request.query_params.get("limit", "200")), 500)
        return JSONResponse({"entries": log.entries(limit)})

    return [
        Route("/api/admin/audit", get_audit, methods=["GET"]),
    ]
