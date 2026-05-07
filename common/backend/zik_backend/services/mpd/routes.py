"""HTTP routes for the MPD service."""

import asyncio
import json
import logging
import time
import uuid

from mpd.base import CommandError
from mpd.base import ConnectionError as MPDConnectionError
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from ..files.db import LibraryDB
from .client import MpdProxy

logger = logging.getLogger(__name__)

_SOURCES_KEY    = "mpd.sources"        # JSON array of source objects
_ACTIVE_KEY     = "mpd.active_source"  # id of the currently connected source


# ---- helpers ----

async def _load_sources(db: LibraryDB) -> list[dict]:
    """Return saved source list from DB (empty list if none saved)."""
    raw = await db.get_setting(_SOURCES_KEY)
    if not raw:
        return []
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return []


async def _save_sources(db: LibraryDB, sources: list[dict]) -> None:
    """Persist source list to DB."""
    await db.set_setting(_SOURCES_KEY, json.dumps(sources))


async def _ping_source(host: str, port: int, timeout: float = 3.0) -> float | None:
    """Open a TCP connection to host:port, return latency in ms or None on failure."""
    t0 = time.monotonic()
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=timeout
        )
        ms = (time.monotonic() - t0) * 1000
        writer.close()
        with asyncio.timeout(1.0):
            await writer.wait_closed()
        return ms
    except Exception:
        return None


