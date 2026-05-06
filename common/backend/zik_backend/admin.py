"""Admin API — user management for Target 1 (demo stubs).

In production (Target 2+) user operations go through the privhelper binary
(PAM / shadow / chpasswd).  These endpoints manage an in-memory store.
"""

import time
from dataclasses import asdict, dataclass, field

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

# Must match frontend REAUTH_TTL_MS (60 000 ms).
_REAUTH_TTL = 60

_ALL_SERVICES = ["demo", "files", "mpd", "subsonic", "spotify", "podcasts", "radio"]


@dataclass
class UserRecord:
    """In-memory representation of a managed user (demo only)."""
    password:  str       = "changeme"
    disabled:  bool      = False
    quota_mb:  int       = 1024
    services:  list[str] = field(default_factory=lambda: list(_ALL_SERVICES))
    bluetooth: bool      = True
    wifi:      bool      = True   # can connect to Wi-Fi
    wifi_add:  bool      = False  # can add new Wi-Fi networks


def make_user_store(usernames: list[str]) -> dict[str, UserRecord]:
    """Seed the in-memory user store from a list of demo usernames."""
    return {u: UserRecord(password=u) for u in usernames}


def make_admin_router(sessions: dict, users: dict[str, UserRecord]) -> list:
    """Return Starlette Route list for admin user-management endpoints."""

    def _require_admin(request: Request) -> dict | None:
        """Return the session dict if the caller is an authenticated admin, else None."""
        sid = request.cookies.get("__Host-zik-session")
        if not sid or sid not in sessions:
            return None
        s = sessions[sid]
        return s if s.get("is_admin") else None

    def _reauth_fresh(session: dict) -> bool:
        """True if the session carries a reauth stamp younger than _REAUTH_TTL."""
        at = session.get("reauth_at")
        return at is not None and (time.monotonic() - at) < _REAUTH_TTL

    def _to_dict(username: str, rec: UserRecord) -> dict:
        d = asdict(rec)
        d["username"] = username
        return d

    async def list_users(request: Request) -> JSONResponse:
        """Return all users with their settings."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        return JSONResponse([_to_dict(u, r) for u, r in users.items()])

    async def create_user(request: Request) -> JSONResponse:
        """Create a new user; admin auth required."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        body = await request.json()
        username = str(body.get("username", "")).strip().lower()
        password = str(body.get("password", ""))
        if not username or not username.replace("_", "").isalnum():
            return JSONResponse({"error": "invalid-username"}, status_code=400)
        if username in users or username == "admin":
            return JSONResponse({"error": "already-exists"}, status_code=409)
        users[username] = UserRecord(password=password or username)
        return JSONResponse({"ok": True, "user": _to_dict(username, users[username])})

    async def delete_user(request: Request) -> JSONResponse:
        """Delete a user; requires a fresh reauth stamp."""
        session = _require_admin(request)
        if session is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        if not _reauth_fresh(session):
            return JSONResponse({"error": "reauth-required"}, status_code=403)
        username = request.path_params["username"]
        if username not in users:
            return JSONResponse({"error": "not-found"}, status_code=404)
        del users[username]
        return JSONResponse({"ok": True})

    async def patch_user(request: Request) -> JSONResponse:
        """Update one or more fields of a user record."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        username = request.path_params["username"]
        if username not in users:
            return JSONResponse({"error": "not-found"}, status_code=404)
        body = await request.json()
        rec = users[username]
        if "disabled"  in body:
            rec.disabled  = bool(body["disabled"])
        if "password"  in body:
            rec.password  = str(body["password"])
        if "quota_mb"  in body:
            rec.quota_mb  = max(0, int(body["quota_mb"]))
        if "bluetooth" in body:
            rec.bluetooth = bool(body["bluetooth"])
        if "wifi"      in body:
            rec.wifi      = bool(body["wifi"])
        if "wifi_add"  in body:
            rec.wifi_add  = bool(body["wifi_add"])
        if "services"  in body:
            rec.services = [s for s in body["services"] if s in _ALL_SERVICES]
        return JSONResponse({"ok": True, "user": _to_dict(username, rec)})

    return [
        Route("/api/admin/users",            list_users,  methods=["GET"]),
        Route("/api/admin/users",            create_user, methods=["POST"]),
        Route("/api/admin/users/{username}", delete_user, methods=["DELETE"]),
        Route("/api/admin/users/{username}", patch_user,  methods=["PATCH"]),
    ]
