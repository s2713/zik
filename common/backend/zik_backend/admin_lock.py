"""Admin API — device lock management.

When locked, only the admin can log in; regular users are rejected at the
session login endpoint.  On Target 2 the lock is also enforced at the PAM
level (pam_zik_adminlock) for SSH and VT logins.

Lock state is persisted to /var/lib/zik/adminlock via zik-privhelp so that it
survives backend restarts.  The backend reads the file on startup and writes
via privhelp on set/clear.  The file is absent when unlocked, empty for an
indefinite lock, or contains a Unix timestamp (float) for a timed lock.
"""

import subprocess
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

PRIVHELP_BIN = Path("/usr/libexec/zik/zik-privhelp")
LOCK_FILE    = Path("/var/lib/zik/adminlock")


@dataclass
class DeviceLock:
    """Device-level lock state shared between admin and session routers."""
    locked:       bool          = False
    locked_until: float | None  = None  # Unix epoch; None = indefinite when locked


def _call_privhelp(*args: str) -> bool:
    """Call zik-privhelp with args; return True on success. No-op in demo mode."""
    if not PRIVHELP_BIN.exists():
        return True  # demo mode — privhelp not installed
    try:
        subprocess.run(
            [str(PRIVHELP_BIN), *args],
            check=True, timeout=10,
            capture_output=True,
        )
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return False


def _read_lock_from_disk() -> DeviceLock:
    """Read lock state from disk; returns unlocked state if file absent or unreadable."""
    try:
        if not LOCK_FILE.exists():
            return DeviceLock()
        content = LOCK_FILE.read_text().strip()
        if not content:
            return DeviceLock(locked=True, locked_until=None)
        until = float(content)
        if time.time() >= until:
            return DeviceLock()  # lock expired while backend was down
        return DeviceLock(locked=True, locked_until=until)
    except (OSError, ValueError):
        return DeviceLock()


def make_lock_store() -> DeviceLock:
    """Return device lock state, rehydrating from disk on production systems."""
    return _read_lock_from_disk()


def is_locked(lock: DeviceLock) -> bool:
    """True if the device lock is currently active (respects expiry)."""
    if not lock.locked:
        return False
    if lock.locked_until is not None and time.time() >= lock.locked_until:
        # Lock expired — auto-clear in memory (file stays until next explicit unlock).
        lock.locked       = False
        lock.locked_until = None
        return False
    return True


def _to_dict(lock: DeviceLock) -> dict:
    d = asdict(lock)
    d["active"] = is_locked(lock)
    return d


def make_admin_lock_router(sessions: dict, lock: DeviceLock, audit=None) -> list:
    """Return Starlette Route list for admin lock-management endpoints."""

    def _require_admin(request: Request) -> dict | None:
        """Return the session dict if the caller is an authenticated admin, else None."""
        sid = request.cookies.get("__Host-zik-session")
        if not sid or sid not in sessions:
            return None
        s = sessions[sid]
        return s if s.get("is_admin") else None

    async def get_lock(request: Request) -> JSONResponse:
        """Return current device lock state (admin only)."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        return JSONResponse(_to_dict(lock))

    async def set_lock(request: Request) -> JSONResponse:
        """Activate the device lock.

        Body: {mode: "indefinite" | "duration" | "until",
               minutes?: int,        # used with mode=duration
               until?: float}        # Unix timestamp, used with mode=until
        """
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        body = await request.json()
        mode = str(body.get("mode", "indefinite"))
        lock.locked = True
        if mode == "duration":
            minutes = max(1, int(body.get("minutes", 60)))
            lock.locked_until = time.time() + minutes * 60
        elif mode == "until":
            ts = float(body.get("until", 0))
            lock.locked_until = ts if ts > time.time() else None
        else:
            lock.locked_until = None  # indefinite

        # Persist to disk via privhelp (no-op in demo mode).
        if lock.locked_until is not None:
            _call_privhelp("admin-lock", "--set", "--until", str(lock.locked_until))
        else:
            _call_privhelp("admin-lock", "--set")

        if audit is not None:
            audit.add("admin", "device-lock", mode)
        return JSONResponse({"ok": True, "lock": _to_dict(lock)})

    async def clear_lock(request: Request) -> JSONResponse:
        """Deactivate the device lock (admin only)."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        lock.locked       = False
        lock.locked_until = None
        _call_privhelp("admin-lock", "--clear")
        if audit is not None:
            audit.add("admin", "device-unlock")
        return JSONResponse({"ok": True, "lock": _to_dict(lock)})

    async def lock_status(request: Request) -> JSONResponse:
        """Return {locked: bool} — public endpoint used by the lock screen.

        Admin sessions are never considered locked so the admin can always reach
        the UI after authenticating through the lock screen.
        """
        sid = request.cookies.get("__Host-zik-session")
        if sid and sid in sessions and sessions[sid].get("is_admin"):
            return JSONResponse({"locked": False})
        return JSONResponse({"locked": is_locked(lock)})

    return [
        Route("/api/admin/lock",   get_lock,    methods=["GET"]),
        Route("/api/admin/lock",   set_lock,    methods=["POST"]),
        Route("/api/admin/lock",   clear_lock,  methods=["DELETE"]),
        Route("/api/lock/status",  lock_status, methods=["GET"]),
    ]
