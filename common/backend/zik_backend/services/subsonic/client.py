"""Async Subsonic REST API client.

Auth uses the token+salt method (Subsonic API >= 1.13):
  token = md5(password + salt)
Salt is generated once per connection. The token and salt are returned to the
frontend so it can build stream URLs directly — the password never leaves the
backend.

Library caching:
  The proxy persists each full refresh to $XDG_DATA_HOME/subsonic-cache/<source-id>.json.
  On reconnect the cache is loaded instantly. Quick refresh fetches only albums
  added since the cache was built via getAlbumList2?type=newest; it cannot detect
  deletions or metadata changes — use full refresh for that.
"""

import hashlib
import json
import logging
import os
import secrets
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

_API_VERSION = "1.16.1"
_CLIENT_NAME = "zik"
_PAGE_SIZE = 500      # songs per search3 request
_MAX_SONGS  = 100_000  # safety cap; real termination is an empty page from the server


def _md5(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()


def _cache_dir() -> Path:
    """Return the directory used to persist library JSON caches."""
    base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
    return base / "subsonic-cache"


def _normalize_song(s: dict) -> dict:
    """Flatten a Subsonic song object to the fields our UI needs."""
    return {
        "id":       str(s.get("id", "")),
        "albumId":  str(s.get("albumId", "")),   # kept for quick-refresh deduplication
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

    async def newest_albums(self, size: int = 500) -> list[dict]:
        """Return up to size recently-added albums via getAlbumList2?type=newest."""
        r = await self._http.get(
            f"{self.server}/rest/getAlbumList2",
            params=self._params(type="newest", size=size),
        )
        r.raise_for_status()
        resp = r.json().get("subsonic-response", {})
        if resp.get("status") != "ok":
            raise SubsonicError(resp.get("error", {}).get("message", "getAlbumList2 failed"))
        albums = resp.get("albumList2", {}).get("album", [])
        if isinstance(albums, dict):
            albums = [albums]
        return albums  # list of album dicts with at least "id"

    async def album_songs(self, album_id: str) -> list[dict]:
        """Return all songs in a single album via getAlbum."""
        r = await self._http.get(
            f"{self.server}/rest/getAlbum",
            params=self._params(id=album_id),
        )
        r.raise_for_status()
        resp = r.json().get("subsonic-response", {})
        if resp.get("status") != "ok":
            raise SubsonicError(resp.get("error", {}).get("message", "getAlbum failed"))
        songs = resp.get("album", {}).get("song", [])
        if isinstance(songs, dict):
            songs = [songs]
        return [_normalize_song(s) for s in songs]

    def stream_url(self, song_id: str) -> str:
        """Build a direct stream URL; the frontend uses this for <audio src>."""
        params = self._params(id=song_id)
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        return f"{self.server}/rest/stream?{qs}"

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._http.aclose()


class SubsonicProxy:
    """Holds an optional SubsonicClient plus a persistent per-source library cache."""

    def __init__(self) -> None:
        self._client:    SubsonicClient | None = None
        self._source_id: str | None = None
        self._cache:     list[dict] | None = None  # in-memory; mirrors the on-disk JSON

    # ---- connection properties ----

    @property
    def connected(self) -> bool:
        return self._client is not None

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

    # ---- cache helpers ----

    def _cache_file(self) -> Path | None:
        """Return the JSON cache path for the active source, or None if unknown."""
        if not self._source_id:
            return None
        return _cache_dir() / f"{self._source_id}.json"

    def _load_cache(self) -> None:
        """Populate _cache from disk; silently ignored if absent or corrupt."""
        path = self._cache_file()
        if path and path.exists():
            try:
                self._cache = json.loads(path.read_text())
                logger.info("subsonic: loaded %d cached tracks from %s",
                            len(self._cache), path)
            except Exception:
                self._cache = None

    def _save_cache(self) -> None:
        """Persist the in-memory cache to disk."""
        path = self._cache_file()
        if path is None or self._cache is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(self._cache))
        except OSError as exc:
            logger.warning("subsonic: could not save library cache: %s", exc)

    # ---- public interface ----

    async def connect(self, server: str, user: str, password: str,
                      source_id: str | None = None) -> None:
        """Replace any existing client with a fresh one, verify credentials, load cache."""
        if self._client:
            await self._client.close()
        client = SubsonicClient(server, user, password)
        await client.ping()   # raises on failure before we accept the new client
        self._client    = client
        self._source_id = source_id
        self._cache     = None
        self._load_cache()

    async def disconnect(self) -> None:
        """Close the HTTP client and clear state (cache remains on disk)."""
        if self._client:
            await self._client.close()
        self._client    = None
        self._source_id = None
        self._cache     = None
        logger.info("subsonic: disconnected")

    def cached_library(self) -> list[dict]:
        """Return the in-memory cache (may be empty if never fetched)."""
        return self._cache or []

    async def library(self) -> list[dict]:
        """Full refresh: fetch all songs from the server, update and save cache."""
        if not self._client:
            raise SubsonicError("not connected")
        tracks = await self._client.library()
        self._cache = tracks
        self._save_cache()
        return tracks

    async def quick_library(self) -> list[dict]:
        """Quick refresh: fetch recently added albums, merge into cache, save.

        Only detects additions. Deletions and metadata changes require a full refresh.
        Returns the merged library.
        """
        if not self._client:
            raise SubsonicError("not connected")

        known_album_ids = {t.get("albumId", "") for t in (self._cache or [])}

        albums = await self._client.newest_albums(size=500)
        new_tracks: list[dict] = []
        for album in albums:
            if album.get("id", "") not in known_album_ids:
                songs = await self._client.album_songs(album["id"])
                new_tracks.extend(songs)

        if new_tracks:
            self._cache = (self._cache or []) + new_tracks
            self._save_cache()
            logger.info("subsonic: quick refresh added %d tracks", len(new_tracks))
        else:
            logger.info("subsonic: quick refresh — no new albums found")

        return self._cache or []
