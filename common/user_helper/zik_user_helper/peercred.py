import asyncio
import socket
import struct
from typing import Any

from uvicorn.protocols.http.h11_impl import H11Protocol

# Linux ucred struct: pid_t (i32), uid_t (u32), gid_t (u32).
_UCRED_FMT = "iII"
_UCRED_SIZE = struct.calcsize(_UCRED_FMT)


class PeerCredH11Protocol(H11Protocol):
    """H11Protocol subclass that reads SO_PEERCRED and injects peer_uid into ASGI scope."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._peer_uid: int | None = None  # set in connection_made, read in handle_events

    def connection_made(self, transport: asyncio.Transport) -> None:  # type: ignore[override]
        """Capture peer uid from the unix-domain socket before any request arrives."""
        super().connection_made(transport)
        sock: socket.socket | None = transport.get_extra_info("socket")
        if sock is not None and sock.family == socket.AF_UNIX:
            try:
                raw = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, _UCRED_SIZE)
                _pid, uid, _gid = struct.unpack(_UCRED_FMT, raw)
                self._peer_uid = uid
            except OSError:
                pass  # not a unix socket or SO_PEERCRED unavailable — leave None

    def handle_events(self) -> None:
        """After super builds a fresh scope dict, stamp peer_uid into its extensions."""
        # Save scope identity before super() may create a new one.
        scope_before = getattr(self, "scope", None)
        super().handle_events()
        scope_after = getattr(self, "scope", None)

        # A new dict means a new request was parsed; inject before the asyncio task runs.
        # The task and RequestResponseCycle share the same dict object, so this is visible
        # to the ASGI app even though the task hasn't been awaited yet.
        if scope_after is not scope_before and scope_after is not None:
            scope_after.setdefault("extensions", {})["peer_uid"] = self._peer_uid


def get_peer_uid(scope: dict) -> int | None:
    """Extract peer_uid injected by PeerCredH11Protocol from an ASGI scope."""
    return scope.get("extensions", {}).get("peer_uid")
