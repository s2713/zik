"""Session API — demo user switching and admin auth for Target 1.

In production (Target 2+) login is handled by PAM / the OS login manager;
these endpoints are demo-only stubs.
"""

import time

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .admin_lock import DeviceLock, is_locked

_DEMO_USERS = ["alice", "bob", "charlie"]
# Hardcoded for demo only — real PAM auth on Target 2.
_ADMIN_PASSWORD = "admin"
# Re-auth token lifetime in seconds.
_REAUTH_TTL = 60


def make_session_router(sessions: dict, users: dict | None = None,
                        device_lock: DeviceLock | None = None) -> list:
    """Return Starlette Route list for session endpoints, sharing the app sessions dict.

    Pass the admin user store as `users` so /api/users stays in sync with
    admin create/delete operations.  Falls back to _DEMO_USERS if omitted.
    """

    async def list_users(_request: Request) -> JSONResponse:
        """Return the list of available demo users (excludes admin)."""
        return JSONResponse(list(users.keys()) if users is not None else _DEMO_USERS)

    async def get_session(request: Request) -> JSONResponse:
        """Return the active user, admin flag, and allowed service list."""
        sid = request.cookies.get("__Host-zik-session")
        session = sessions.get(sid, {}) if sid else {}
        user = session.get("user", None)
        # Resolve per-user allowed services from the user store.
        allowed: list[str] | None = None
        if user and user != "admin" and users is not None and user in users:
            allowed = users[user].services
        return JSONResponse({
            "user":             user,
            "is_admin":         session.get("is_admin", False),
            "allowed_services": allowed,
        })

    async def login(request: Request) -> JSONResponse:
        """Set the active user for this session; admin requires a password."""
        sid = request.cookies.get("__Host-zik-session")
        if not sid or sid not in sessions:
            return JSONResponse({"ok": False, "error": "no session"}, status_code=401)
        body = await request.json()
        username: str = body.get("username", "")
        if username == "admin":
            # Admin login — verify password.
            if body.get("password", "") != _ADMIN_PASSWORD:
                return JSONResponse({"ok": False, "error": "wrong password"}, status_code=403)
            sessions[sid]["user"]     = "admin"
            sessions[sid]["is_admin"] = True
            sessions[sid].pop("locked", None)
            return JSONResponse({"ok": True, "user": "admin", "is_admin": True})
        # Device lock — only admin may log in while active.
        if device_lock is not None and is_locked(device_lock):
            return JSONResponse({"ok": False, "error": "device-locked"}, status_code=403)
        valid = set(users.keys()) if users is not None else set(_DEMO_USERS)
        if username not in valid:
            return JSONResponse({"ok": False, "error": "unknown user"}, status_code=400)
        sessions[sid]["user"]     = username
        sessions[sid]["is_admin"] = False
        sessions[sid].pop("locked", None)
        return JSONResponse({"ok": True, "user": username, "is_admin": False})

    async def reauth(request: Request) -> JSONResponse:
        """Verify admin password and stamp a re-auth timestamp in the session."""
        sid = request.cookies.get("__Host-zik-session")
        if not sid or sid not in sessions:
            return JSONResponse({"ok": False, "error": "no session"}, status_code=401)
        if not sessions[sid].get("is_admin"):
            return JSONResponse({"ok": False, "error": "not admin"}, status_code=403)
        body = await request.json()
        if body.get("password", "") != _ADMIN_PASSWORD:
            return JSONResponse({"ok": False, "error": "wrong password"}, status_code=403)
        sessions[sid]["reauth_at"] = time.monotonic()
        return JSONResponse({"ok": True})

    async def lock(request: Request) -> JSONResponse:
        """Mark the current session as screen-locked."""
        # Lock state is frontend-managed; backend record is best-effort.
        sid = request.cookies.get("__Host-zik-session")
        if sid and sid in sessions:
            sessions[sid]["locked"] = True
        return JSONResponse({"ok": True})

    return [
        Route("/api/users",           list_users),
        Route("/api/session",         get_session),
        Route("/api/session/login",   login,  methods=["POST"]),
        Route("/api/session/reauth",  reauth, methods=["POST"]),
        Route("/api/session/lock",    lock,   methods=["POST"]),
    ]
