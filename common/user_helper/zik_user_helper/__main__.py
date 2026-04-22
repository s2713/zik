import os
from pathlib import Path

import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route


async def whoami(_request):
    return JSONResponse({"server_uid": os.getuid()})


app = Starlette(routes=[Route("/whoami", whoami)])


def _socket_path() -> Path:
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime_dir:
        raise RuntimeError("XDG_RUNTIME_DIR is not set; cannot bind user-helper socket")
    return Path(runtime_dir) / "zik.sock"


def main() -> None:
    sock = _socket_path()
    if sock.exists():
        sock.unlink()
    uvicorn.run(app, uds=str(sock), log_level="info")


if __name__ == "__main__":
    main()
