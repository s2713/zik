import json
import logging
import os
import secrets
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket

from .helper_client import HelperClient
from .middleware import CsrfDoubleSubmitMiddleware, OriginCheckMiddleware
from .player import PlayerManager, state_as_dict
from .services.files.db import LibraryDB
from .services.files.routes import make_files_router
from .services.files.sources import Source, SourceManager

logger = logging.getLogger(__name__)

# In-memory session store — placeholder until A1 adds real auth state.
_sessions: dict[str, dict] = {}


async def health(_request: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "service": "zik-backend"})


async def csrf_token(request: Request) -> JSONResponse:
    session_id = request.cookies.get("__Host-zik-session")
    if session_id and session_id in _sessions:
        token = _sessions[session_id]["csrf_token"]
        response = JSONResponse({"csrf_token": token})
    else:
        session_id = secrets.token_urlsafe(32)
        token = secrets.token_urlsafe(32)
        _sessions[session_id] = {"csrf_token": token}
        response = JSONResponse({"csrf_token": token})
        # __Host- prefix requires Secure + Path=/ + no Domain.
        # Chromium grants the Secure exception for http://127.0.0.1 (localhost exception).
        response.set_cookie(
            "__Host-zik-session", session_id,
            httponly=True, secure=True, samesite="strict", path="/",
        )
    response.set_cookie(
        "__Host-zik-csrf", token,
        httponly=False, secure=True, samesite="strict", path="/",
    )
    return response


async def i18n_messages(_request: Request) -> JSONResponse:
    path = os.environ.get("ZIK_MESSAGES_JSON")
    if path:
        try:
            return JSONResponse(json.loads(Path(path).read_text()))
        except (OSError, json.JSONDecodeError):
            pass
    return JSONResponse({})


def make_app(
    backend_port: int | None = None,
    vite_port: int | None = None,
    files_root: str | None = None,
    db_path: str | None = None,
    removable_root: str | None = None,
) -> Starlette:
    bp = backend_port or int(os.environ.get("ZIK_BACKEND_PORT", "8173"))
    vp = vite_port or int(os.environ.get("ZIK_VITE_PORT", "5173"))
    allowed_origins: frozenset[str] = frozenset({
        f"http://127.0.0.1:{bp}",
        f"http://127.0.0.1:{vp}",
    })

    # PlayerManager is created per app instance; captured by the route closures below.
    player = PlayerManager()

    # LibraryDB is opened in lifespan and closed on shutdown.
    _files_root = files_root or os.environ.get("ZIK_FILES_ROOT", "")
    _removable_root = removable_root or os.environ.get("ZIK_REMOVABLE_ROOT", "")
    _db_path = db_path or os.environ.get("ZIK_LIBRARY_DB", ":memory:")
    library_db = LibraryDB(_db_path)

    # Build source list: internal always present; removable only when configured.
    _sources: list[Source] = [
        Source(id="internal", label="Internal storage",
               root=_files_root, kind="internal", mounted=True),
    ]
    if _removable_root:
        _sources.append(Source(
            id="removable", label="Removable drive",
            root=_removable_root, kind="removable", mounted=False,
        ))
    source_manager = SourceManager(_sources)

    @asynccontextmanager
    async def _lifespan(_app: Starlette) -> AsyncGenerator[None, None]:
        """Open DB, load persisted LAN sources, probe helper, then yield; close on shutdown."""
        await library_db.open()

        # Restore any LAN sources persisted from previous sessions.
        for row in await library_db.list_lan_sources():
            source_manager.add_source(Source(
                id=row["id"],
                label=row["label"],
                root="",  # filled in when mounted
                kind=row["kind"],
                mounted=False,
                config={
                    "server": row["server"],
                    "share": row["share"],
                    "subpath": row["subpath"],
                    "username": row["username"],
                    "password": row["password"],
                },
            ))

        socket_path = os.environ.get("ZIK_HELPER_SOCKET", "")
        if socket_path:
            try:
                info = await HelperClient(socket_path).get_whoami()
                logger.info(
                    "helper running as uid=%s (%s)", info.get("uid"), info.get("name")
                )
            except FileNotFoundError:
                # Helper socket not yet present — expected in tests and cold-start ordering.
                logger.warning(
                    "helper socket not found: %s (helper may not be running)", socket_path
                )
            except Exception as exc:
                logger.warning("could not contact helper: %s", exc)
        else:
            logger.debug("ZIK_HELPER_SOCKET not set; skipping helper probe")

        yield  # application runs here

        await library_db.close()

    async def player_command(request: Request) -> JSONResponse:
        """Apply a playback command from the frontend and broadcast to the MPRIS bridge."""
        try:
            cmd = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid json"}, status_code=400)
        player.apply_command(cmd)
        await player.broadcast({"type": "PropertiesChanged", **state_as_dict(player.state)})
        return JSONResponse({"ok": True})

    async def player_state(_request: Request) -> JSONResponse:
        """Return current playback state as JSON."""
        return JSONResponse(state_as_dict(player.state))

    async def mpris_bridge_ws(websocket: WebSocket) -> None:
        """MPRIS bridge connects here; held open to receive broadcast events."""
        await player.add_bridge(websocket)

    starlette_app = Starlette(
        routes=[
            Route("/api/health", health),
            Route("/api/csrf-token", csrf_token),
            Route("/api/i18n/messages", i18n_messages),
            Route("/api/player/command", player_command, methods=["POST"]),
            Route("/api/player/state", player_state),
            WebSocketRoute("/api/ws/mpris-bridge", mpris_bridge_ws),
            *make_files_router(library_db, source_manager),
        ],
        lifespan=_lifespan,
    )
    # Middleware is applied outermost-last: origin check wraps csrf check wraps routes.
    starlette_app.add_middleware(CsrfDoubleSubmitMiddleware)
    starlette_app.add_middleware(OriginCheckMiddleware, allowed_origins=allowed_origins)
    return starlette_app


app = make_app()
