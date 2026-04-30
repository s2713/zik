"""HTTP routes for the MPD service."""

import logging

from mpd.base import CommandError
from mpd.base import ConnectionError as MPDConnectionError
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from ..files.db import LibraryDB
from .client import MpdProxy

logger = logging.getLogger(__name__)

_MPD_HOST_KEY   = "mpd.host"
_MPD_PORT_KEY   = "mpd.port"
_MPD_PASS_KEY   = "mpd.password"
_MPD_STREAM_KEY = "mpd.stream_url"


def make_mpd_router(proxy: MpdProxy, db: LibraryDB) -> list:
    """Return Starlette Route objects; proxy and db captured by closure."""

    async def connect(request: Request) -> JSONResponse:
        """Connect to an MPD server and persist the config."""
        body = await request.json()
        host = body.get("host", "").strip()
        port = int(body.get("port", 6600))
        password = body.get("password", "")
        stream_url = body.get("stream_url", "").strip()
        if not host:
            return JSONResponse({"error": "host is required"}, status_code=400)
        # stream_url is optional: if provided, audio plays on the device;
        # if absent, audio plays on the remote MPD server (server admin's concern).
        if stream_url and not stream_url.startswith(("http://", "https://")):
            return JSONResponse(
                {"error": "stream_url must start with http:// or https://"},
                status_code=422,
            )
        try:
            await proxy.connect(host, port, password, stream_url)
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        # Persist so the backend can reconnect after restart.
        await db.set_setting(_MPD_HOST_KEY, host)
        await db.set_setting(_MPD_PORT_KEY, str(port))
        await db.set_setting(_MPD_PASS_KEY, password)
        await db.set_setting(_MPD_STREAM_KEY, stream_url)
        try:
            st = await proxy.status()
            cs = await proxy.currentsong()
        except Exception as exc:
            # Connection dropped right after connect — report failure rather than lying.
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
        return JSONResponse({
            "connected": True,
            "host": proxy.host,
            "port": proxy.port,
            "password": proxy.password,
            "stream_url": proxy.stream_url,
            "status": st,
            "currentsong": cs,
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
        Route("/api/mpd/connect",    connect,     methods=["POST"]),
        Route("/api/mpd/disconnect", disconnect,  methods=["POST"]),
        Route("/api/mpd/status",     status),
        Route("/api/mpd/library",    library),
        Route("/api/mpd/command",    mpd_command, methods=["POST"]),
    ]
