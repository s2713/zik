"""HTTP routes for the files service."""

import logging
import os
import uuid

import httpx
from mutagen import File as MutagenFile
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Route

from .db import LibraryDB
from .gvfs import gvfs_mount, gvfs_mount_path, gvfs_unmount
from .scanner import scan_directory
from .sources import Source, SourceManager

logger = logging.getLogger(__name__)

# ---- cover-art cache: track_id → (bytes, mime) | None ----
_cover_cache: dict[str, tuple[bytes, str] | None] = {}

# ---- artist-image cache: lowercase name → url | None ----
_artist_image_cache: dict[str, str | None] = {}


def _extract_cover(path: str) -> tuple[bytes, str] | None:
    """Extract embedded cover art from an audio file using mutagen."""
    try:
        f = MutagenFile(path)
        if f is None:
            return None
        tags = getattr(f, "tags", None) or {}
        # ID3 (MP3): APIC frames
        for key in tags:
            if key.startswith("APIC"):
                apic = tags[key]
                return bytes(apic.data), apic.mime or "image/jpeg"
        # Vorbis / FLAC: picture blocks
        pictures = getattr(f, "pictures", [])
        if pictures:
            pic = pictures[0]
            return bytes(pic.data), pic.mime or "image/jpeg"
        # MP4 / M4A: covr atom
        if "covr" in tags:
            data = tags["covr"][0]
            return bytes(data), "image/jpeg"
    except Exception:
        pass
    return None


