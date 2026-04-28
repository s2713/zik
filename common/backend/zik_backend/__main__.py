import os

import uvicorn

from .app import app


def main() -> None:
    host = os.environ.get("ZIK_BACKEND_HOST", "127.0.0.1")
    port = int(os.environ.get("ZIK_BACKEND_PORT", "8173"))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
