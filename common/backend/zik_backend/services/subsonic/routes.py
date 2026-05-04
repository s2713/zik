"""HTTP routes for the Subsonic service."""

import logging

import httpx
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from ..files.db import LibraryDB
from .client import SubsonicError, SubsonicProxy

logger = logging.getLogger(__name__)

_SUB_SERVER_KEY = "subsonic.server"
_SUB_USER_KEY   = "subsonic.user"
_SUB_PASS_KEY   = "subsonic.password"

_AUTH_FIELDS = ("v", "1.16.1", "c", "zik")  # constant query params for stream URLs


def make_subsonic_router(proxy: SubsonicProxy, db: LibraryDB) -> list:
    """Return Starlette Route objects; proxy and db captured by closure."""

    async def connect(request: Request) -> JSONResponse:
        """Connect to a Subsonic server and persist the config."""
        body = await request.json()
        server = body.get("server", "").strip().rstrip("/")
        user   = body.get("user",   "").strip()
        password = body.get("password", "")
        if not server:
            return JSONResponse({"error": "server is required"}, status_code=400)
        if not user:
            return JSONResponse({"error": "user is required"}, status_code=400)
        try:
            await proxy.connect(server, user, password)
        except (SubsonicError, httpx.HTTPError, OSError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        await db.set_setting(_SUB_SERVER_KEY, server)
        await db.set_setting(_SUB_USER_KEY,   user)
        await db.set_setting(_SUB_PASS_KEY,   password)
        return JSONResponse({
            "ok": True, "connected": True,
            "server": proxy.server, "user": proxy.user,
            "token": proxy.token, "salt": proxy.salt,
        })

    async def disconnect(_request: Request) -> JSONResponse:
        """Disconnect from the Subsonic server."""
        await proxy.disconnect()
        return JSONResponse({"ok": True, "connected": False})

    async def status(_request: Request) -> JSONResponse:
        """Return connection state and auth info needed to build stream URLs."""
        if not proxy.connected:
            return JSONResponse({
                "connected": False,
                "server": "", "user": "", "token": "", "salt": "",
            })
        return JSONResponse({
            "connected": True,
            "server": proxy.server,
            "user":   proxy.user,
            "token":  proxy.token,
            "salt":   proxy.salt,
        })

    async def library(_request: Request) -> JSONResponse:
        """Return the full song library as a JSON array."""
        if not proxy.connected:
            return JSONResponse({"error": "not connected"}, status_code=503)
        try:
            tracks = await proxy.library()
        except (SubsonicError, httpx.HTTPError, OSError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        logger.info("subsonic: library route returned %d tracks", len(tracks))
        return JSONResponse(tracks)

    return [
        Route("/api/subsonic/connect",    connect,    methods=["POST"]),
        Route("/api/subsonic/disconnect", disconnect, methods=["POST"]),
        Route("/api/subsonic/status",     status),
        Route("/api/subsonic/library",    library),
    ]
