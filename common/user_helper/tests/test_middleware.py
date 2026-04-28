import os

import pytest

from zik_user_helper.middleware import PeerCredMiddleware


# Minimal ASGI app that always returns 200 — used as the inner app in tests.
async def _ok_app(scope, receive, send):
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


def _http_scope(peer_uid: int | None) -> dict:
    """Build a minimal HTTP ASGI scope, optionally carrying a peer_uid."""
    # Simulate what PeerCredH11Protocol injects via scope["extensions"]["peer_uid"].
    scope: dict = {"type": "http", "extensions": {}}
    if peer_uid is not None:
        scope["extensions"]["peer_uid"] = peer_uid
    return scope


async def _collect_status(scope, receive, send, app) -> int:
    """Run the app and return the HTTP status code it sent."""
    status: list[int] = []

    async def capture_send(event):
        if event["type"] == "http.response.start":
            status.append(event["status"])

    await app(scope, receive, capture_send)
    return status[0]


@pytest.mark.asyncio
async def test_allowed_uid_passes() -> None:
    # A request from the same uid as the running process must reach the inner app.
    app = PeerCredMiddleware(_ok_app)
    scope = _http_scope(peer_uid=os.getuid())
    status = await _collect_status(scope, None, None, app)
    assert status == 200


@pytest.mark.asyncio
async def test_unknown_uid_blocked() -> None:
    # A uid that is not in allowed_uids must be rejected with 403.
    # uid 0 is almost certainly not the test-runner uid.
    foreign_uid = 0 if os.getuid() != 0 else 65534
    app = PeerCredMiddleware(_ok_app, allowed_uids={os.getuid()})
    scope = _http_scope(peer_uid=foreign_uid)
    status = await _collect_status(scope, None, None, app)
    assert status == 403


@pytest.mark.asyncio
async def test_missing_peer_uid_blocked() -> None:
    # If SO_PEERCRED was unavailable (scope has no peer_uid), reject with 403.
    app = PeerCredMiddleware(_ok_app)
    scope = _http_scope(peer_uid=None)
    status = await _collect_status(scope, None, None, app)
    assert status == 403


@pytest.mark.asyncio
async def test_non_http_scope_passes_through() -> None:
    # Lifespan and websocket scopes must be forwarded without any uid check.
    reached: list[bool] = []

    async def probe_app(scope, receive, send):  # inner app records that it was called
        reached.append(True)

    app = PeerCredMiddleware(probe_app)
    lifespan_scope = {"type": "lifespan"}
    await app(lifespan_scope, None, None)
    assert reached == [True]
