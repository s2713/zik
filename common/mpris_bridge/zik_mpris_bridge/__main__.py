"""zik MPRIS bridge — exposes playback state on the session D-Bus.

Connects to the backend WebSocket, translates state events into MPRIS2
property updates, and forwards media-key method calls back via the same
WebSocket connection.

Run with:  zik-mpris-bridge
or:        python -m zik_mpris_bridge
"""

import asyncio
import json
import logging
import os

from dbus_fast import BusType, PropertyAccess, Variant
from dbus_fast.aio import MessageBus
from dbus_fast.service import ServiceInterface, dbus_property, method
from websockets import ConnectionClosed
from websockets.asyncio.client import connect

logger = logging.getLogger(__name__)

_BUS_NAME    = "org.mpris.MediaPlayer2.zik"
_OBJECT_PATH = "/org/mpris/MediaPlayer2"
_TRACK_ID    = "/org/zik/track/0"


# ---------------------------------------------------------------------------
# D-Bus interfaces
# ---------------------------------------------------------------------------

class _MediaPlayer2(ServiceInterface):
    """org.mpris.MediaPlayer2 — top-level, read-only identity properties."""

    def __init__(self) -> None:
        super().__init__("org.mpris.MediaPlayer2")

    @dbus_property(access=PropertyAccess.READ)
    def Identity(self) -> "s":          # noqa: N802
        return "zik"

    @dbus_property(access=PropertyAccess.READ)
    def CanQuit(self) -> "b":           # noqa: N802
        return False

    @dbus_property(access=PropertyAccess.READ)
    def CanRaise(self) -> "b":          # noqa: N802
        return False

    @dbus_property(access=PropertyAccess.READ)
    def HasTrackList(self) -> "b":      # noqa: N802
        return False

    @dbus_property(access=PropertyAccess.READ)
    def SupportedMimeTypes(self) -> "as":   # noqa: N802
        return []

    @dbus_property(access=PropertyAccess.READ)
    def SupportedUriSchemes(self) -> "as":  # noqa: N802
        return []


