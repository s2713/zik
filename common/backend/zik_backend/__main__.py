import os

import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route


async def health(_request):
    return JSONResponse({"ok": True, "service": "zik-backend"})


app = Starlette(routes=[Route("/api/health", health)])


def main() -> None:
    host = os.environ.get("ZIK_BACKEND_HOST", "127.0.0.1")
    port = int(os.environ.get("ZIK_BACKEND_PORT", "8173"))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
