"""librespot subprocess management.

Degrades gracefully when the binary is not installed: a warning is logged and
playback falls back to whichever Spotify Connect device the user has active.
"""

import asyncio
import logging
import shutil

logger = logging.getLogger(__name__)

DEVICE_NAME = "zik"
_BINARY     = "librespot"


class LibrespotProcess:
    """Manages a single librespot child process."""

    def __init__(self) -> None:
        self._proc: asyncio.subprocess.Process | None = None

    @property
    def available(self) -> bool:
        """True when the librespot binary exists on PATH."""
        return shutil.which(_BINARY) is not None

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    async def start(self, access_token: str) -> bool:
        """
        Launch librespot using the given OAuth access token.
        Returns True on success, False if binary is absent or launch fails.
        """
        if self.running:
            return True
        if not self.available:
            logger.warning(
                "librespot not found on PATH — audio will play on whichever "
                "Spotify Connect device is currently active; "
                "install librespot to enable on-device playback"
            )
            return False
        cmd = [
            _BINARY,
            "--name",         DEVICE_NAME,
            "--access-token", access_token,
            "--bitrate",      "320",
            "--disable-audio-cache",
        ]
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            logger.info("librespot: started (pid %d, device '%s')",
                        self._proc.pid, DEVICE_NAME)
            return True
        except OSError as exc:
            logger.warning("librespot: failed to start: %s", exc)
            self._proc = None
            return False

    async def stop(self) -> None:
        """Terminate the librespot process if running."""
        if self._proc and self._proc.returncode is None:
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=3.0)
            except TimeoutError:
                self._proc.kill()
            logger.info("librespot: stopped")
        self._proc = None
