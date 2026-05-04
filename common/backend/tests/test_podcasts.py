"""Tests for the Podcasts service routes."""

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from zik_backend.app import make_app

_CSRF_COOKIE = "__Host-zik-csrf"
_CSRF_HEADER = "x-csrf-token"
_TOKEN = "test-csrf-token-32chars-xxxxxxxx"
_POST_HEADERS = {"sec-fetch-site": "same-origin", _CSRF_HEADER: _TOKEN}

_FEED_URL = "http://example.com/feed.rss"

_RSS = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Test Podcast</title>
    <description>A test podcast.</description>
    <image><url>http://example.com/art.jpg</url></image>
    <item>
      <guid>ep1</guid>
      <title>Episode 1</title>
      <pubDate>Mon, 01 Jan 2024 00:00:00 +0000</pubDate>
      <itunes:duration>30:00</itunes:duration>
      <enclosure url="http://example.com/ep1.mp3" type="audio/mpeg" length="12345"/>
      <description>First episode.</description>
    </item>
    <item>
      <guid>ep2</guid>
      <title>Episode 2</title>
      <pubDate>Mon, 08 Jan 2024 00:00:00 +0000</pubDate>
      <itunes:duration>45:30</itunes:duration>
      <enclosure url="http://example.com/ep2.mp3" type="audio/mpeg" length="23456"/>
    </item>
  </channel>
</rss>"""

_BAD_XML = b"this is not xml <<<"


def _client() -> httpx.AsyncClient:
    """Build a test client wired to a fresh in-memory app."""
    app = make_app(files_root="", db_path=":memory:")
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        cookies={_CSRF_COOKIE: _TOKEN},
    )


def _mock_fetch(content: bytes = _RSS) -> AsyncMock:
    """Patch _fetch_xml to return given bytes."""
    return patch(
        "zik_backend.services.podcasts.routes._fetch_xml",
        new=AsyncMock(return_value=content),
    )


def _mock_fetch_error() -> AsyncMock:
    """Patch _fetch_xml to raise an httpx error."""
    return patch(
        "zik_backend.services.podcasts.routes._fetch_xml",
        new=AsyncMock(side_effect=httpx.ConnectError("connection refused")),
    )


# ---- list feeds ----

@pytest.mark.asyncio
async def test_list_feeds_empty() -> None:
    async with _client() as client:
        r = await client.get("/api/podcasts/feeds")
    assert r.status_code == 200
    assert r.json() == []


# ---- add feed ----

@pytest.mark.asyncio
async def test_add_feed_ok() -> None:
    with _mock_fetch():
        async with _client() as client:
            r = await client.post(
                "/api/podcasts/feeds",
                json={"url": _FEED_URL},
                headers=_POST_HEADERS,
            )
    assert r.status_code == 200
    data = r.json()
    assert data["title"]           == "Test Podcast"
    assert data["url"]             == _FEED_URL
    assert len(data["episodes"])   == 2
    assert data["episodes"][0]["title"]    == "Episode 1"
    assert data["episodes"][0]["duration"] == 1800  # 30:00


@pytest.mark.asyncio
async def test_add_feed_missing_url() -> None:
    async with _client() as client:
        r = await client.post(
            "/api/podcasts/feeds",
            json={},
            headers=_POST_HEADERS,
        )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_add_feed_fetch_error() -> None:
    with _mock_fetch_error():
        async with _client() as client:
            r = await client.post(
                "/api/podcasts/feeds",
                json={"url": _FEED_URL},
                headers=_POST_HEADERS,
            )
    assert r.status_code == 503


@pytest.mark.asyncio
async def test_add_feed_invalid_rss() -> None:
    with _mock_fetch(_BAD_XML):
        async with _client() as client:
            r = await client.post(
                "/api/podcasts/feeds",
                json={"url": _FEED_URL},
                headers=_POST_HEADERS,
            )
    assert r.status_code == 422


# ---- list after add ----

@pytest.mark.asyncio
async def test_list_feeds_after_add() -> None:
    with _mock_fetch():
        async with _client() as client:
            await client.post(
                "/api/podcasts/feeds",
                json={"url": _FEED_URL},
                headers=_POST_HEADERS,
            )
            r = await client.get("/api/podcasts/feeds")
    assert r.status_code == 200
    feeds = r.json()
    assert len(feeds) == 1
    assert feeds[0]["url"]   == _FEED_URL
    assert feeds[0]["title"] == "Test Podcast"
    assert "episodes" not in feeds[0]


# ---- remove feed ----

@pytest.mark.asyncio
async def test_remove_feed() -> None:
    with _mock_fetch():
        async with _client() as client:
            await client.post(
                "/api/podcasts/feeds",
                json={"url": _FEED_URL},
                headers=_POST_HEADERS,
            )
            r = await client.post(
                "/api/podcasts/feeds/remove",
                json={"url": _FEED_URL},
                headers=_POST_HEADERS,
            )
            assert r.status_code == 200
            feeds = await client.get("/api/podcasts/feeds")
    assert feeds.json() == []


# ---- episodes ----

@pytest.mark.asyncio
async def test_episodes_ok() -> None:
    with _mock_fetch():
        async with _client() as client:
            r = await client.get(f"/api/podcasts/episodes?url={_FEED_URL}")
    assert r.status_code == 200
    data = r.json()
    assert data["title"] == "Test Podcast"
    assert len(data["episodes"]) == 2
    ep2 = data["episodes"][1]
    assert ep2["duration"] == 2730  # 45:30


@pytest.mark.asyncio
async def test_episodes_missing_url() -> None:
    async with _client() as client:
        r = await client.get("/api/podcasts/episodes")
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_episodes_fetch_error() -> None:
    with _mock_fetch_error():
        async with _client() as client:
            r = await client.get(f"/api/podcasts/episodes?url={_FEED_URL}")
    assert r.status_code == 503