async def _fetch_artist_image(name: str) -> str | None:
    """Query the Wikipedia pageimages API; return a thumbnail URL or None."""
    key = name.strip().lower()
    if key in _artist_image_cache:
        return _artist_image_cache[key]
    url = None
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(
                "https://en.wikipedia.org/w/api.php",
                params={
                    "action": "query",
                    "titles": name,
                    "prop": "pageimages",
                    "format": "json",
                    "pithumbsize": 200,
                    "pilimit": 1,
                },
            )
        pages = r.json().get("query", {}).get("pages", {})
        for page in pages.values():
            thumb = page.get("thumbnail", {})
            if thumb.get("source"):
                url = thumb["source"]
                break
    except Exception:
        pass
    _artist_image_cache[key] = url
    return url


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

    async def cover(request: Request) -> Response | JSONResponse:
        """Return embedded cover art for a track; cached in memory."""
        track_id = request.path_params["track_id"]
        if track_id not in _cover_cache:
            row = await db.get_track(track_id)
            if row is None:
                _cover_cache[track_id] = None
            else:
                _cover_cache[track_id] = _extract_cover(row["path"])
        result = _cover_cache[track_id]
        if result is None:
            return JSONResponse({"error": "no cover art"}, status_code=404)
        data, mime = result
        return Response(content=data, media_type=mime,
                        headers={"Cache-Control": "public, max-age=86400"})

    async def artist_image(request: Request) -> JSONResponse:
        """Return a Wikipedia thumbnail URL for an artist name."""
        name = request.query_params.get("name", "").strip()
        if not name:
            return JSONResponse({"error": "missing name"}, status_code=400)
        url = await _fetch_artist_image(name)
        if url is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        return JSONResponse({"url": url})

    async def list_sources(_request: Request) -> JSONResponse:
        """Return all configured sources with their mount status."""
        return JSONResponse([s.as_dict() for s in source_manager.list_all()])

    async def mount_source(request: Request) -> JSONResponse:
        """Mount a source; for SMB, runs gio mount first, then scans."""
        source_id = request.path_params["source_id"]
        source = source_manager.get(source_id)
        if source is None:
            return JSONResponse({"error": "unknown source"}, status_code=404)

        # SMB: call gvfs before checking root
        if source.kind == "smb":
            cfg = source.config
            ok, err = await gvfs_mount(
                cfg.get("server", ""),
                cfg.get("share", ""),
                cfg.get("username", ""),
                cfg.get("password", ""),
            )
            if not ok:
                logger.error("gvfs mount failed for %s: %s", source_id, err)
                return JSONResponse({"error": f"gvfs mount failed: {err}"}, status_code=503)
            source.root = gvfs_mount_path(
                cfg["server"], cfg["share"], cfg.get("subpath", "")
            )
            logger.info("gvfs mount ok; root=%s", source.root)

        source_manager.mount(source_id)
        if not source.root or not os.path.isdir(source.root):
            source_manager.unmount(source_id)
            logger.error("source root not accessible after mount: %s", source.root)
            return JSONResponse({"error": "source root not accessible"}, status_code=503)

        return JSONResponse(
            {"ok": True, "source": source.as_dict()},
            background=BackgroundTask(_scan_source, source),
        )

    async def unmount_source(request: Request) -> JSONResponse:
        """Unmount a source; for SMB, runs gio mount -u and removes its tracks."""
        source_id = request.path_params["source_id"]
        source = source_manager.get(source_id)
        if source is None:
            return JSONResponse({"error": "unknown source"}, status_code=404)

        if source.kind == "smb":
            cfg = source.config
            ok, err = await gvfs_unmount(cfg.get("server", ""), cfg.get("share", ""))
            if not ok:
                # log but don't fail — still clean up our state
                logger.warning("gvfs unmount failed for %s: %s", source_id, err)

        source_manager.unmount(source_id)
        await db.delete_by_source(source_id)
        return JSONResponse({"ok": True, "source": source.as_dict()})

    async def add_lan(request: Request) -> JSONResponse:
        """Add a new LAN source (SMB for now); persist to DB and register in memory."""
        body = await request.json()
        missing = [k for k in ("label", "server", "share") if not body.get(k)]
        if missing:
            return JSONResponse(
                {"error": f"missing fields: {', '.join(missing)}"}, status_code=400
            )
        source_id = str(uuid.uuid4())
        cfg = {
            "server": body["server"],
            "share": body["share"],
            "subpath": body.get("subpath", ""),
            "username": body.get("username", ""),
            "password": body.get("password", ""),
        }
        source = Source(
            id=source_id,
            label=body["label"],
            root="",  # filled in on first mount
            kind="smb",
            mounted=False,
            config=cfg,
        )
        source_manager.add_source(source)
        # persist: flatten config fields into the lan_sources row
        await db.add_lan_source({
            "id": source_id,
            "label": body["label"],
            "kind": "smb",
            "server": cfg["server"],
            "share": cfg["share"],
            "subpath": cfg["subpath"],
            "username": cfg["username"],
            "password": cfg["password"],
        })
        return JSONResponse({"ok": True, "source": source.as_dict()}, status_code=201)

    async def remove_lan(request: Request) -> JSONResponse:
        """Remove a LAN source; unmounts if mounted, deletes its tracks and DB row."""
        source_id = request.path_params["source_id"]
        source = source_manager.get(source_id)
        if source is None or source.kind != "smb":
            return JSONResponse({"error": "unknown LAN source"}, status_code=404)

        if source.mounted:
            cfg = source.config
            ok, err = await gvfs_unmount(cfg.get("server", ""), cfg.get("share", ""))
            if not ok:
                logger.warning("gvfs unmount on remove failed for %s: %s", source_id, err)

        source_manager.remove_source(source_id)
        await db.delete_by_source(source_id)
        await db.remove_lan_source(source_id)
        return JSONResponse({"ok": True})

    return [
        Route("/api/files/scan",                        scan,          methods=["POST"]),
        Route("/api/files/tracks",                      list_tracks),
        Route("/api/files/audio/{track_id}",            audio),
        Route("/api/files/cover/{track_id}",            cover),
        Route("/api/files/artist-image",                artist_image),
        Route("/api/files/sources",                     list_sources),
        Route("/api/files/sources/{source_id}/mount",   mount_source,  methods=["POST"]),
        Route("/api/files/sources/{source_id}/unmount", unmount_source, methods=["POST"]),
        Route("/api/files/lan",                         add_lan,       methods=["POST"]),
        Route("/api/files/lan/{source_id}",             remove_lan,    methods=["DELETE"]),
    ]
