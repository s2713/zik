import json
import os
from collections.abc import Callable

from .peercred import get_peer_uid


class PeerCredMiddleware:
    """Reject requests from peers whose uid is not in allowed_uids."""

    def __init__(self, app: Callable, allowed_uids: set[int] | None = None) -> None:
        self.app = app
        # Default: only accept connections from the same uid (covers the demo target).
        self.allowed_uids = allowed_uids if allowed_uids is not None else {os.getuid()}

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        # Pass non-HTTP scopes (lifespan, websocket) straight through.
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        peer_uid = get_peer_uid(scope)
        if peer_uid is None or peer_uid not in self.allowed_uids:
            # Reject: send a minimal 403 JSON response.
            body = json.dumps({"error": "forbidden"}).encode()
            await send({
                "type": "http.response.start",
                "status": 403,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            })
            await send({"type": "http.response.body", "body": body})
            return

        await self.app(scope, receive, send)
