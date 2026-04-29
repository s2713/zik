"""HTTP routes for the files service."""

import logging
import os

from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Route

from .db import LibraryDB
from .scanner import scan_directory
from .sources import Source, SourceManager

logger = logging.getLogger(__name__)


def make_files_router(db: LibraryDB, source_manager: SourceManager) -> list:
    """Return Starlette Route objects; db and source_manager captured by closure."""

    async def _scan_source(source: Source) -> None:
        """Scan one mounted source and update the library index for it."""
        logger.info("files scan started: source=%s root=%s", source.id, source.root)
        live: set[str] = set()
        count = 0
        for row in scan_directory(source.root):
            row["source_id"] = source.id
            await db.upsert_track(row)
            live.add(row["id"])
            count += 1
        await db.delete_stale_for_source(source.id, live)
        logger.info("files scan done: source=%s %d tracks", source.id, count)

    async def scan(request: Request) -> JSONResponse:
        """Trigger a rescan of all currently mounted sources."""
        mounted = [
            s for s in source_manager.list_all()
            if s.mounted and s.root and os.path.isdir(s.root)
        ]
        if not mounted:
            return JSONResponse(
                {"error": "no mounted sources with a valid directory"}, status_code=503
            )

        async def _do_all() -> None:
            for source in mounted:
                await _scan_source(source)

        return JSONResponse({"ok": True}, background=BackgroundTask(_do_all))

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

    async def list_sources(_request: Request) -> JSONResponse:
        """Return all configured sources with their mount status."""
        return JSONResponse([s.as_dict() for s in source_manager.list_all()])

    async def mount_source(request: Request) -> JSONResponse:
        """Mount a source and trigger a background scan of it."""
        source_id = request.path_params["source_id"]
        source = source_manager.mount(source_id)
        if source is None:
            return JSONResponse({"error": "unknown source"}, status_code=404)
        if not source.root or not os.path.isdir(source.root):
            source_manager.unmount(source_id)  # revert
            return JSONResponse({"error": "source root not accessible"}, status_code=503)
        return JSONResponse(
            {"ok": True, "source": source.as_dict()},
            background=BackgroundTask(_scan_source, source),
        )

    async def unmount_source(request: Request) -> JSONResponse:
        """Unmount a source and remove its tracks from the library."""
        source_id = request.path_params["source_id"]
        source = source_manager.unmount(source_id)
        if source is None:
            return JSONResponse({"error": "unknown source"}, status_code=404)
        await db.delete_by_source(source_id)
        return JSONResponse({"ok": True, "source": source.as_dict()})

    return [
        Route("/api/files/scan", scan, methods=["POST"]),
        Route("/api/files/tracks", list_tracks),
        Route("/api/files/audio/{track_id}", audio),
        Route("/api/files/sources", list_sources),
        Route("/api/files/sources/{source_id}/mount", mount_source, methods=["POST"]),
        Route("/api/files/sources/{source_id}/unmount", unmount_source, methods=["POST"]),
    ]
