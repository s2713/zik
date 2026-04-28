import httpx
import pytest

from zik_backend.app import make_app

app = make_app()


@pytest.mark.asyncio
async def test_health_ok() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "service": "zik-backend"}


@pytest.mark.asyncio
async def test_i18n_messages_returns_dict() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/i18n/messages")
    assert response.status_code == 200
    assert isinstance(response.json(), dict)


@pytest.mark.asyncio
async def test_csrf_token_issues_cookies() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/csrf-token")
    assert response.status_code == 200
    body = response.json()
    assert "csrf_token" in body
    assert len(body["csrf_token"]) > 0
    assert "__Host-zik-csrf" in response.cookies
    assert "__Host-zik-session" in response.cookies
