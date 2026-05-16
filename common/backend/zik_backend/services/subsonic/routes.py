"""HTTP routes for the Subsonic service."""

import json
import logging
import uuid

import httpx
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from ..files.db import LibraryDB
from .client import SubsonicError, SubsonicProxy

logger = logging.getLogger(__name__)

_SOURCES_KEY = "subsonic.sources"       # JSON array of source objects
_ACTIVE_KEY  = "subsonic.active_source" # id of the currently connected source


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


def make_subsonic_router(proxy: SubsonicProxy, db: LibraryDB) -> list:
    """Return Starlette Route objects; proxy and db captured by closure."""

    # ---- source management ----

    async def sources_list(_request: Request) -> JSONResponse:
        """List all saved Subsonic account profiles."""
        sources = await _load_sources(db)
        active_id = await db.get_setting(_ACTIVE_KEY) or ""
        for s in sources:
            s["active"] = (s["id"] == active_id and proxy.connected)
        return JSONResponse(sources)

    async def sources_create(request: Request) -> JSONResponse:
        """Add a new Subsonic account profile."""
        body = await request.json()
        source = {
            "id":       str(uuid.uuid4()),
            "label":    body.get("label", "Subsonic").strip() or "Subsonic",
            "server":   body.get("server", "").strip().rstrip("/"),
            "user":     body.get("user",   "").strip(),
            "password": body.get("password", ""),
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
                if "label" in body:
                    s["label"] = str(body["label"]).strip() or s["label"]
                if "server" in body:
                    s["server"] = str(body["server"]).strip().rstrip("/")
                if "user" in body:
                    s["user"] = str(body["user"]).strip()
                if "password" in body:
                    s["password"] = str(body["password"])
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
            await proxy.connect(source["server"], source["user"], source["password"],
                                source_id=sid)
        except (SubsonicError, httpx.HTTPError, OSError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        await db.set_setting(_ACTIVE_KEY, sid)
        return JSONResponse({
            "ok": True, "connected": True,
            "server": proxy.server, "user": proxy.user,
            "token":  proxy.token,  "salt": proxy.salt,
        })

    async def sources_ping(request: Request) -> JSONResponse:
        """Ping a Subsonic server via its /rest/ping endpoint; does not change proxy state."""
        sid = request.path_params["id"]
        sources = await _load_sources(db)
        source = next((s for s in sources if s["id"] == sid), None)
        if source is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        server = source.get("server", "").rstrip("/")
        if not server:
            return JSONResponse({"reachable": False, "ms": None})
        import time
        t0 = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                await client.get(
                    f"{server}/rest/ping",
                    params={"v": "1.16.1", "c": "zik", "f": "json"},
                )
            ms = (time.monotonic() - t0) * 1000
            return JSONResponse({"reachable": True, "ms": ms})
        except Exception:
            return JSONResponse({"reachable": False, "ms": None})

    # ---- legacy single-connection endpoints (kept for compatibility) ----

    async def connect(request: Request) -> JSONResponse:
        """Connect to a Subsonic server and persist the config."""
        body = await request.json()
        server   = body.get("server",   "").strip().rstrip("/")
        user     = body.get("user",     "").strip()
        password = body.get("password", "")
        if not server:
            return JSONResponse({"error": "server is required"}, status_code=400)
        if not user:
            return JSONResponse({"error": "user is required"}, status_code=400)
        try:
            await proxy.connect(server, user, password)
        except (SubsonicError, httpx.HTTPError, OSError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        return JSONResponse({
            "ok": True, "connected": True,
            "server": proxy.server, "user": proxy.user,
            "token":  proxy.token,  "salt": proxy.salt,
        })

    async def disconnect(_request: Request) -> JSONResponse:
        """Disconnect from the Subsonic server."""
        await proxy.disconnect()
        await db.set_setting(_ACTIVE_KEY, "")
        return JSONResponse({"ok": True, "connected": False})

    async def status(_request: Request) -> JSONResponse:
        """Return connection state and auth info needed to build stream URLs."""
        active_id = await db.get_setting(_ACTIVE_KEY) or ""
        if not proxy.connected:
            return JSONResponse({
                "connected": False, "active_id": "",
                "server": "", "user": "", "token": "", "salt": "",
            })
        return JSONResponse({
            "connected": True,
            "active_id": active_id,
            "server": proxy.server,
            "user":   proxy.user,
            "token":  proxy.token,
            "salt":   proxy.salt,
        })

    async def library(_request: Request) -> JSONResponse:
        """GET /api/subsonic/library — return cached library instantly (may be empty)."""
        return JSONResponse(proxy.cached_library())

    async def library_quick_refresh(_request: Request) -> JSONResponse:
        """POST /api/subsonic/library/refresh — add albums new since last cache; fast."""
        if not proxy.connected:
            return JSONResponse({"error": "not connected"}, status_code=503)
        try:
            tracks = await proxy.quick_library()
        except (SubsonicError, httpx.HTTPError, OSError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        logger.info("subsonic: quick refresh returned %d tracks", len(tracks))
        return JSONResponse(tracks)

    async def library_full_refresh(_request: Request) -> JSONResponse:
        """POST /api/subsonic/library/full-refresh — re-fetch all tracks; slow but complete."""
        if not proxy.connected:
            return JSONResponse({"error": "not connected"}, status_code=503)
        try:
            tracks = await proxy.library()
        except (SubsonicError, httpx.HTTPError, OSError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        logger.info("subsonic: full refresh returned %d tracks", len(tracks))
        return JSONResponse(tracks)

    return [
        # source management
        Route("/api/subsonic/sources",                    sources_list,           methods=["GET"]),
        Route("/api/subsonic/sources",                    sources_create,         methods=["POST"]),
        Route("/api/subsonic/sources/{id}",               sources_update,         methods=["PUT"]),
        Route("/api/subsonic/sources/{id}",               sources_delete,      methods=["DELETE"]),
        Route("/api/subsonic/sources/{id}/activate",      sources_activate,       methods=["POST"]),
        Route("/api/subsonic/sources/{id}/ping",          sources_ping,           methods=["GET"]),
        # playback + status
        Route("/api/subsonic/connect",                    connect,                methods=["POST"]),
        Route("/api/subsonic/disconnect",                 disconnect,             methods=["POST"]),
        Route("/api/subsonic/status",                     status),
        # library
        Route("/api/subsonic/library",                    library,                methods=["GET"]),
        Route("/api/subsonic/library/refresh",            library_quick_refresh,  methods=["POST"]),
        Route("/api/subsonic/library/full-refresh",       library_full_refresh,   methods=["POST"]),
    ]
