import json
from dataclasses import asdict, dataclass
from typing import Literal

from starlette.websockets import WebSocket, WebSocketDisconnect


@dataclass
class TrackInfo:
    id:       str
    title:    str
    duration: float  # seconds
    artist:   str = ""
    album:    str = ""
    art_url:  str = ""
    service:  str = ""


@dataclass
class PlayerState:
    status: Literal["playing", "paused", "stopped"] = "stopped"
    track:  TrackInfo | None = None
    position: float = 0.0
    volume:   float = 1.0


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
        """Accept a bridge WebSocket; bidirectional: bridge may send commands back."""
        await ws.accept()
        self._bridges.add(ws)
        # Push current state immediately so the bridge doesn't wait for the next command.
        await ws.send_json(state_as_dict(self.state))
        try:
            async for raw in ws.iter_text():
                # Commands from the bridge (e.g. media keys) update state and fan out.
                try:
                    cmd = json.loads(raw)
                    self.apply_command(cmd)
                    await self.broadcast(state_as_dict(self.state))
                except (json.JSONDecodeError, KeyError):
                    pass
        except WebSocketDisconnect:
            pass
        finally:
            self._bridges.discard(ws)

    async def broadcast(self, event: dict) -> None:
        """Push a JSON event to all connected MPRIS bridges; drop dead sockets."""
        dead: set[WebSocket] = set()
        for ws in set(self._bridges):
            try:
                await ws.send_json(event)
            except Exception:
                dead.add(ws)
        self._bridges -= dead

    # ---- command handling ----

    def apply_command(self, cmd: dict) -> None:
        """Mutate state based on a command dict from the frontend or bridge."""
        kind = cmd.get("type", "")

        if "track_id" in cmd:
            self.state.track = TrackInfo(
                id=cmd["track_id"],
                title=str(cmd.get("title", "")),
                duration=float(cmd.get("duration", 0)),
                artist=str(cmd.get("artist", "")),
                album=str(cmd.get("album", "")),
                art_url=str(cmd.get("art_url", "")),
                service=str(cmd.get("service", "")),
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
        elif kind == "Seek":
            self.state.position = float(cmd.get("position", self.state.position))
        elif kind == "SetVolume":
            self.state.volume = max(0.0, min(1.0, float(cmd.get("volume", self.state.volume))))
