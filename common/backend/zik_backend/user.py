"""User self-service API — stub for demo (Target 1).

In production (Target 2+) the password route will call `chpasswd` or equivalent.
"""

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route


async def _change_password(request: Request) -> JSONResponse:
    """Accept a password-change request; in demo mode, acknowledge without acting."""
    body = await request.json()
    new_pw: str = body.get("new_password", "")
    if not new_pw:
        return JSONResponse({"ok": False, "error": "new_password required"}, status_code=400)
    # TODO (Target 2+): validate current_password and call chpasswd for the active user.
    return JSONResponse({"ok": True, "simulated": True})


def make_user_router() -> list:
    """Return Starlette Route list for user self-service endpoints."""
    return [
        Route("/api/user/password", _change_password, methods=["POST"]),
    ]
