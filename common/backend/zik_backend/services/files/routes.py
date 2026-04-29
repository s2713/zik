"""HTTP routes for the files service."""

import logging
import os

from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse

from .db import LibraryDB
from .scanner import scan_directory

logger = logging.getLogger(__name__)


def make_files_router(db: LibraryDB, root: str) -> list:
    """Return Starlette Route objects; db and root captured by closure."""

    async def _do_scan() -> None:
        """Background task: walk root, upsert tracks, drop stale rows."""
        logger.info("files scan started: root=%s", root)
        live: set[str] = set()
        count = 0
        for row in scan_directory(root):
            await db.upsert_track(row)
            live.add(row["id"])
            count += 1
        await db.delete_stale(live)
        logger.info("files scan done: %d tracks", count)

    async def scan(request: Request) -> JSONResponse:
        """Trigger a library rescan in the background."""
        if not root or not os.path.isdir(root):
            return JSONResponse(
                {"error": "ZIK_FILES_ROOT not set or not a directory"}, status_code=503
            )
        return JSONResponse({"ok": True}, background=BackgroundTask(_do_scan))

    async def list_tracks(request: Request) -> JSONResponse:
        """Return the library as a JSON array, sorted by the `sort` query param."""
        sort = request.query_params.get("sort", "artist")
        tracks = await db.list_tracks(sort)
        return JSONResponse(tracks)

    async def audio(request: Request) -> FileResponse | JSONResponse:
        """Stream an audio file by track id."""
        track_id = request.path_params["track_id"]
        row = await db.get_track(track_id)
        if row is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        path = row["path"]
        if not os.path.isfile(path):
            return JSONResponse({"error": "file missing"}, status_code=404)
        return FileResponse(path)

    # Import here to avoid circular dependency at module level.
    from starlette.routing import Route
    return [
        Route("/api/files/scan", scan, methods=["POST"]),
        Route("/api/files/tracks", list_tracks),
        Route("/api/files/audio/{track_id}", audio),
    ]
