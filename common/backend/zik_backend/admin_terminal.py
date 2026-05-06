"""Admin terminal — WebSocket PTY endpoint (Target 1 demo).

Spawns a PTY subprocess running the system shell.  Admin re-auth must be
fresh within TERMINAL_REAUTH_TTL seconds before the WebSocket is accepted.
Any 60-second period with no client input closes the session automatically.

Protocol (binary-framed WebSocket):
  client → server  binary: raw terminal bytes (keyboard input)
  client → server  text:   JSON control message {"type":"resize","cols":N,"rows":N}
  server → client  binary: raw terminal output bytes
"""

import asyncio
import contextlib
import fcntl
import json
import os
import pty
import shutil
import struct
import subprocess
import termios
import time

from starlette.routing import WebSocketRoute
from starlette.websockets import WebSocket, WebSocketState

# How long a completed reauth token grants terminal access.
TERMINAL_REAUTH_TTL = 600   # 10 minutes
# Seconds of no client input before the session is closed.
IDLE_TIMEOUT = 60

_SHELL = shutil.which("zsh") or shutil.which("bash") or "/bin/sh"

# Default PTY size before the first client resize message.
_DEFAULT_COLS = 220
_DEFAULT_ROWS = 50


def _set_winsize(fd: int, rows: int, cols: int) -> None:
    """Send TIOCSWINSZ ioctl to set the PTY window size."""
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def _read_pty(fd: int) -> bytes:
    """Blocking read from PTY master; returns b'' on EOF, raises OSError on error."""
    try:
        return os.read(fd, 4096)
    except OSError:
        return b""


def make_admin_terminal_router(sessions: dict) -> list:
    """Return Starlette Route list for the admin PTY WebSocket."""

    def _auth_ok(websocket: WebSocket) -> bool:
        """True if the WebSocket caller is an admin with a fresh enough reauth stamp."""
        sid = websocket.cookies.get("__Host-zik-session")
        if not sid or sid not in sessions:
            return False
        s = sessions[sid]
        if not s.get("is_admin"):
            return False
        at = s.get("reauth_at")
        return at is not None and (time.monotonic() - at) < TERMINAL_REAUTH_TTL

    async def terminal_ws(websocket: WebSocket) -> None:
        """Bidirectional PTY ↔ WebSocket bridge with idle timeout."""
        if not _auth_ok(websocket):
            await websocket.close(code=4403)
            return

        await websocket.accept()

        # Open a PTY pair and spawn the shell.
        master_fd, slave_fd = pty.openpty()
        _set_winsize(master_fd, _DEFAULT_ROWS, _DEFAULT_COLS)
        os.set_inheritable(slave_fd, True)

        def _child_setup() -> None:
            # After setsid() the child has no controlling terminal; acquire the
            # slave PTY as one so the shell enables job control and shows prompts.
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        proc = subprocess.Popen(
            [_SHELL, "-i"],          # -i forces interactive mode
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            start_new_session=True,  # setsid() → new session leader, no ctty yet
            preexec_fn=_child_setup, # acquire slave PTY as controlling terminal
            env={**os.environ, "TERM": "xterm-256color"},
        )
        os.close(slave_fd)   # parent no longer needs the slave end

        loop = asyncio.get_event_loop()
        last_input = time.monotonic()

        async def _read_task() -> None:
            """Forward PTY output to the WebSocket."""
            while True:
                data = await loop.run_in_executor(None, _read_pty, master_fd)
                if not data:
                    break
                try:
                    await websocket.send_bytes(data)
                except Exception:
                    break

        async def _write_task() -> None:
            """Forward WebSocket input to the PTY; enforce idle timeout."""
            nonlocal last_input
            while True:
                remaining = IDLE_TIMEOUT - (time.monotonic() - last_input)
                if remaining <= 0:
                    break
                try:
                    msg = await asyncio.wait_for(websocket.receive(), timeout=remaining)
                except TimeoutError:
                    break
                except Exception:
                    break

                last_input = time.monotonic()
                if msg.get("type") == "websocket.disconnect":
                    break

                raw = msg.get("bytes")
                if raw:
                    try:
                        os.write(master_fd, raw)
                    except OSError:
                        break

                text = msg.get("text")
                if text:
                    try:
                        ctrl = json.loads(text)
                        if ctrl.get("type") == "resize":
                            _set_winsize(master_fd, int(ctrl["rows"]), int(ctrl["cols"]))
                    except Exception:
                        pass

        read_task  = asyncio.create_task(_read_task())
        write_task = asyncio.create_task(_write_task())

        # Wait for whichever side finishes first.
        await asyncio.wait({read_task, write_task},
                           return_when=asyncio.FIRST_COMPLETED)
        read_task.cancel()
        write_task.cancel()

        # Kill the shell and close the PTY.  Closing master_fd unblocks any
        # in-flight os.read() in the executor thread.
        with contextlib.suppress(ProcessLookupError, OSError):
            proc.kill()
        with contextlib.suppress(OSError):
            os.close(master_fd)

        try:
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.close()
        except Exception:
            pass

    return [
        WebSocketRoute("/api/ws/admin/terminal", terminal_ws),
    ]
