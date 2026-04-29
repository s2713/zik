"""Tests for M4: LAN source persistence and SMB mount/unmount (gvfs mocked)."""

import asyncio
import tempfile
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from zik_backend.app import make_app
from zik_backend.services.files.db import LibraryDB

_CSRF_COOKIE = "__Host-zik-csrf"
_CSRF_HEADER = "x-csrf-token"
_TOKEN = "test-csrf-token-32chars-xxxxxxxx"
_MUT_HEADERS = {"sec-fetch-site": "same-origin", _CSRF_HEADER: _TOKEN}


def _client(db_path: str = ":memory:") -> httpx.AsyncClient:
    """Build a test client wired to a fresh app with no audio root (LAN tests only)."""
    app = make_app(files_root="", db_path=db_path)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        cookies={_CSRF_COOKIE: _TOKEN},
    )


# ---- DB unit tests ----

@pytest.mark.asyncio
async def test_lan_db_crud() -> None:
    # add_lan_source / list_lan_sources / remove_lan_source round-trip.
    db = LibraryDB(":memory:")
    assert await db.list_lan_sources() == []

    row = {
        "id": "abc-123", "label": "Home NAS", "kind": "smb",
        "server": "nas.local", "share": "music", "subpath": "/flac",
        "username": "user", "password": "s3cr3t",
    }
    await db.add_lan_source(row)
    sources = await db.list_lan_sources()
    assert len(sources) == 1
    assert sources[0]["id"] == "abc-123"
    # DB stores the plaintext password (no redaction at persistence layer).
    assert sources[0]["password"] == "s3cr3t"

    await db.remove_lan_source("abc-123")
    assert await db.list_lan_sources() == []
    await db.close()


# ---- API tests ----

@pytest.mark.asyncio
async def test_add_lan_source() -> None:
    # POST /api/files/lan must return 201 and make the source appear in the sources list.
    async with _client() as client:
        r = await client.post(
            "/api/files/lan",
            json={"label": "Home NAS", "server": "nas.local", "share": "music"},
            headers=_MUT_HEADERS,
        )
        assert r.status_code == 201
        data = r.json()
        assert data["ok"] is True
        # Password must not appear in the response (as_dict() redaction).
        assert "password" not in data["source"].get("config", {})
        source_id = data["source"]["id"]

        sources = (await client.get("/api/files/sources")).json()
    assert any(s["id"] == source_id and s["kind"] == "smb" for s in sources)


@pytest.mark.asyncio
async def test_add_lan_source_missing_fields() -> None:
    # POST without required server / share must return 400.
    async with _client() as client:
        r = await client.post(
            "/api/files/lan",
            json={"label": "Incomplete"},
            headers=_MUT_HEADERS,
        )
    assert r.status_code == 400
    assert "missing fields" in r.json()["error"]


@pytest.mark.asyncio
async def test_remove_lan_source() -> None:
    # DELETE /api/files/lan/{id} must remove the source from the sources list.
    async with _client() as client:
        add = await client.post(
            "/api/files/lan",
            json={"label": "Home NAS", "server": "nas.local", "share": "music"},
            headers=_MUT_HEADERS,
        )
        source_id = add.json()["source"]["id"]

        r = await client.request(
            "DELETE", f"/api/files/lan/{source_id}", headers=_MUT_HEADERS
        )
        assert r.status_code == 200

        sources = (await client.get("/api/files/sources")).json()
    assert not any(s["id"] == source_id for s in sources)


@pytest.mark.asyncio
async def test_mount_smb_success() -> None:
    # When gvfs_mount succeeds and the root dir exists, source must be marked mounted.
    with tempfile.TemporaryDirectory() as smb_root:
        async with _client() as client:
            add = await client.post(
                "/api/files/lan",
                json={"label": "Home NAS", "server": "nas.local", "share": "music"},
                headers=_MUT_HEADERS,
            )
            source_id = add.json()["source"]["id"]

            with (
                patch(
                    "zik_backend.services.files.routes.gvfs_mount",
                    new_callable=AsyncMock,
                    return_value=(True, ""),
                ),
                patch(
                    "zik_backend.services.files.routes.gvfs_mount_path",
                    return_value=smb_root,
                ),
            ):
                r = await client.post(
                    f"/api/files/sources/{source_id}/mount", headers=_MUT_HEADERS
                )
                assert r.status_code == 200
                assert r.json()["source"]["mounted"] is True
                # Let the background scan complete (empty dir → no tracks).
                await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_mount_smb_failure() -> None:
    # When gvfs_mount returns failure, the route must return 503.
    async with _client() as client:
        add = await client.post(
            "/api/files/lan",
            json={"label": "Home NAS", "server": "nas.local", "share": "music"},
            headers=_MUT_HEADERS,
        )
        source_id = add.json()["source"]["id"]

        with patch(
            "zik_backend.services.files.routes.gvfs_mount",
            new_callable=AsyncMock,
            return_value=(False, "Connection refused"),
        ):
            r = await client.post(
                f"/api/files/sources/{source_id}/mount", headers=_MUT_HEADERS
            )
    assert r.status_code == 503
    assert "gvfs mount failed" in r.json()["error"]


@pytest.mark.asyncio
async def test_unmount_smb() -> None:
    # Unmounting an SMB source must call gvfs_unmount and mark the source not mounted.
    with tempfile.TemporaryDirectory() as smb_root:
        async with _client() as client:
            add = await client.post(
                "/api/files/lan",
                json={"label": "Home NAS", "server": "nas.local", "share": "music"},
                headers=_MUT_HEADERS,
            )
            source_id = add.json()["source"]["id"]

            # Mount first.
            with (
                patch(
                    "zik_backend.services.files.routes.gvfs_mount",
                    new_callable=AsyncMock,
                    return_value=(True, ""),
                ),
                patch(
                    "zik_backend.services.files.routes.gvfs_mount_path",
                    return_value=smb_root,
                ),
            ):
                await client.post(
                    f"/api/files/sources/{source_id}/mount", headers=_MUT_HEADERS
                )

            # Unmount.
            with patch(
                "zik_backend.services.files.routes.gvfs_unmount",
                new_callable=AsyncMock,
                return_value=(True, ""),
            ) as mock_unmount:
                r = await client.post(
                    f"/api/files/sources/{source_id}/unmount", headers=_MUT_HEADERS
                )
                assert r.status_code == 200
                assert r.json()["source"]["mounted"] is False
                mock_unmount.assert_awaited_once()
