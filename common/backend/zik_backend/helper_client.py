import httpx


class HelperClient:
    """Async client that talks to the per-user helper (P2) over its unix socket."""

    def __init__(self, socket_path: str) -> None:
        self._socket_path = socket_path

    async def get_whoami(self) -> dict:
        """Call GET /whoami on the helper; return the parsed JSON dict."""
        transport = httpx.AsyncHTTPTransport(uds=self._socket_path)
        # The hostname in the URL is ignored by the unix-socket transport.
        async with httpx.AsyncClient(transport=transport, base_url="http://zik-helper") as client:
            response = await client.get("/whoami")
            response.raise_for_status()
            return response.json()
