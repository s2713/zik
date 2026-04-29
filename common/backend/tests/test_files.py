"""Tests for the files service: scan, list, sort, audio stream."""

import os
import tempfile

import httpx
import pytest
from mutagen.id3 import ID3, TALB, TIT2, TPE1

from zik_backend.app import make_app

# CSRF constants — same pattern as other tests.
_CSRF_COOKIE = "__Host-zik-csrf"
_CSRF_HEADER = "x-csrf-token"
_TOKEN = "test-csrf-token-32chars-xxxxxxxx"
_POST_HEADERS = {"sec-fetch-site": "same-origin", _CSRF_HEADER: _TOKEN}


# ---- tiny valid audio file helpers ----

def _write_mp3(path: str, title: str, artist: str, album: str) -> None:
    """Write a minimal but valid MP3: 3 silent MPEG1/L3/128kbps/44100Hz frames + ID3 tags."""
    # MPEG1 Layer3 128kbps 44100Hz stereo no-padding: frame size = 417 bytes (4 + 413).
    mpeg_frame = b"\xff\xfb\x90\x00" + b"\x00" * 413
    with open(path, "wb") as f:
        f.write(mpeg_frame * 3)
    # ID3().save() prepends an ID3v2 header and shifts the MPEG data automatically.
    tags = ID3()
    tags.add(TIT2(encoding=3, text=[title]))
    tags.add(TPE1(encoding=3, text=[artist]))
    tags.add(TALB(encoding=3, text=[album]))
    tags.save(path, v2_version=3)


@pytest.fixture()
def music_dir():
    """Temporary directory containing 3 tagged MP3 stubs."""
    with tempfile.TemporaryDirectory() as d:
        _write_mp3(os.path.join(d, "a.mp3"), "Alpha", "Artist A", "Album X")
        _write_mp3(os.path.join(d, "b.mp3"), "Beta",  "Artist B", "Album Y")
        _write_mp3(os.path.join(d, "c.mp3"), "Gamma", "Artist A", "Album X")
        yield d


def _client(files_root: str, db_path: str = ":memory:") -> httpx.AsyncClient:
    """Build a test client wired to a fresh app with the given files root."""
    app = make_app(files_root=files_root, db_path=db_path)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        cookies={_CSRF_COOKIE: _TOKEN},
    )


@pytest.mark.asyncio
async def test_scan_populates_library(music_dir: str) -> None:
    # After a scan, list_tracks must return exactly 3 entries.
    async with _client(music_dir) as client:
        r = await client.post("/api/files/scan", headers=_POST_HEADERS)
        assert r.status_code == 200
        # Background task runs immediately in-process; give it a tick.
        import asyncio
        await asyncio.sleep(0.1)
        tracks = (await client.get("/api/files/tracks")).json()
    assert len(tracks) == 3
    titles = {t["title"] for t in tracks}
    assert titles == {"Alpha", "Beta", "Gamma"}


@pytest.mark.asyncio
async def test_sort_by_title(music_dir: str) -> None:
    # Tracks sorted by title must come back in alphabetical order.
    async with _client(music_dir) as client:
        await client.post("/api/files/scan", headers=_POST_HEADERS)
        import asyncio
        await asyncio.sleep(0.1)
        tracks = (await client.get("/api/files/tracks?sort=title")).json()
    assert [t["title"] for t in tracks] == ["Alpha", "Beta", "Gamma"]


@pytest.mark.asyncio
async def test_sort_by_album(music_dir: str) -> None:
    # Tracks sorted by album: Album X tracks first, then Album Y.
    async with _client(music_dir) as client:
        await client.post("/api/files/scan", headers=_POST_HEADERS)
        import asyncio
        await asyncio.sleep(0.1)
        tracks = (await client.get("/api/files/tracks?sort=album")).json()
    albums = [t["album"] for t in tracks]
    assert albums.index("Album X") < albums.index("Album Y")


@pytest.mark.asyncio
async def test_audio_route_returns_file(music_dir: str) -> None:
    # Audio route must return 200 and the file bytes for a known track.
    async with _client(music_dir) as client:
        await client.post("/api/files/scan", headers=_POST_HEADERS)
        import asyncio
        await asyncio.sleep(0.1)
        tracks = (await client.get("/api/files/tracks")).json()
        first_id = tracks[0]["id"]
        r = await client.get(f"/api/files/audio/{first_id}")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_audio_route_unknown_id(music_dir: str) -> None:
    # Unknown track id must return 404.
    async with _client(music_dir) as client:
        r = await client.get("/api/files/audio/nonexistent")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_scan_no_root() -> None:
    # Scan with no root configured must return 503.
    async with _client("") as client:
        r = await client.post("/api/files/scan", headers=_POST_HEADERS)
    assert r.status_code == 503
