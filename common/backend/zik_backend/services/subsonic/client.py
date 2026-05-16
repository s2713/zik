"""Async Subsonic REST API client.

Auth uses the token+salt method (Subsonic API >= 1.13):
  token = md5(password + salt)
Salt is generated once per connection. The token and salt are returned to the
frontend so it can build stream URLs directly — the password never leaves the
backend.
"""

import hashlib
import logging
import secrets

import httpx

logger = logging.getLogger(__name__)

_API_VERSION = "1.16.1"
_CLIENT_NAME = "zik"
_PAGE_SIZE = 500      # songs per search3 request
_MAX_SONGS  = 100_000  # safety cap; real termination is an empty page from the server


def _md5(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()


def _normalize_song(s: dict) -> dict:
    """Flatten a Subsonic song object to the fields our UI needs."""
    return {
        "id":       str(s.get("id", "")),
        "title":    s.get("title", ""),
        "artist":   s.get("artist", ""),
        "album":    s.get("album", ""),
        "duration": int(s.get("duration") or 0),
        "track":    s.get("track"),
        "year":     s.get("year"),
    }


class SubsonicError(Exception):
    """Raised when the Subsonic server returns status != ok."""


class SubsonicClient:
    """Thin async wrapper around the Subsonic REST API."""

    def __init__(self, server: str, user: str, password: str) -> None:
        self.server = server.rstrip("/")
        self.user   = user
        self.salt   = secrets.token_hex(8)
        self.token  = _md5(password + self.salt)
        self._http  = httpx.AsyncClient(timeout=20.0)

    # ---- auth ----

    def _params(self, **extra: object) -> dict:
        """Base auth params merged with any extras."""
        return {
            "u": self.user, "t": self.token, "s": self.salt,
            "v": _API_VERSION, "c": _CLIENT_NAME, "f": "json",
            **extra,
        }

    # ---- API calls ----

    async def ping(self) -> None:
        """Verify credentials; raises SubsonicError or httpx.HTTPError on failure."""
        r = await self._http.get(f"{self.server}/rest/ping", params=self._params())
        r.raise_for_status()
        resp = r.json().get("subsonic-response", {})
        if resp.get("status") != "ok":
            msg = resp.get("error", {}).get("message", "ping failed")
            raise SubsonicError(msg)
        logger.info("subsonic: connected to %s as %s (server %s)",
                    self.server, self.user, resp.get("serverVersion", "?"))

    async def library(self) -> list[dict]:
        """Return all songs via paginated search3 (empty query = all tracks)."""
        songs: list[dict] = []
        offset = 0
        while len(songs) < _MAX_SONGS:
            r = await self._http.get(
                f"{self.server}/rest/search3",
                params=self._params(
                    query="", songCount=_PAGE_SIZE, songOffset=offset,
                    albumCount=0, albumOffset=0, artistCount=0, artistOffset=0,
                ),
            )
            r.raise_for_status()
            resp = r.json().get("subsonic-response", {})
            if resp.get("status") != "ok":
                raise SubsonicError(resp.get("error", {}).get("message", "search3 failed"))
            batch = resp.get("searchResult3", {}).get("song", [])
            if not batch:
                break
            # search3 may return a single dict instead of a list for a 1-result page.
            if isinstance(batch, dict):
                batch = [batch]
            songs.extend(_normalize_song(s) for s in batch)
            if len(batch) < _PAGE_SIZE:
                break
            offset += _PAGE_SIZE
        logger.info("subsonic: library fetched %d tracks", len(songs))
        return songs

    def stream_url(self, song_id: str) -> str:
        """Build a direct stream URL; the frontend uses this for <audio src>."""
        params = self._params(id=song_id)
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        return f"{self.server}/rest/stream?{qs}"

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._http.aclose()


class SubsonicProxy:
    """Holds an optional SubsonicClient; replaced on each connect."""

    def __init__(self) -> None:
        self._client: SubsonicClient | None = None

    @property
    def connected(self) -> bool:
        return self._client is not None

    # Expose connection params directly so routes can read them without going
    # through _client (avoids None checks everywhere).
    @property
    def server(self) -> str:
        return self._client.server if self._client else ""

    @property
    def user(self) -> str:
        return self._client.user if self._client else ""

    @property
    def token(self) -> str:
        return self._client.token if self._client else ""

    @property
    def salt(self) -> str:
        return self._client.salt if self._client else ""

    async def connect(self, server: str, user: str, password: str) -> None:
        """Replace any existing client with a fresh one and verify credentials."""
        if self._client:
            await self._client.close()
        client = SubsonicClient(server, user, password)
        await client.ping()   # raises on failure before we accept the new client
        self._client = client

    async def disconnect(self) -> None:
        """Close the HTTP client and clear state."""
        if self._client:
            await self._client.close()
        self._client = None
        logger.info("subsonic: disconnected")

    async def library(self) -> list[dict]:
        """Delegate to the active client; raises if not connected."""
        if not self._client:
            raise SubsonicError("not connected")
        return await self._client.library()
