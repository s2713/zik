"""Tests for the Subsonic service routes (SubsonicProxy mocked)."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from zik_backend.app import make_app
from zik_backend.services.subsonic.client import SubsonicError

_CSRF_COOKIE = "__Host-zik-csrf"
_CSRF_HEADER = "x-csrf-token"
_TOKEN = "test-csrf-token-32chars-xxxxxxxx"
_POST_HEADERS = {"sec-fetch-site": "same-origin", _CSRF_HEADER: _TOKEN}

_SERVER = "http://demo.navidrome.org"
_USER   = "demo"
_TOKEN_ = "abc123token"
_SALT   = "saltsalt"

_TRACKS = [
    {"id": "1", "title": "Alpha", "artist": "A", "album": "X", "duration": 180},
    {"id": "2", "title": "Beta",  "artist": "B", "album": "Y", "duration": 240},
]


def _client() -> httpx.AsyncClient:
    """Build a test client wired to a fresh app."""
    app = make_app(files_root="", db_path=":memory:")
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        cookies={_CSRF_COOKIE: _TOKEN},
    )


def _mock_proxy(connected: bool = False) -> MagicMock:
    """Return a MagicMock SubsonicProxy with the right interface."""
    proxy = MagicMock()
    proxy.connected = connected
    proxy.server    = _SERVER if connected else ""
    proxy.user      = _USER   if connected else ""
    proxy.token     = _TOKEN_ if connected else ""
    proxy.salt      = _SALT   if connected else ""
    proxy.connect    = AsyncMock()
    proxy.disconnect = AsyncMock()
    proxy.library    = AsyncMock(return_value=_TRACKS)
    return proxy


# ---- connect ----

@pytest.mark.asyncio
async def test_connect_ok() -> None:
    proxy = _mock_proxy()
    with patch("zik_backend.app.SubsonicProxy", return_value=proxy):
        async with _client() as client:
            r = await client.post(
                "/api/subsonic/connect",
                json={"server": _SERVER, "user": _USER, "password": "pass"},
                headers=_POST_HEADERS,
            )
    assert r.status_code == 200
    data = r.json()
    assert data["connected"] is True
    proxy.connect.assert_awaited_once_with(_SERVER, _USER, "pass")


@pytest.mark.asyncio
async def test_connect_missing_server() -> None:
    async with _client() as client:
        r = await client.post(
            "/api/subsonic/connect",
            json={"user": _USER, "password": "pass"},
            headers=_POST_HEADERS,
        )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_connect_missing_user() -> None:
    async with _client() as client:
        r = await client.post(
            "/api/subsonic/connect",
            json={"server": _SERVER, "password": "pass"},
            headers=_POST_HEADERS,
        )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_connect_failure() -> None:
    proxy = _mock_proxy()
    proxy.connect = AsyncMock(side_effect=SubsonicError("wrong credentials"))
    with patch("zik_backend.app.SubsonicProxy", return_value=proxy):
        async with _client() as client:
            r = await client.post(
                "/api/subsonic/connect",
                json={"server": _SERVER, "user": _USER, "password": "bad"},
                headers=_POST_HEADERS,
            )
    assert r.status_code == 503


# ---- disconnect ----

@pytest.mark.asyncio
async def test_disconnect() -> None:
    proxy = _mock_proxy(connected=True)
    with patch("zik_backend.app.SubsonicProxy", return_value=proxy):
        async with _client() as client:
            r = await client.post("/api/subsonic/disconnect", headers=_POST_HEADERS)
    assert r.status_code == 200
    assert r.json()["connected"] is False
    proxy.disconnect.assert_awaited_once()


# ---- status ----

@pytest.mark.asyncio
async def test_status_when_connected() -> None:
    proxy = _mock_proxy(connected=True)
    with patch("zik_backend.app.SubsonicProxy", return_value=proxy):
        async with _client() as client:
            r = await client.get("/api/subsonic/status")
    assert r.status_code == 200
    data = r.json()
    assert data["connected"] is True
    assert data["server"] == _SERVER
    assert data["user"]   == _USER
    assert data["token"]  == _TOKEN_
    assert data["salt"]   == _SALT


@pytest.mark.asyncio
async def test_status_when_disconnected() -> None:
    async with _client() as client:
        r = await client.get("/api/subsonic/status")
    assert r.status_code == 200
    assert r.json()["connected"] is False


# ---- library ----

@pytest.mark.asyncio
async def test_library_returns_tracks() -> None:
    proxy = _mock_proxy(connected=True)
    with patch("zik_backend.app.SubsonicProxy", return_value=proxy):
        async with _client() as client:
            r = await client.get("/api/subsonic/library")
    assert r.status_code == 200
    tracks = r.json()
    assert len(tracks) == 2
    assert tracks[0]["title"] == "Alpha"


@pytest.mark.asyncio
async def test_library_when_disconnected() -> None:
    async with _client() as client:
        r = await client.get("/api/subsonic/library")
    assert r.status_code == 503


@pytest.mark.asyncio
async def test_library_server_error() -> None:
    proxy = _mock_proxy(connected=True)
    proxy.library = AsyncMock(side_effect=SubsonicError("server error"))
    with patch("zik_backend.app.SubsonicProxy", return_value=proxy):
        async with _client() as client:
            r = await client.get("/api/subsonic/library")
    assert r.status_code == 503
