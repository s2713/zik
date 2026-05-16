"""Power management API.

In demo mode (privhelp absent): all actions are acknowledged without touching
the OS and the response carries simulated=True.

In production (Target 2+):
  - "suspend"   → systemctl suspend-then-hibernate  (auto-hibernate after 2h)
  - "hibernate" → systemctl hibernate               (immediate / "hibernate now")
  - "poweroff"  → systemctl poweroff
"""

import asyncio
from pathlib import Path

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

PRIVHELP_BIN = Path("/usr/libexec/zik/zik-privhelp")

_VALID_ACTIONS = {"poweroff", "suspend", "hibernate"}

# Map frontend action name → systemd target.
# "suspend" uses suspend-then-hibernate so the device auto-hibernates after
# HibernateDelaySec (2h) if the user leaves it sleeping; "hibernate" writes
# RAM to swap immediately — the "hibernate now" button.
_SYSTEMCTL_ACTION = {
    "poweroff":  "poweroff",
    "suspend":   "suspend-then-hibernate",
    "hibernate": "hibernate",
}


def _is_demo() -> bool:
    """True when running on the demo target (no privhelp binary)."""
    return not PRIVHELP_BIN.exists()


async def _power_action(request: Request) -> JSONResponse:
    """Accept a power action; in demo mode, acknowledge without acting on the OS."""
    action = request.path_params["action"]
    if action not in _VALID_ACTIONS:
        return JSONResponse({"ok": False, "error": "unknown action"}, status_code=400)

    if _is_demo():
        return JSONResponse({"ok": True, "action": action, "simulated": True})

    systemd_action = _SYSTEMCTL_ACTION[action]
    proc = await asyncio.create_subprocess_exec(
        "systemctl", systemd_action,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        return JSONResponse(
            {"ok": False, "error": stderr.decode().strip()},
            status_code=500,
        )
    return JSONResponse({"ok": True, "action": action})


def make_power_router() -> list:
    """Return Starlette Route list for power management endpoints."""
    return [
        Route("/api/power/{action}", _power_action, methods=["POST"]),
    ]
