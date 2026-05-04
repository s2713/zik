"""Tests for the Radio service routes."""

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from zik_backend.app import make_app

_CSRF_COOKIE = "__Host-zik-csrf"
_CSRF_HEADER = "x-csrf-token"
_TOKEN = "test-csrf-token-32chars-xxxxxxxx"
_POST_HEADERS = {"sec-fetch-site": "same-origin", _CSRF_HEADER: _TOKEN}

_RB_STATIONS = [
    {
        "stationuuid": "abc-123",
        "name":        "Test Radio",
        "url":         "http://stream.example.com/radio",
        "url_resolved": "http://stream.example.com/radio",
        "favicon":     "http://example.com/icon.png",
        "tags":        "pop,rock",
        "country":     "France",
        "codec":       "MP3",
        "bitrate":     128,
        "votes":       999,
    },
]

_RB_TAGS = [
    {"name": "pop",      "stationcount": 5000},
    {"name": "jazz",     "stationcount": 3000},
    {"name": "",         "stationcount": 1},   # empty name must be filtered out
]

# _somafm_get() now returns a processed list (stream URLs already resolved from .pls files).
_SOMAFM_PROCESSED = [
    {
        "id":          "groovesalad",
        "name":        "Groove Salad",
        "description": "A nicely chilled plate.",
        "image":       "https://somafm.com/img/groovesalad-400.jpg",
        "url":         "https://ice6.somafm.com/groovesalad-128-mp3",
        "listeners":   1234,
        "genre":       "Ambient/Downtempo",
        "source":      "somafm",
    },
]


def _client() -> httpx.AsyncClient:
    """Build a test client wired to a fresh in-memory app."""
    app = make_app(files_root="", db_path=":memory:")
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        cookies={_CSRF_COOKIE: _TOKEN},
    )


def _mock_rb(return_value: list | dict) -> AsyncMock:
    """Patch _rb_get to return a fixed value."""
    return patch(
        "zik_backend.services.radio.routes._rb_get",
        new=AsyncMock(return_value=return_value),
    )


def _mock_rb_error() -> AsyncMock:
    return patch(
        "zik_backend.services.radio.routes._rb_get",
        new=AsyncMock(side_effect=httpx.ConnectError("unreachable")),
    )


# ---- search ----

@pytest.mark.asyncio
async def test_search_ok() -> None:
    with _mock_rb(_RB_STATIONS):
        async with _client() as client:
            r = await client.get("/api/radio/search?q=Test")
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 1
    assert data[0]["name"]    == "Test Radio"
    assert data[0]["uuid"]    == "abc-123"
    assert data[0]["source"]  == "radiobrowser"
    assert data[0]["bitrate"] == 128


@pytest.mark.asyncio
async def test_search_missing_params() -> None:
    async with _client() as client:
        r = await client.get("/api/radio/search")
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_search_network_error() -> None:
    with _mock_rb_error():
        async with _client() as client:
            r = await client.get("/api/radio/search?tag=pop")
    assert r.status_code == 503


# ---- popular ----

@pytest.mark.asyncio
async def test_popular_ok() -> None:
    with _mock_rb(_RB_STATIONS):
        async with _client() as client:
            r = await client.get("/api/radio/popular")
    assert r.status_code == 200
    assert len(r.json()) == 1


# ---- tags ----

@pytest.mark.asyncio
async def test_tags_ok() -> None:
    with _mock_rb(_RB_TAGS):
        async with _client() as client:
            r = await client.get("/api/radio/tags")
    assert r.status_code == 200
    tags = r.json()
    assert len(tags) == 2            # empty-name entry filtered out
    assert tags[0]["name"] == "pop"


# ---- resolve ----

@pytest.mark.asyncio
async def test_resolve_ok() -> None:
    with _mock_rb({"url": "http://stream.example.com/radio", "ok": "true"}):
        async with _client() as client:
            r = await client.get("/api/radio/resolve/abc-123")
    assert r.status_code == 200
    assert r.json()["url"] == "http://stream.example.com/radio"


@pytest.mark.asyncio
async def test_resolve_list_response() -> None:
    # Some radio-browser servers wrap the response in a list.
    with _mock_rb([{"url": "http://stream.example.com/radio"}]):
        async with _client() as client:
            r = await client.get("/api/radio/resolve/abc-123")
    assert r.status_code == 200
    assert r.json()["url"] == "http://stream.example.com/radio"


# ---- SomaFM ----

@pytest.mark.asyncio
async def test_somafm_ok() -> None:
    with patch("zik_backend.services.radio.routes._somafm_get",
               new=AsyncMock(return_value=_SOMAFM_PROCESSED)):
        async with _client() as client:
            r = await client.get("/api/radio/somafm")
    assert r.status_code == 200
    channels = r.json()
    assert len(channels) == 1
    ch = channels[0]
    assert ch["name"]   == "Groove Salad"
    assert ch["source"] == "somafm"
    assert "groovesalad-128-mp3" in ch["url"]


# ---- favorites ----

@pytest.mark.asyncio
async def test_favorites_empty() -> None:
    async with _client() as client:
        r = await client.get("/api/radio/favorites")
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_add_and_list_favorite() -> None:
    station = {"uuid": "abc-123", "name": "Test Radio",
               "url": "http://stream.example.com/radio", "source": "radiobrowser"}
    async with _client() as client:
        r = await client.post(
            "/api/radio/favorites",
            json={"station": station},
            headers=_POST_HEADERS,
        )
        assert r.status_code == 200
        favs = (await client.get("/api/radio/favorites")).json()
    assert len(favs) == 1
    assert favs[0]["name"] == "Test Radio"


@pytest.mark.asyncio
async def test_add_favorite_missing_url() -> None:
    async with _client() as client:
        r = await client.post(
            "/api/radio/favorites",
            json={"station": {"name": "No URL"}},
            headers=_POST_HEADERS,
        )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_remove_favorite() -> None:
    station = {"uuid": "abc-123", "name": "Test Radio",
               "url": "http://stream.example.com/radio", "source": "radiobrowser"}
    async with _client() as client:
        await client.post("/api/radio/favorites",
                          json={"station": station}, headers=_POST_HEADERS)
        r = await client.post("/api/radio/favorites/remove",
                              json={"uuid": "abc-123"}, headers=_POST_HEADERS)
        assert r.status_code == 200
        favs = (await client.get("/api/radio/favorites")).json()
    assert favs == []
