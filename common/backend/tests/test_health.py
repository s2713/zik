import httpx
import pytest

from zik_backend.__main__ import app


@pytest.mark.asyncio
async def test_health_ok() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "service": "zik-backend"}