class _Player(ServiceInterface):
    """org.mpris.MediaPlayer2.Player — live state + control methods."""

    def __init__(self, cmd_queue: asyncio.Queue) -> None:
        super().__init__("org.mpris.MediaPlayer2.Player")
        self._q = cmd_queue
        # Internal shadow of the last broadcast state.
        self._pb_status  = "Stopped"
        self._metadata:  dict = {}
        self._volume     = 1.0
        self._position   = 0   # µs

    # ---- called from the WS listener task ----

    def apply_state(self, state: dict) -> None:
        """Update shadow state and emit PropertiesChanged as needed."""
        # emit_properties_changed expects raw Python values — it wraps them
        # in Variant internally using the declared property type signatures.
        changed: dict = {}

        # PlaybackStatus
        raw = state.get("status", "stopped")
        new_status = {"playing": "Playing", "paused": "Paused", "stopped": "Stopped"}.get(
            raw, "Stopped"
        )
        if new_status != self._pb_status:
            self._pb_status = new_status
            changed["PlaybackStatus"] = new_status

        # Metadata
        track    = state.get("track") or {}
        new_meta = self._build_metadata(track)
        if new_meta != self._metadata:
            self._metadata = new_meta
            changed["Metadata"] = new_meta

        # Position (µs) — always update but not in PropertiesChanged (too noisy)
        self._position = int(state.get("position", 0) * 1_000_000)

        # Volume
        vol = float(state.get("volume", 1.0))
        if abs(vol - self._volume) > 0.001:
            self._volume = vol
            changed["Volume"] = vol

        if changed:
            self.emit_properties_changed(changed)

    @staticmethod
    def _build_metadata(track: dict) -> dict:
        meta: dict[str, Variant] = {
            "mpris:trackid": Variant("o", _TRACK_ID),
            "xesam:title":   Variant("s", track.get("title", "")),
            "mpris:length":  Variant("x", int(track.get("duration", 0) * 1_000_000)),
        }
        if artist := track.get("artist"):
            meta["xesam:artist"] = Variant("as", [artist])
        if album := track.get("album"):
            meta["xesam:album"] = Variant("s", album)
        if art_url := track.get("art_url"):
            meta["mpris:artUrl"] = Variant("s", art_url)
        return meta

    # ---- D-Bus read properties ----

    @dbus_property(access=PropertyAccess.READ)
    def PlaybackStatus(self) -> "s":    # noqa: N802
        return self._pb_status

    @dbus_property(access=PropertyAccess.READ)
    def Rate(self) -> "d":              # noqa: N802
        return 1.0

    @dbus_property(access=PropertyAccess.READ)
    def Shuffle(self) -> "b":           # noqa: N802
        return False

    @dbus_property(access=PropertyAccess.READ)
    def Metadata(self) -> "a{sv}":      # noqa: N802
        return self._metadata or self._build_metadata({})

    @dbus_property(access=PropertyAccess.READ)
    def Volume(self) -> "d":            # noqa: N802
        return self._volume

    @dbus_property(access=PropertyAccess.READ)
    def Position(self) -> "x":          # noqa: N802
        return self._position

    @dbus_property(access=PropertyAccess.READ)
    def MinimumRate(self) -> "d":       # noqa: N802
        return 1.0

    @dbus_property(access=PropertyAccess.READ)
    def MaximumRate(self) -> "d":       # noqa: N802
        return 1.0

    @dbus_property(access=PropertyAccess.READ)
    def CanGoNext(self) -> "b":         # noqa: N802
        return True

    @dbus_property(access=PropertyAccess.READ)
    def CanGoPrevious(self) -> "b":     # noqa: N802
        return True

    @dbus_property(access=PropertyAccess.READ)
    def CanPlay(self) -> "b":           # noqa: N802
        return True

    @dbus_property(access=PropertyAccess.READ)
    def CanPause(self) -> "b":          # noqa: N802
        return True

    @dbus_property(access=PropertyAccess.READ)
    def CanSeek(self) -> "b":           # noqa: N802
        return True

    @dbus_property(access=PropertyAccess.READ)
    def CanControl(self) -> "b":        # noqa: N802
        return True

    # ---- D-Bus control methods ----

    @method()
    def Play(self) -> None:             # noqa: N802
        self._q.put_nowait({"type": "Play"})

    @method()
    def Pause(self) -> None:            # noqa: N802
        self._q.put_nowait({"type": "Pause"})

    @method()
    def PlayPause(self) -> None:        # noqa: N802
        if self._pb_status == "Playing":
            self._q.put_nowait({"type": "Pause"})
        else:
            self._q.put_nowait({"type": "Play"})

    @method()
    def Stop(self) -> None:             # noqa: N802
        self._q.put_nowait({"type": "Stop"})

    @method()
    def Next(self) -> None:             # noqa: N802
        self._q.put_nowait({"type": "Next"})

    @method()
    def Previous(self) -> None:         # noqa: N802
        self._q.put_nowait({"type": "Previous"})

    @method()
    def Seek(self, offset: "x") -> None:    # noqa: N802
        # offset is µs; convert to absolute position in seconds
        new_pos = max(0, self._position + offset)
        self._q.put_nowait({"type": "Seek", "position": new_pos / 1_000_000})

    @method()
    def SetPosition(self, _track_id: "o", position: "x") -> None:  # noqa: N802
        self._q.put_nowait({"type": "Seek", "position": position / 1_000_000})

    @method()
    def OpenUri(self, _uri: "s") -> None:   # noqa: N802
        pass  # not implemented in v1


# ---------------------------------------------------------------------------
# Bridge loop
# ---------------------------------------------------------------------------

async def _bridge_loop(ws_url: str) -> None:
    """Outer loop: (re)connects to the backend WS and registers on D-Bus."""
    bus = await MessageBus(bus_type=BusType.SESSION).connect()

    root   = _MediaPlayer2()
    cmd_q:  asyncio.Queue = asyncio.Queue()
    player = _Player(cmd_q)

    bus.export(_OBJECT_PATH, root)
    bus.export(_OBJECT_PATH, player)
    await bus.request_name(_BUS_NAME)
    logger.info("mpris-bridge: registered %s on session bus", _BUS_NAME)

    backoff = 2.0
    while True:
        try:
            async with connect(ws_url) as ws:
                logger.info("mpris-bridge: connected to %s", ws_url)
                backoff = 2.0

                async def _send_commands() -> None:
                    # Forward commands from D-Bus methods back to the backend.
                    while True:
                        cmd = await cmd_q.get()
                        await ws.send(json.dumps(cmd))

                cmd_task = asyncio.create_task(_send_commands())
                try:
                    async for raw in ws:
                        try:
                            state = json.loads(raw)
                            player.apply_state(state)
                        except (json.JSONDecodeError, KeyError) as exc:
                            logger.debug("mpris-bridge: bad message: %s", exc)
                finally:
                    cmd_task.cancel()

        except (OSError, ConnectionClosed) as exc:
            logger.warning(
                "mpris-bridge: disconnected (%s); retrying in %.0fs", exc, backoff
            )
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)


def main() -> None:
    backend_url = os.environ.get("ZIK_BACKEND_URL", "ws://127.0.0.1:8173")
    url = f"{backend_url}/api/ws/mpris-bridge"
    logging.basicConfig(level=logging.INFO)
    asyncio.run(_bridge_loop(url))


if __name__ == "__main__":
    main()
