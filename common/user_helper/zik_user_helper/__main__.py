import os
from pathlib import Path

import uvicorn

from .app import app
from .peercred import PeerCredH11Protocol


def _socket_path() -> Path:
    """Resolve the unix socket path from env, with XDG fallback."""
    explicit = os.environ.get("ZIK_HELPER_SOCKET")
    if explicit:
        return Path(explicit)
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime_dir:
        raise RuntimeError("ZIK_HELPER_SOCKET or XDG_RUNTIME_DIR must be set")
    return Path(runtime_dir) / "zik.sock"


def main() -> None:
    """Start the per-user helper on a unix domain socket."""
    sock = _socket_path()
    if sock.exists():
        sock.unlink()
    uvicorn.run(
        app,  # type: ignore[arg-type]
        uds=str(sock),
        log_level="info",
        http=PeerCredH11Protocol,  # inject SO_PEERCRED into every request scope
    )


if __name__ == "__main__":
    main()