def make_mpd_router(proxy: MpdProxy, db: LibraryDB) -> list:
    """Return Starlette Route objects; proxy and db captured by closure."""

    # ---- source management ----

    async def sources_list(_request: Request) -> JSONResponse:
        """List all saved MPD source profiles."""
        sources = await _load_sources(db)
        active_id = await db.get_setting(_ACTIVE_KEY) or ""
        # Annotate which source is currently connected.
        for s in sources:
            s["active"] = (s["id"] == active_id and proxy.connected)
        return JSONResponse(sources)

    async def sources_create(request: Request) -> JSONResponse:
        """Add a new MPD source profile."""
        body = await request.json()
        source = {
            "id":         str(uuid.uuid4()),
            "label":      body.get("label", "MPD").strip() or "MPD",
            "host":       body.get("host", "localhost").strip(),
            "port":       int(body.get("port", 6600)),
            "password":   body.get("password", ""),
            "stream_url": body.get("stream_url", "").strip(),
        }
        sources = await _load_sources(db)
        sources.append(source)
        await _save_sources(db, sources)
        return JSONResponse(source, status_code=201)

    async def sources_update(request: Request) -> JSONResponse:
        """Update a source profile by id."""
        sid = request.path_params["id"]
        body = await request.json()
        sources = await _load_sources(db)
        for s in sources:
            if s["id"] == sid:
                if "label"      in body: s["label"]      = str(body["label"]).strip() or s["label"]
                if "host"       in body: s["host"]        = str(body["host"]).strip()
                if "port"       in body: s["port"]        = int(body["port"])
                if "password"   in body: s["password"]    = str(body["password"])
                if "stream_url" in body: s["stream_url"]  = str(body["stream_url"]).strip()
                await _save_sources(db, sources)
                return JSONResponse(s)
        return JSONResponse({"error": "not found"}, status_code=404)

    async def sources_delete(request: Request) -> JSONResponse:
        """Delete a source profile; disconnects if it was active."""
        sid = request.path_params["id"]
        sources = await _load_sources(db)
        sources = [s for s in sources if s["id"] != sid]
        await _save_sources(db, sources)
        active_id = await db.get_setting(_ACTIVE_KEY) or ""
        if active_id == sid:
            await proxy.disconnect()
            await db.set_setting(_ACTIVE_KEY, "")
        return JSONResponse({"ok": True})

    async def sources_activate(request: Request) -> JSONResponse:
        """Connect to the source with the given id."""
        sid = request.path_params["id"]
        sources = await _load_sources(db)
        source = next((s for s in sources if s["id"] == sid), None)
        if source is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        try:
            await proxy.connect(
                source["host"], source["port"],
                source.get("password", ""), source.get("stream_url", ""),
            )
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        await db.set_setting(_ACTIVE_KEY, sid)
        try:
            st = await proxy.status()
            cs = await proxy.currentsong()
        except Exception as exc:
            logger.warning("mpd: post-connect probe failed: %s", exc)
            return JSONResponse({"error": str(exc)}, status_code=503)
        return JSONResponse({
            "ok": True, "connected": True,
            "stream_url": source.get("stream_url", ""),
            "status": st, "currentsong": cs,
        })

    async def sources_ping(request: Request) -> JSONResponse:
        """TCP-ping a source; does not change proxy state."""
        sid = request.path_params["id"]
        sources = await _load_sources(db)
        source = next((s for s in sources if s["id"] == sid), None)
        if source is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        ms = await _ping_source(source["host"], source["port"])
        return JSONResponse({"reachable": ms is not None, "ms": ms})

    # ---- legacy single-connection endpoints (kept for compatibility) ----

    async def connect(request: Request) -> JSONResponse:
        """Connect to an MPD server (legacy; creates a temporary source profile)."""
        body = await request.json()
        host       = body.get("host", "").strip()
        port       = int(body.get("port", 6600))
        password   = body.get("password", "")
        stream_url = body.get("stream_url", "").strip()
        if not host:
            return JSONResponse({"error": "host is required"}, status_code=400)
        if stream_url and not stream_url.startswith(("http://", "https://")):
            return JSONResponse(
                {"error": "stream_url must start with http:// or https://"},
                status_code=422,
            )
        try:
            await proxy.connect(host, port, password, stream_url)
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        try:
            st = await proxy.status()
            cs = await proxy.currentsong()
        except Exception as exc:
            logger.warning("mpd: post-connect probe failed: %s", exc)
            return JSONResponse({"error": str(exc)}, status_code=503)
        return JSONResponse({
            "ok": True, "connected": True,
            "stream_url": stream_url,
            "status": st, "currentsong": cs,
        })

    async def disconnect(_request: Request) -> JSONResponse:
        """Disconnect from MPD."""
        await proxy.disconnect()
        await db.set_setting(_ACTIVE_KEY, "")
        return JSONResponse({"ok": True, "connected": False})

    async def status(_request: Request) -> JSONResponse:
        """Return MPD connection state, playback status, current song, and stream URL."""
        _disc = {"connected": False, "stream_url": "", "status": {}, "currentsong": {}}
        if not proxy.connected:
            return JSONResponse(_disc)
        try:
            st = await proxy.status()
            cs = await proxy.currentsong()
        except (MPDConnectionError, OSError):
            return JSONResponse(_disc)
        active_id = await db.get_setting(_ACTIVE_KEY) or ""
        return JSONResponse({
            "connected":    True,
            "active_id":    active_id,
            "host":         proxy.host,
            "port":         proxy.port,
            "password":     proxy.password,
            "stream_url":   proxy.stream_url,
            "status":       st,
            "currentsong":  cs,
        })

    async def library(_request: Request) -> JSONResponse:
        """Return the full MPD library as a JSON array."""
        if not proxy.connected:
            return JSONResponse({"error": "not connected"}, status_code=503)
        try:
            tracks = await proxy.library()
        except (MPDConnectionError, CommandError, OSError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        logger.info("mpd: library returned %d tracks", len(tracks))
        return JSONResponse(tracks)

    async def mpd_command(request: Request) -> JSONResponse:
        """Execute a playback command (Play, Pause, Stop, Next, Previous, Seek, SetVolume)."""
        if not proxy.connected:
            return JSONResponse({"error": "not connected"}, status_code=503)
        body = await request.json()
        cmd_type = body.get("type", "")
        try:
            if cmd_type == "PlayUri":
                await proxy.play_uri(body.get("uri", ""))
            else:
                await proxy.command(cmd_type, **{k: v for k, v in body.items() if k != "type"})
        except (MPDConnectionError, CommandError, OSError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        return JSONResponse({"ok": True})

    return [
        # source management
        Route("/api/mpd/sources",              sources_list,     methods=["GET"]),
        Route("/api/mpd/sources",              sources_create,   methods=["POST"]),
        Route("/api/mpd/sources/{id}",         sources_update,   methods=["PUT"]),
        Route("/api/mpd/sources/{id}",         sources_delete,   methods=["DELETE"]),
        Route("/api/mpd/sources/{id}/activate", sources_activate, methods=["POST"]),
        Route("/api/mpd/sources/{id}/ping",    sources_ping,     methods=["GET"]),
        # playback + status (unchanged)
        Route("/api/mpd/connect",    connect,     methods=["POST"]),
        Route("/api/mpd/disconnect", disconnect,  methods=["POST"]),
        Route("/api/mpd/status",     status),
        Route("/api/mpd/library",    library),
        Route("/api/mpd/command",    mpd_command, methods=["POST"]),
    ]
