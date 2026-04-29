import httpx
import pytest

from zik_backend.app import make_app

app = make_app()

# CSRF double-submit constants — same pattern as test_csrf.py.
_CSRF_COOKIE = "__Host-zik-csrf"
_CSRF_HEADER = "x-csrf-token"
_TOKEN = "test-csrf-token-32chars-xxxxxxxx"

# Shared client factory: origin + CSRF headers needed for POST commands.
def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        cookies={_CSRF_COOKIE: _TOKEN},
    )


@pytest.mark.asyncio
async def test_initial_state_is_stopped() -> None:
    # A freshly created app must report stopped playback with no track.
    async with _client() as client:
        r = await client.get("/api/player/state")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "stopped"
    assert body["track"] is None
    assert body["position"] == 0.0


@pytest.mark.asyncio
async def test_play_command_sets_playing() -> None:
    # A Play command with track metadata must switch status to "playing".
    async with _client() as client:
        r = await client.post(
            "/api/player/command",
            headers={"sec-fetch-site": "same-origin", _CSRF_HEADER: _TOKEN},
            json={
                "type": "Play",
                "track_id": "demo:1",
                "title": "Sine 261 Hz",
                "duration": 30.0,
                "position": 0.0,
                "volume": 1.0,
            },
        )
        assert r.status_code == 200
        state = (await client.get("/api/player/state")).json()
    assert state["status"] == "playing"
    assert state["track"]["id"] == "demo:1"


@pytest.mark.asyncio
async def test_pause_command_sets_paused() -> None:
    # Sending Play then Pause must leave status as "paused" with position preserved.
    async with _client() as client:
        headers = {"sec-fetch-site": "same-origin", _CSRF_HEADER: _TOKEN}
        await client.post("/api/player/command", headers=headers,
                          json={"type": "Play", "track_id": "demo:1",
                                "title": "t", "duration": 30.0, "position": 5.0})
        await client.post("/api/player/command", headers=headers,
                          json={"type": "Pause", "position": 5.0})
        state = (await client.get("/api/player/state")).json()
    assert state["status"] == "paused"
    assert state["position"] == 5.0


@pytest.mark.asyncio
async def test_stop_command_resets_position() -> None:
    # Stop must reset position to 0 regardless of where playback was.
    async with _client() as client:
        headers = {"sec-fetch-site": "same-origin", _CSRF_HEADER: _TOKEN}
        await client.post("/api/player/command", headers=headers,
                          json={"type": "Play", "track_id": "demo:1",
                                "title": "t", "duration": 30.0, "position": 12.0})
        await client.post("/api/player/command", headers=headers,
                          json={"type": "Stop"})
        state = (await client.get("/api/player/state")).json()
    assert state["status"] == "stopped"
    assert state["position"] == 0.0


@pytest.mark.asyncio
async def test_volume_command() -> None:
    # SetVolume must update the volume field; status must stay unchanged.
    async with _client() as client:
        headers = {"sec-fetch-site": "same-origin", _CSRF_HEADER: _TOKEN}
        await client.post("/api/player/command", headers=headers,
                          json={"type": "SetVolume", "volume": 0.5})
        state = (await client.get("/api/player/state")).json()
    assert state["volume"] == pytest.approx(0.5)


@pytest.mark.asyncio
async def test_next_command_preserves_playing() -> None:
    # Next while playing must keep status as "playing" and reset position.
    async with _client() as client:
        headers = {"sec-fetch-site": "same-origin", _CSRF_HEADER: _TOKEN}
        await client.post("/api/player/command", headers=headers,
                          json={"type": "Play", "track_id": "demo:1",
                                "title": "A", "duration": 30.0, "position": 10.0})
        await client.post("/api/player/command", headers=headers,
                          json={"type": "Next", "track_id": "demo:2",
                                "title": "B", "duration": 30.0})
        state = (await client.get("/api/player/state")).json()
    assert state["status"] == "playing"
    assert state["position"] == 0.0
    assert state["track"]["id"] == "demo:2"
