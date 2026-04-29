import asyncio
import logging
import os

from websockets import ConnectionClosed
from websockets.asyncio.client import connect

logger = logging.getLogger(__name__)


async def _bridge_loop(url: str) -> None:
    # Connect to backend WS and log events; retry with exponential backoff.
    backoff = 2.0
    while True:
        try:
            async with connect(url) as ws:
                logger.info("mpris-bridge: connected to %s", url)
                backoff = 2.0  # reset on successful connection
                async for raw in ws:
                    logger.info("mpris event: %s", raw)
        except (OSError, ConnectionClosed) as exc:
            logger.warning(
                "mpris-bridge: disconnected (%s); retrying in %.0fs", exc, backoff
            )
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)


async def _main_async(url: str) -> None:
    # Entry point for asyncio.run; runs bridge loop indefinitely.
    await _bridge_loop(url)


def main() -> None:
    backend_url = os.environ.get("ZIK_BACKEND_URL", "ws://127.0.0.1:8173")
    url = f"{backend_url}/api/ws/mpris-bridge"
    logging.basicConfig(level=logging.INFO)
    asyncio.run(_main_async(url))


if __name__ == "__main__":
    main()
