import httpx
import pytest

from zik_backend.app import make_app

app = make_app()

_CSRF_COOKIE = "__Host-zik-csrf"
_CSRF_HEADER = "x-csrf-token"
_TOKEN = "test-csrf-token-32chars-xxxxxxxx"


@pytest.mark.asyncio
async def test_csrf_missing_blocks_post() -> None:
    # A POST with no CSRF cookie and no header must be rejected before it reaches a route.
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/api/csrf-token",
            headers={"sec-fetch-site": "same-origin"},
        )
    assert response.status_code == 403
    assert response.json() == {"error": "csrf token missing"}


@pytest.mark.asyncio
async def test_csrf_mismatch_blocks_post() -> None:
    # Cookie present but header carries a different value — attacker cannot read the cookie
    # cross-origin, so a mismatch means the request is forged.
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver", cookies={_CSRF_COOKIE: _TOKEN}
    ) as client:
        response = await client.post(
            "/api/csrf-token",
            headers={
                "sec-fetch-site": "same-origin",
                _CSRF_HEADER: "wrong-token",
            },
        )
    assert response.status_code == 403
    assert response.json() == {"error": "csrf token mismatch"}


@pytest.mark.asyncio
async def test_csrf_valid_passes_middleware() -> None:
    # Cookie and header carry the same token — middleware must let the request through.
    # /api/csrf-token is GET-only so a POST returns 405, confirming the route was reached
    # (not blocked with 403 by the middleware).
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver", cookies={_CSRF_COOKIE: _TOKEN}
    ) as client:
        response = await client.post(
            "/api/csrf-token",
            headers={
                "sec-fetch-site": "same-origin",
                _CSRF_HEADER: _TOKEN,
            },
        )
    assert response.status_code == 405
