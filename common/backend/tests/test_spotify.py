"""Tests for the Spotify service routes (SpotifyApi and LibrespotProcess mocked)."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from zik_backend.app import make_app

_CSRF_COOKIE = "__Host-zik-csrf"
_CSRF_HEADER = "x-csrf-token"
_TOKEN = "test-csrf-token-32chars-xxxxxxxx"
_POST_HEADERS = {"sec-fetch-site": "same-origin", _CSRF_HEADER: _TOKEN}

_PLAYBACK = {
    "is_playing":  True,
    "progress_ms": 12000,
    "device": {"id": "dev1", "name": "zik", "volume_percent": 80},
    "item": {
        "id":          "tid1",
        "uri":         "spotify:track:tid1",
        "name":        "Alpha",
        "artists":     [{"name": "Artist A"}],
        "album":       {"name": "Album X"},
        "duration_ms": 180000,
    },
}

_TRACKS = [
    {"id": "tid1", "uri": "spotify:track:tid1", "title": "Alpha",
     "artist": "Artist A", "album": "Album X", "duration_ms": 180000, "year": 2020},
    {"id": "tid2", "uri": "spotify:track:tid2", "title": "Beta",
     "artist": "Artist B", "album": "Album Y", "duration_ms": 240000, "year": 2021},
]

_DEVICES = [{"id": "dev1", "name": "zik"}, {"id": "dev2", "name": "Phone"}]


def _client() -> httpx.AsyncClient:
    """Build a test client wired to a fresh app."""
    app = make_app(files_root="", db_path=":memory:")
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        cookies={_CSRF_COOKIE: _TOKEN},
    )


def _mock_api(authed: bool = False) -> MagicMock:
    """Return a MagicMock SpotifyApi with the right interface."""
    api = MagicMock()
    api.authed        = authed
    api.access_token  = "acc_tok" if authed else ""
    api.refresh_token = "ref_tok" if authed else ""
    api.expires_at    = 9_999_999_999.0 if authed else 0.0
    api.store_token_dict = MagicMock()
    api.load_tokens      = MagicMock()
    api.clear            = MagicMock()
    api._token           = AsyncMock(return_value="acc_tok")
    api.current_playback = AsyncMock(return_value=_PLAYBACK if authed else {})
    api.devices          = AsyncMock(return_value=_DEVICES)
    api.saved_tracks     = AsyncMock(return_value=_TRACKS)
    api.play             = AsyncMock()
    api.pause            = AsyncMock()
    api.next_track       = AsyncMock()
    api.previous_track   = AsyncMock()
    api.seek             = AsyncMock()
    api.set_volume       = AsyncMock()
    api.transfer         = AsyncMock()
    return api


def _mock_ls(running: bool = False) -> MagicMock:
    """Return a MagicMock LibrespotProcess."""
    ls = MagicMock()
    ls.available = True
    ls.running   = running
    ls.start     = AsyncMock(return_value=True)
    ls.stop      = AsyncMock()
    return ls


# ---- auth ----

@pytest.mark.asyncio
async def test_auth_start_no_client_id() -> None:
    # Default make_app has no spotify_client_id; /auth/start must return 400.
    async with _client() as client:
        r = await client.get("/api/spotify/auth/start")
    assert r.status_code == 400
    assert "not configured" in r.json().get("error", "")


@pytest.mark.asyncio
async def test_auth_callback_invalid_state() -> None:
    # Callback with unknown state returns an HTML error page (not a redirect).
    async with _client() as client:
        r = await client.get("/api/spotify/auth/callback?code=xxx&state=unknown")
    assert r.status_code == 200  # HTMLResponse
    assert "Invalid or expired state" in r.text


# ---- status ----

@pytest.mark.asyncio
async def test_status_not_authed() -> None:
    api = _mock_api(authed=False)
    ls  = _mock_ls()
    with patch("zik_backend.app.SpotifyApi", return_value=api), \
         patch("zik_backend.app.LibrespotProcess", return_value=ls):
        async with _client() as client:
            r = await client.get("/api/spotify/status")
    assert r.status_code == 200
    data = r.json()
    assert data["authed"] is False
    assert "librespot_available" in data
    assert "librespot_running" in data


@pytest.mark.asyncio
async def test_status_authed() -> None:
    api = _mock_api(authed=True)
    ls  = _mock_ls(running=True)
    with patch("zik_backend.app.SpotifyApi", return_value=api), \
         patch("zik_backend.app.LibrespotProcess", return_value=ls):
        async with _client() as client:
            r = await client.get("/api/spotify/status")
    assert r.status_code == 200
    data = r.json()
    assert data["authed"]            is True
    assert data["playing"]           is True
    assert data["progress_ms"]       == 12000
    assert data["volume_pct"]        == 80
    assert data["device_id"]         == "dev1"
    assert data["librespot_running"] is True
    track = data["track"]
    assert track is not None
    assert track["title"]  == "Alpha"
    assert track["artist"] == "Artist A"


# ---- devices ----

@pytest.mark.asyncio
async def test_devices_not_authed() -> None:
    async with _client() as client:
        r = await client.get("/api/spotify/devices")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_devices_ok() -> None:
    api = _mock_api(authed=True)
    ls  = _mock_ls()
    with patch("zik_backend.app.SpotifyApi", return_value=api), \
         patch("zik_backend.app.LibrespotProcess", return_value=ls):
        async with _client() as client:
            r = await client.get("/api/spotify/devices")
    assert r.status_code == 200
    devs = r.json()
    assert len(devs) == 2
    assert devs[0]["name"] == "zik"


# ---- library ----

@pytest.mark.asyncio
async def test_library_not_authed() -> None:
    async with _client() as client:
        r = await client.get("/api/spotify/library")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_library_ok() -> None:
    api = _mock_api(authed=True)
    ls  = _mock_ls()
    with patch("zik_backend.app.SpotifyApi", return_value=api), \
         patch("zik_backend.app.LibrespotProcess", return_value=ls):
        async with _client() as client:
            r = await client.get("/api/spotify/library")
    assert r.status_code == 200
    tracks = r.json()
    assert len(tracks) == 2
    assert tracks[0]["title"] == "Alpha"


# ---- command ----

@pytest.mark.asyncio
async def test_command_not_authed() -> None:
    async with _client() as client:
        r = await client.post(
            "/api/spotify/command",
            json={"type": "Play"},
            headers=_POST_HEADERS,
        )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_command_play() -> None:
    api = _mock_api(authed=True)
    ls  = _mock_ls()
    with patch("zik_backend.app.SpotifyApi", return_value=api), \
         patch("zik_backend.app.LibrespotProcess", return_value=ls):
        async with _client() as client:
            r = await client.post(
                "/api/spotify/command",
                json={"type": "Play", "device_id": "dev1", "uris": ["spotify:track:tid1"]},
                headers=_POST_HEADERS,
            )
    assert r.status_code == 200
    assert r.json()["ok"] is True
    api.play.assert_awaited_once_with(device_id="dev1", uris=["spotify:track:tid1"])


@pytest.mark.asyncio
async def test_command_unknown() -> None:
    api = _mock_api(authed=True)
    ls  = _mock_ls()
    with patch("zik_backend.app.SpotifyApi", return_value=api), \
         patch("zik_backend.app.LibrespotProcess", return_value=ls):
        async with _client() as client:
            r = await client.post(
                "/api/spotify/command",
                json={"type": "Bogus"},
                headers=_POST_HEADERS,
            )
    assert r.status_code == 400


# ---- disconnect ----

@pytest.mark.asyncio
async def test_disconnect() -> None:
    api = _mock_api(authed=True)
    ls  = _mock_ls(running=True)
    with patch("zik_backend.app.SpotifyApi", return_value=api), \
         patch("zik_backend.app.LibrespotProcess", return_value=ls):
        async with _client() as client:
            r = await client.post("/api/spotify/disconnect", headers=_POST_HEADERS)
    assert r.status_code == 200
    data = r.json()
    assert data["authed"] is False
    api.clear.assert_called_once()
    ls.stop.assert_awaited()
