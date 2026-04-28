import json
import os
import secrets
from pathlib import Path

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .middleware import CsrfDoubleSubmitMiddleware, OriginCheckMiddleware

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
) -> Starlette:
    bp = backend_port or int(os.environ.get("ZIK_BACKEND_PORT", "8173"))
    vp = vite_port or int(os.environ.get("ZIK_VITE_PORT", "5173"))
    allowed_origins: frozenset[str] = frozenset({
        f"http://127.0.0.1:{bp}",
        f"http://127.0.0.1:{vp}",
    })
    starlette_app = Starlette(routes=[
        Route("/api/health", health),
        Route("/api/csrf-token", csrf_token),
        Route("/api/i18n/messages", i18n_messages),
    ])
    # Middleware is applied outermost-last: origin check wraps csrf check wraps routes.
    starlette_app.add_middleware(CsrfDoubleSubmitMiddleware)
    starlette_app.add_middleware(OriginCheckMiddleware, allowed_origins=allowed_origins)
    return starlette_app


app = make_app()
