"""Session API — demo user switching for Target 1.

In production (Target 2+) login is handled by PAM / the OS login manager;
these endpoints are demo-only stubs.
"""

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

_DEMO_USERS = ["alice", "bob", "charlie"]


def make_session_router(sessions: dict) -> list:
    """Return Starlette Route list for session endpoints, sharing the app sessions dict."""

    async def list_users(_request: Request) -> JSONResponse:
        """Return the list of available demo users."""
        return JSONResponse(_DEMO_USERS)

    async def get_session(request: Request) -> JSONResponse:
        """Return the active demo user for this browser session."""
        sid = request.cookies.get("__Host-zik-session")
        session = sessions.get(sid, {}) if sid else {}
        return JSONResponse({"user": session.get("user", None)})

    async def login(request: Request) -> JSONResponse:
        """Set the active demo user for this session."""
        sid = request.cookies.get("__Host-zik-session")
        if not sid or sid not in sessions:
            return JSONResponse({"ok": False, "error": "no session"}, status_code=401)
        body = await request.json()
        username: str = body.get("username", "")
        if username not in _DEMO_USERS:
            return JSONResponse({"ok": False, "error": "unknown user"}, status_code=400)
        sessions[sid]["user"] = username
        sessions[sid].pop("locked", None)
        return JSONResponse({"ok": True, "user": username})

    async def lock(request: Request) -> JSONResponse:
        """Mark the current session as screen-locked."""
        sid = request.cookies.get("__Host-zik-session")
        if not sid or sid not in sessions:
            return JSONResponse({"ok": False, "error": "no session"}, status_code=401)
        sessions[sid]["locked"] = True
        return JSONResponse({"ok": True})

    return [
        Route("/api/users",          list_users),
        Route("/api/session",        get_session),
        Route("/api/session/login",  login,  methods=["POST"]),
        Route("/api/session/lock",   lock,   methods=["POST"]),
    ]
