"""HTTP routes for the Quota service.

Reports and configures the per-user offline storage limit.
Usage is measured by walking the offline directory; the limit is stored in the
settings DB. In production this endpoint will be admin-gated; the demo leaves
it open.
"""

from pathlib import Path

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from zik_backend.services.files.db import LibraryDB
from zik_backend.storage.quota import DEFAULT_LIMIT, QUOTA_KEY, disk_usage


def make_quota_router(db: LibraryDB, offline_dir: Path) -> list:
    """Return Starlette Route objects for the quota service."""

    async def get_quota(_request: Request) -> JSONResponse:
        """Return current disk usage and configured limit (bytes)."""
        raw = await db.get_setting(QUOTA_KEY)
        limit = int(raw) if raw else DEFAULT_LIMIT
        used = disk_usage(offline_dir)
        return JSONResponse({"used_bytes": used, "limit_bytes": limit})

    async def set_quota(request: Request) -> JSONResponse:
        """Set the offline storage limit in bytes (0 = unlimited)."""
        body = await request.json()
        limit = body.get("limit_bytes")
        if limit is None or not isinstance(limit, int) or limit < 0:
            return JSONResponse(
                {"error": "limit_bytes (non-negative int) required"}, status_code=400
            )
        await db.set_setting(QUOTA_KEY, str(limit))
        return JSONResponse({"ok": True})

    return [
        Route("/api/quota", get_quota),
        Route("/api/quota", set_quota, methods=["POST"]),
    ]
