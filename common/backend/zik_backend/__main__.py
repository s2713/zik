import argparse
import copy
import os

import uvicorn
from uvicorn.config import LOGGING_CONFIG


def _log_config() -> dict:
    """Extend uvicorn's default log config so zik_backend.* logs at INFO level."""
    cfg = copy.deepcopy(LOGGING_CONFIG)
    cfg["loggers"]["zik_backend"] = {
        "handlers": ["default"],
        "level": "INFO",
        "propagate": False,
    }
    return cfg


def main() -> None:
    parser = argparse.ArgumentParser(prog="zik-backend")
    parser.add_argument(
        "--maintenance", action="store_true",
        help="Run in maintenance mode (minimal web app on port 7071, no services)",
    )
    args = parser.parse_args()

    host = os.environ.get("ZIK_BACKEND_HOST", "127.0.0.1")

    if args.maintenance:
        from .maintenance_app import app
        port = int(os.environ.get("ZIK_MAINT_PORT", "7071"))
    else:
        from .app import app
        port = int(os.environ.get("ZIK_BACKEND_PORT", "8173"))

    uvicorn.run(app, host=host, port=port, log_level="info", log_config=_log_config())


if __name__ == "__main__":
    main()
