"""Spotify Web API client with automatic token refresh."""

import logging
import time

import httpx

from .auth import refresh_access_token

logger = logging.getLogger(__name__)

_BASE       = "https://api.spotify.com/v1"
_PAGE_SIZE  = 50
_MAX_TRACKS = 2000


def _normalize_track(item: dict) -> dict:
    """Flatten a Spotify track (or saved-track wrapper) to the fields we need."""
    track   = item.get("track") or item
    artists = track.get("artists") or []
    artist  = ", ".join(a.get("name", "") for a in artists)
    album   = (track.get("album") or {})
    year    = int((album.get("release_date") or "0")[:4] or 0)
    return {
        "id":          track.get("id", ""),
        "uri":         track.get("uri", ""),
        "title":       track.get("name", ""),
        "artist":      artist,
        "album":       album.get("name", ""),
        "duration_ms": int(track.get("duration_ms") or 0),
        "year":        year,
    }


class SpotifyApi:
    """Holds OAuth tokens and wraps the Spotify Web API; refreshes tokens automatically."""

    def __init__(self, client_id: str) -> None:
        self._client_id    = client_id
        self.access_token  = ""
        self.refresh_token = ""
        self.expires_at    = 0.0

    @property
    def authed(self) -> bool:
        return bool(self.access_token)

    def store_token_dict(self, td: dict) -> None:
        """Accept a token response dict and update state."""
        self.access_token = td["access_token"]
        if "refresh_token" in td:
            self.refresh_token = td["refresh_token"]
        self.expires_at = time.time() + int(td.get("expires_in") or 3600) - 60

    def load_tokens(
        self, access_token: str, refresh_token: str, expires_at: float
    ) -> None:
        """Restore tokens persisted in DB."""
        self.access_token  = access_token
        self.refresh_token = refresh_token
        self.expires_at    = expires_at

    def clear(self) -> None:
        self.access_token = self.refresh_token = ""
        self.expires_at = 0.0

    # ---- internal HTTP helpers ----

    async def _token(self) -> str:
        """Return a valid access token, refreshing if it has expired."""
        if time.time() >= self.expires_at and self.refresh_token:
            logger.info("spotify: refreshing access token")
            td = await refresh_access_token(self._client_id, self.refresh_token)
            self.store_token_dict(td)
        return self.access_token

    async def _get(self, path: str, **params: object) -> dict:
        token = await self._token()
        async with httpx.AsyncClient(timeout=15.0) as c:
            r = await c.get(
                f"{_BASE}{path}",
                headers={"Authorization": f"Bearer {token}"},
                params={k: v for k, v in params.items()},
            )
            if r.status_code == 204:
                return {}
            r.raise_for_status()
            return r.json()

    async def _put(self, path: str, body: dict | None = None, **params: object) -> None:
        token = await self._token()
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.put(
                f"{_BASE}{path}",
                headers={"Authorization": f"Bearer {token}"},
                params={k: v for k, v in params.items()},
                json=body,
            )
            if r.status_code not in (200, 202, 204):
                r.raise_for_status()

    async def _post(self, path: str, body: dict | None = None, **params: object) -> None:
        token = await self._token()
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.post(
                f"{_BASE}{path}",
                headers={"Authorization": f"Bearer {token}"},
                params={k: v for k, v in params.items()},
                json=body,
            )
            if r.status_code not in (200, 202, 204):
                r.raise_for_status()

    # ---- playback ----

    async def current_playback(self) -> dict:
        """Return current playback state; empty dict if no active device."""
        return await self._get("/me/player")

    async def devices(self) -> list[dict]:
        """Return list of available Spotify Connect devices."""
        data = await self._get("/me/player/devices")
        return data.get("devices", [])

    async def play(
        self,
        device_id: str = "",
        uris: list[str] | None = None,
    ) -> None:
        """Start or resume playback, optionally specifying track URIs."""
        params = {"device_id": device_id} if device_id else {}
        body   = {"uris": uris} if uris else {}
        await self._put("/me/player/play", body=body or None, **params)

    async def pause(self, device_id: str = "") -> None:
        params = {"device_id": device_id} if device_id else {}
        await self._put("/me/player/pause", **params)

    async def next_track(self, device_id: str = "") -> None:
        params = {"device_id": device_id} if device_id else {}
        await self._post("/me/player/next", **params)

    async def previous_track(self, device_id: str = "") -> None:
        params = {"device_id": device_id} if device_id else {}
        await self._post("/me/player/previous", **params)

    async def seek(self, position_ms: int, device_id: str = "") -> None:
        params: dict = {"position_ms": position_ms}
        if device_id:
            params["device_id"] = device_id
        await self._put("/me/player/seek", **params)

    async def set_volume(self, pct: int, device_id: str = "") -> None:
        params: dict = {"volume_percent": max(0, min(100, pct))}
        if device_id:
            params["device_id"] = device_id
        await self._put("/me/player/volume", **params)

    async def transfer(self, device_id: str, play: bool = False) -> None:
        """Transfer playback to a specific Spotify Connect device."""
        await self._put("/me/player", body={"device_ids": [device_id], "play": play})

    # ---- library ----

    async def saved_tracks(self) -> list[dict]:
        """Return all saved tracks via pagination."""
        tracks: list[dict] = []
        offset = 0
        while len(tracks) < _MAX_TRACKS:
            data  = await self._get("/me/tracks", limit=_PAGE_SIZE, offset=offset)
            items = data.get("items") or []
            if not items:
                break
            tracks.extend(_normalize_track(item) for item in items)
            if len(items) < _PAGE_SIZE or not data.get("next"):
                break
            offset += _PAGE_SIZE
        logger.info("spotify: fetched %d saved tracks", len(tracks))
        return tracks
