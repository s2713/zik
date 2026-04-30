"""Async MPD client proxy using the synchronous python-mpd2 client in a thread executor.

mpd.asyncio.MPDClient runs an internal idle loop as event-loop callbacks that cannot
be co-ordinated with application-level locking; it breaks whenever two coroutines use
the same client concurrently (e.g. a status poll racing a library fetch).

Using the synchronous MPDClient through a single-worker ThreadPoolExecutor gives
natural serialisation without any idle-loop interference.
"""

import asyncio
import contextlib
import logging
from concurrent.futures import ThreadPoolExecutor

from mpd import MPDClient
from mpd.base import CommandError
from mpd.base import ConnectionError as MPDConnectionError

logger = logging.getLogger(__name__)


class MpdProxy:
    """Holds a single MPD connection; all commands serialised through a 1-worker pool."""

    def __init__(self) -> None:
        self._client = MPDClient()
        self._connected = False
        # Single worker: commands are always sequential, no idle-loop conflicts.
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mpd")
        self.host: str = ""
        self.port: int = 6600
        self.password: str = ""
        self.stream_url: str = ""  # HTTP stream URL; audio plays client-side

    @property
    def connected(self) -> bool:
        """True when a live MPD connection is held."""
        return self._connected

    async def connect(
        self, host: str, port: int, password: str = "", stream_url: str = ""
    ) -> None:
        """Open (or re-open) connection to MPD. Raises on failure."""
        def _do() -> None:
            with contextlib.suppress(Exception):
                self._client.disconnect()
            self._connected = False
            self._client.connect(host, port)
            if password:
                self._client.password(password)
            self._connected = True
            self.host, self.port, self.password = host, port, password
            self.stream_url = stream_url
            logger.info("mpd: connected to %s:%d", host, port)

        await self._run(_do)

    async def disconnect(self) -> None:
        """Close the MPD connection if open."""
        def _do() -> None:
            with contextlib.suppress(Exception):
                self._client.disconnect()
            self._connected = False
            logger.info("mpd: disconnected")

        await self._run(_do)

    async def status(self) -> dict:
        """Return MPD status dict."""
        return await self._run(self._client.status)

    async def currentsong(self) -> dict:
        """Return currently playing song metadata dict."""
        return await self._run(self._client.currentsong)

    async def library(self) -> list[dict]:
        """Return all tracks via paginated search (500 per request, window param)."""
        def _do() -> list:
            tracks: list = []
            page = 500
            offset = 0
            while True:
                try:
                    # MPD >= 0.21 supports `window START:END` to page results.
                    batch = self._client.search(
                        "any", "", "window", f"{offset}:{offset + page}"
                    )
                except CommandError:
                    # Older MPD: fall back to one large unbounded fetch.
                    result = self._client.search("any", "")
                    return result if isinstance(result, list) else []
                if not batch:
                    break
                if isinstance(batch, list):
                    tracks.extend(batch)
                    if len(batch) < page:
                        break
                else:
                    # Single-track result returned as a plain dict.
                    tracks.append(batch)
                    break
                offset += page
            return tracks
        raw = await self._run(_do)
        return raw if isinstance(raw, list) else []

    async def play_uri(self, uri: str) -> None:
        """Clear playlist, add uri, and start playback."""
        def _do() -> None:
            self._client.clear()
            self._client.add(uri)
            self._client.play()
        await self._run(_do)

    async def command(self, cmd_type: str, **kwargs: object) -> None:
        """Dispatch a playback command by type name."""
        def _do() -> None:
            match cmd_type:
                case "Pause":
                    self._client.pause(1)
                case "Play" | "Resume":
                    self._client.pause(0)
                case "Stop":
                    self._client.stop()
                case "Next":
                    self._client.next()
                case "Previous":
                    self._client.previous()
                case "Seek":
                    self._client.seekid(
                        str(kwargs.get("songid", "0")), str(kwargs.get("time", "0"))
                    )
                case "SetVolume":
                    self._client.setvol(int(kwargs.get("volume", 100)))
        await self._run(_do)

    # ---- internal ----

    async def _run(self, fn, *args):
        """Submit fn(*args) to the single-worker pool; mark disconnected on errors."""
        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(self._pool, fn, *args)
        except (MPDConnectionError, OSError) as exc:
            logger.warning("mpd: connection lost (%s)", exc, exc_info=True)
            self._connected = False
            raise
        except CommandError:
            raise
