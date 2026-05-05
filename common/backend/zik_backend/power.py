"""Power management API — stub for demo (Target 1).

In production (Target 2+) these routes will invoke systemctl poweroff/suspend/hibernate.
For the demo they acknowledge without touching the OS.
"""

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

_VALID_ACTIONS = {"poweroff", "suspend", "hibernate"}


async def _power_action(request: Request) -> JSONResponse:
    """Accept a power action; in demo mode, acknowledge without acting on the OS."""
    action = request.path_params["action"]
    if action not in _VALID_ACTIONS:
        return JSONResponse({"ok": False, "error": "unknown action"}, status_code=400)
    # TODO (Target 2+): subprocess.run(["systemctl", action], check=True)
    return JSONResponse({"ok": True, "action": action, "simulated": True})


def make_power_router() -> list:
    """Return Starlette Route list for power management endpoints."""
    return [
        Route("/api/power/{action}", _power_action, methods=["POST"]),
    ]
