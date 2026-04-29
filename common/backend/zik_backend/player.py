from dataclasses import asdict, dataclass
from typing import Literal

from starlette.websockets import WebSocket, WebSocketDisconnect


@dataclass
class TrackInfo:
    id: str
    title: str
    duration: float  # seconds


@dataclass
class PlayerState:
    status: Literal["playing", "paused", "stopped"] = "stopped"
    track: TrackInfo | None = None
    position: float = 0.0
    volume: float = 1.0


def state_as_dict(state: PlayerState) -> dict:
    """Serialise PlayerState to a plain dict (handles nested TrackInfo)."""
    return asdict(state)


class PlayerManager:
    """Hold playback state and fan out MPRIS events to connected bridge sockets."""

    def __init__(self) -> None:
        self.state = PlayerState()
        self._bridges: set[WebSocket] = set()

    # ---- bridge connection lifecycle ----

    async def add_bridge(self, ws: WebSocket) -> None:
        """Accept a bridge WebSocket and hold it open until the client disconnects."""
        await ws.accept()
        self._bridges.add(ws)
        try:
            # The bridge only listens; drain unexpected messages to keep the loop alive.
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            self._bridges.discard(ws)

    async def broadcast(self, event: dict) -> None:
        """Push a JSON event to all connected MPRIS bridges; drop dead sockets."""
        dead: set[WebSocket] = set()
        for ws in set(self._bridges):  # snapshot to allow mutation during iteration
            try:
                await ws.send_json(event)
            except Exception:
                dead.add(ws)
        self._bridges -= dead

    # ---- command handling ----

    def apply_command(self, cmd: dict) -> None:
        """Mutate state based on a command dict from the frontend."""
        kind = cmd.get("type", "")

        # Extract optional track metadata shared by several commands.
        if "track_id" in cmd:
            self.state.track = TrackInfo(
                id=cmd["track_id"],
                title=str(cmd.get("title", "")),
                duration=float(cmd.get("duration", 0)),
            )

        if kind == "Play":
            self.state.status = "playing"
            self.state.position = float(cmd.get("position", self.state.position))
        elif kind == "Pause":
            self.state.status = "paused"
            self.state.position = float(cmd.get("position", self.state.position))
        elif kind == "Stop":
            self.state.status = "stopped"
            self.state.position = 0.0
        elif kind in ("Next", "Previous"):
            self.state.position = 0.0
            # Status unchanged — frontend preserves playing/stopped across track changes.
        elif kind == "Seek":
            self.state.position = float(cmd.get("position", self.state.position))
        elif kind == "SetVolume":
            self.state.volume = max(0.0, min(1.0, float(cmd.get("volume", self.state.volume))))
