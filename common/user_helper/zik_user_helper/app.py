import os
import pwd
from collections.abc import Callable

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .middleware import PeerCredMiddleware


async def whoami(_request: Request) -> JSONResponse:
    """Return the uid and username this helper process is running as."""
    uid = os.getuid()
    try:
        name = pwd.getpwuid(uid).pw_name
    except KeyError:
        name = str(uid)
    return JSONResponse({"uid": uid, "name": name})


def make_app(allowed_uids: set[int] | None = None) -> Callable:
    """Build the per-user helper ASGI app, gated by PeerCredMiddleware."""
    starlette_app = Starlette(routes=[
        Route("/whoami", whoami),
    ])
    return PeerCredMiddleware(starlette_app, allowed_uids=allowed_uids)


# Module-level app for `poetry run zik-user-helper`.
app = make_app()
