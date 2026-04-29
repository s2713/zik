"""Tests for the files service: scan, list, sort, audio stream, sources."""

import asyncio
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
    """Temporary directory containing 3 tagged MP3 stubs (internal source)."""
    with tempfile.TemporaryDirectory() as d:
        _write_mp3(os.path.join(d, "a.mp3"), "Alpha", "Artist A", "Album X")
        _write_mp3(os.path.join(d, "b.mp3"), "Beta",  "Artist B", "Album Y")
        _write_mp3(os.path.join(d, "c.mp3"), "Gamma", "Artist A", "Album X")
        yield d


@pytest.fixture()
def removable_dir():
    """Temporary directory with 2 MP3 stubs simulating a removable drive."""
    with tempfile.TemporaryDirectory() as d:
        _write_mp3(os.path.join(d, "r1.mp3"), "RemA", "Artist R", "Album R")
        _write_mp3(os.path.join(d, "r2.mp3"), "RemB", "Artist R", "Album R")
        yield d


def _client(
    files_root: str,
    db_path: str = ":memory:",
    removable_root: str = "",
) -> httpx.AsyncClient:
    """Build a test client wired to a fresh app with the given roots."""
    app = make_app(files_root=files_root, db_path=db_path, removable_root=removable_root)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        cookies={_CSRF_COOKIE: _TOKEN},
    )


# ---- existing M2 tests (unchanged behaviour) ----

@pytest.mark.asyncio
async def test_scan_populates_library(music_dir: str) -> None:
    # After a scan, list_tracks must return exactly 3 entries.
    async with _client(music_dir) as client:
        r = await client.post("/api/files/scan", headers=_POST_HEADERS)
        assert r.status_code == 200
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
        await asyncio.sleep(0.1)
        tracks = (await client.get("/api/files/tracks?sort=title")).json()
    assert [t["title"] for t in tracks] == ["Alpha", "Beta", "Gamma"]


@pytest.mark.asyncio
async def test_sort_by_album(music_dir: str) -> None:
    # Tracks sorted by album: Album X tracks first, then Album Y.
    async with _client(music_dir) as client:
        await client.post("/api/files/scan", headers=_POST_HEADERS)
        await asyncio.sleep(0.1)
        tracks = (await client.get("/api/files/tracks?sort=album")).json()
    albums = [t["album"] for t in tracks]
    assert albums.index("Album X") < albums.index("Album Y")


@pytest.mark.asyncio
async def test_audio_route_returns_file(music_dir: str) -> None:
    # Audio route must return 200 and the file bytes for a known track.
    async with _client(music_dir) as client:
        await client.post("/api/files/scan", headers=_POST_HEADERS)
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


# ---- M3 source tests ----

@pytest.mark.asyncio
async def test_sources_list(music_dir: str, removable_dir: str) -> None:
    # With both roots configured, sources endpoint must list internal + removable.
    async with _client(music_dir, removable_root=removable_dir) as client:
        sources = (await client.get("/api/files/sources")).json()
    assert len(sources) == 2
    ids = {s["id"] for s in sources}
    assert ids == {"internal", "removable"}
    mounted = {s["id"]: s["mounted"] for s in sources}
    assert mounted["internal"] is True
    assert mounted["removable"] is False


@pytest.mark.asyncio
async def test_mount_adds_removable_tracks(music_dir: str, removable_dir: str) -> None:
    # Mounting the removable source must add its 2 tracks alongside the 3 internal ones.
    async with _client(music_dir, removable_root=removable_dir) as client:
        # Scan internal.
        await client.post("/api/files/scan", headers=_POST_HEADERS)
        await asyncio.sleep(0.1)
        before = (await client.get("/api/files/tracks")).json()
        assert len(before) == 3

        # Mount removable (triggers background scan).
        r = await client.post(
            "/api/files/sources/removable/mount", headers=_POST_HEADERS
        )
        assert r.status_code == 200
        assert r.json()["source"]["mounted"] is True
        await asyncio.sleep(0.1)

        after = (await client.get("/api/files/tracks")).json()
    assert len(after) == 5
    source_ids = {t["source_id"] for t in after}
    assert source_ids == {"internal", "removable"}


@pytest.mark.asyncio
async def test_unmount_removes_removable_tracks(music_dir: str, removable_dir: str) -> None:
    # Unmounting the removable source must remove its tracks; internal tracks stay.
    async with _client(music_dir, removable_root=removable_dir) as client:
        # Populate both sources.
        await client.post("/api/files/scan", headers=_POST_HEADERS)
        await client.post(
            "/api/files/sources/removable/mount", headers=_POST_HEADERS
        )
        await asyncio.sleep(0.1)
        assert len((await client.get("/api/files/tracks")).json()) == 5

        # Unmount.
        r = await client.post(
            "/api/files/sources/removable/unmount", headers=_POST_HEADERS
        )
        assert r.status_code == 200
        assert r.json()["source"]["mounted"] is False

        remaining = (await client.get("/api/files/tracks")).json()
    assert len(remaining) == 3
    assert all(t["source_id"] == "internal" for t in remaining)
