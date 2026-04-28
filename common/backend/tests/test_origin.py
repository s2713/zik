import httpx
import pytest

from zik_backend.app import make_app

# Use explicit ports so the allowed-origin set is deterministic in tests.
app = make_app(backend_port=8173, vite_port=5173)

_CSRF_COOKIE = "__Host-zik-csrf"
_CSRF_HEADER = "x-csrf-token"
_TOKEN = "test-csrf-token-32chars-xxxxxxxx"


@pytest.mark.asyncio
async def test_allowed_origin_passes() -> None:
    # A POST from a whitelisted origin with valid CSRF must reach the route.
    # /api/csrf-token is GET-only, so 405 confirms the middleware stack was cleared.
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/api/csrf-token",
            headers={
                "origin": "http://127.0.0.1:8173",
                _CSRF_HEADER: _TOKEN,
            },
            cookies={_CSRF_COOKIE: _TOKEN},
        )
    assert response.status_code == 405


@pytest.mark.asyncio
async def test_sec_fetch_site_same_origin_passes() -> None:
    # Sec-Fetch-Site: same-origin is browser-enforced and sufficient on its own —
    # no Origin header needed.
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/api/csrf-token",
            headers={
                "sec-fetch-site": "same-origin",
                _CSRF_HEADER: _TOKEN,
            },
            cookies={_CSRF_COOKIE: _TOKEN},
        )
    assert response.status_code == 405


@pytest.mark.asyncio
async def test_cross_origin_blocked() -> None:
    # A POST from an unlisted origin must be rejected regardless of the CSRF token.
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/api/csrf-token",
            headers={
                "origin": "http://evil.example.com",
                _CSRF_HEADER: _TOKEN,
            },
            cookies={_CSRF_COOKIE: _TOKEN},
        )
    assert response.status_code == 403
