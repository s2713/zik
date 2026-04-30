"""Tests for the MPD service routes (MpdProxy mocked)."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from zik_backend.app import make_app

_CSRF_COOKIE = "__Host-zik-csrf"
_CSRF_HEADER = "x-csrf-token"
_TOKEN = "test-csrf-token-32chars-xxxxxxxx"
_POST_HEADERS = {"sec-fetch-site": "same-origin", _CSRF_HEADER: _TOKEN}


def _client() -> httpx.AsyncClient:
    """Build a test client wired to a fresh app."""
    app = make_app(files_root="", db_path=":memory:")
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        cookies={_CSRF_COOKIE: _TOKEN},
    )


def _mock_proxy(connected: bool = False) -> MagicMock:
    """Return a MagicMock MpdProxy with async methods."""
    proxy = MagicMock()
    proxy.connected = connected
    proxy.host = "localhost"
    proxy.port = 6600
    proxy.password = ""
    proxy.stream_url = ""
    proxy.connect = AsyncMock()
    proxy.disconnect = AsyncMock()
    proxy.status = AsyncMock(return_value={"state": "stop", "volume": "80"})
    proxy.currentsong = AsyncMock(return_value={"file": "foo.mp3", "title": "Foo"})
    proxy.library = AsyncMock(return_value=[
        {"file": "a.mp3", "title": "Alpha", "artist": "A", "album": "X", "time": "180"},
        {"file": "b.mp3", "title": "Beta",  "artist": "B", "album": "Y", "time": "240"},
    ])
    proxy.play_uri = AsyncMock()
    proxy.command = AsyncMock()
    return proxy


# ---- connect / disconnect ----

_STREAM_URL = "http://localhost:8000/stream.mp3"


@pytest.mark.asyncio
async def test_connect_ok() -> None:
    # Successful connect returns connected=True and echoes stream_url.
    proxy = _mock_proxy()
    with patch("zik_backend.app.MpdProxy", return_value=proxy):
        async with _client() as client:
            r = await client.post(
                "/api/mpd/connect",
                json={"host": "localhost", "port": 6600, "stream_url": _STREAM_URL},
                headers=_POST_HEADERS,
            )
    assert r.status_code == 200
    data = r.json()
    assert data["connected"] is True
    assert data["stream_url"] == _STREAM_URL
    proxy.connect.assert_awaited_once_with("localhost", 6600, "", _STREAM_URL)


@pytest.mark.asyncio
async def test_connect_missing_host() -> None:
    async with _client() as client:
        r = await client.post(
            "/api/mpd/connect",
            json={"port": 6600, "stream_url": _STREAM_URL},
            headers=_POST_HEADERS,
        )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_connect_without_stream_url() -> None:
    # Omitting stream_url is valid — audio plays on the remote server in that case.
    proxy = _mock_proxy()
    proxy.stream_url = ""
    with patch("zik_backend.app.MpdProxy", return_value=proxy):
        async with _client() as client:
            r = await client.post(
                "/api/mpd/connect",
                json={"host": "localhost", "port": 6600},
                headers=_POST_HEADERS,
            )
    assert r.status_code == 200
    assert r.json()["connected"] is True
    assert r.json()["stream_url"] == ""


@pytest.mark.asyncio
async def test_connect_bad_stream_url() -> None:
    # A non-HTTP stream_url (e.g. ftp://) is rejected with 422.
    async with _client() as client:
        r = await client.post(
            "/api/mpd/connect",
            json={"host": "localhost", "port": 6600, "stream_url": "ftp://bad"},
            headers=_POST_HEADERS,
        )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_connect_failure() -> None:
    # When connect raises, route must return 503.
    proxy = _mock_proxy()
    proxy.connect = AsyncMock(side_effect=ConnectionRefusedError("refused"))
    with patch("zik_backend.app.MpdProxy", return_value=proxy):
        async with _client() as client:
            r = await client.post(
                "/api/mpd/connect",
                json={"host": "dead.host", "port": 6600, "stream_url": _STREAM_URL},
                headers=_POST_HEADERS,
            )
    assert r.status_code == 503


@pytest.mark.asyncio
async def test_disconnect() -> None:
    proxy = _mock_proxy(connected=True)
    with patch("zik_backend.app.MpdProxy", return_value=proxy):
        async with _client() as client:
            r = await client.post("/api/mpd/disconnect", headers=_POST_HEADERS)
    assert r.status_code == 200
    assert r.json()["connected"] is False
    proxy.disconnect.assert_awaited_once()


# ---- status ----

@pytest.mark.asyncio
async def test_status_when_connected() -> None:
    proxy = _mock_proxy(connected=True)
    proxy.stream_url = _STREAM_URL
    with patch("zik_backend.app.MpdProxy", return_value=proxy):
        async with _client() as client:
            r = await client.get("/api/mpd/status")
    assert r.status_code == 200
    data = r.json()
    assert data["connected"] is True
    assert data["host"] == "localhost"
    assert data["port"] == 6600
    assert data["stream_url"] == _STREAM_URL
    assert data["status"]["state"] == "stop"
    assert data["currentsong"]["title"] == "Foo"


@pytest.mark.asyncio
async def test_status_when_disconnected() -> None:
    async with _client() as client:
        r = await client.get("/api/mpd/status")
    assert r.status_code == 200
    assert r.json()["connected"] is False


# ---- library ----

@pytest.mark.asyncio
async def test_library_returns_tracks() -> None:
    proxy = _mock_proxy(connected=True)
    with patch("zik_backend.app.MpdProxy", return_value=proxy):
        async with _client() as client:
            r = await client.get("/api/mpd/library")
    assert r.status_code == 200
    tracks = r.json()
    assert len(tracks) == 2
    assert tracks[0]["title"] == "Alpha"


@pytest.mark.asyncio
async def test_library_when_disconnected() -> None:
    async with _client() as client:
        r = await client.get("/api/mpd/library")
    assert r.status_code == 503


# ---- commands ----

@pytest.mark.asyncio
async def test_command_play_uri() -> None:
    proxy = _mock_proxy(connected=True)
    with patch("zik_backend.app.MpdProxy", return_value=proxy):
        async with _client() as client:
            r = await client.post(
                "/api/mpd/command",
                json={"type": "PlayUri", "uri": "foo.mp3"},
                headers=_POST_HEADERS,
            )
    assert r.status_code == 200
    proxy.play_uri.assert_awaited_once_with("foo.mp3")


@pytest.mark.asyncio
async def test_command_pause() -> None:
    proxy = _mock_proxy(connected=True)
    with patch("zik_backend.app.MpdProxy", return_value=proxy):
        async with _client() as client:
            r = await client.post(
                "/api/mpd/command",
                json={"type": "Pause"},
                headers=_POST_HEADERS,
            )
    assert r.status_code == 200
    proxy.command.assert_awaited_once_with("Pause")


@pytest.mark.asyncio
async def test_command_when_disconnected() -> None:
    async with _client() as client:
        r = await client.post(
            "/api/mpd/command",
            json={"type": "Stop"},
            headers=_POST_HEADERS,
        )
    assert r.status_code == 503
