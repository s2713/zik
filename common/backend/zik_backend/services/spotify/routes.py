"""HTTP routes for the Spotify service."""

import logging
import secrets

import httpx
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.routing import Route

from ..files.db import LibraryDB
from .api import SpotifyApi
from .auth import build_auth_url, exchange_code, make_pkce_pair
from .librespot import DEVICE_NAME, LibrespotProcess

logger = logging.getLogger(__name__)

# In-memory PKCE store: state_token → code_verifier.
# Entries are consumed (popped) on callback; no expiry needed for demo.
_pkce: dict[str, str] = {}

_DB_ACCESS  = "spotify.access_token"
_DB_REFRESH = "spotify.refresh_token"
_DB_EXPIRY  = "spotify.expires_at"

_SUCCESS_HTML = """<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>Spotify — authenticated</title>
<meta http-equiv="refresh" content="1;url={frontend_url}">
</head><body style="font-family:sans-serif;padding:2rem">
<p>&#10003; Spotify connected. Returning to the app&hellip;</p>
</body></html>"""

_ERROR_HTML = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Spotify — error</title></head>
<body style="font-family:sans-serif;padding:2rem">
<p style="color:#c00">&#10007; {message}</p>
<p><a href="{frontend_url}">Return to the app</a></p>
</body></html>"""


def make_spotify_router(
    api: SpotifyApi,
    librespot: LibrespotProcess,
    db: LibraryDB,
    client_id: str,
    redirect_uri: str,
    frontend_url: str,
) -> list:
    """Return Starlette Route objects; all args captured by closure."""

    # ---- OAuth ----

    async def auth_start(_request: Request) -> RedirectResponse | JSONResponse:
        """Redirect the browser to the Spotify authorization page."""
        if not client_id:
            return JSONResponse(
                {"error": "ZIK_SPOTIFY_CLIENT_ID is not configured"}, status_code=400
            )
        verifier, challenge = make_pkce_pair()
        state = secrets.token_urlsafe(16)
        _pkce[state] = verifier
        url = build_auth_url(client_id, redirect_uri, state, challenge)
        return RedirectResponse(url, status_code=307)

    async def auth_callback(request: Request) -> HTMLResponse:
        """Handle Spotify's redirect; exchange code for tokens and start librespot."""
        code  = request.query_params.get("code", "")
        state = request.query_params.get("state", "")
        error = request.query_params.get("error", "")

        def _err(msg: str) -> HTMLResponse:
            return HTMLResponse(_ERROR_HTML.format(message=msg, frontend_url=frontend_url))

        if error:
            return _err(f"Spotify returned: {error}")
        verifier = _pkce.pop(state, None)
        if not verifier:
            return _err("Invalid or expired state token. Please try again.")
        if not code:
            return _err("No authorization code received.")

        try:
            td = await exchange_code(client_id, redirect_uri, code, verifier)
        except (httpx.HTTPError, KeyError) as exc:
            return _err(f"Token exchange failed: {exc}")

        api.store_token_dict(td)
        await db.set_setting(_DB_ACCESS,  api.access_token)
        await db.set_setting(_DB_REFRESH, api.refresh_token)
        await db.set_setting(_DB_EXPIRY,  str(api.expires_at))
        logger.info("spotify: authenticated via OAuth callback")

        # Start librespot with the fresh access token (best-effort).
        await librespot.start(api.access_token)

        return HTMLResponse(_SUCCESS_HTML.format(frontend_url=frontend_url))

    # ---- status ----

    async def status(_request: Request) -> JSONResponse:
        """Return auth state, librespot status, and current playback."""
        if not api.authed:
            return JSONResponse({
                "authed": False,
                "librespot_available": librespot.available,
                "librespot_running":   librespot.running,
            })
        try:
            pb = await api.current_playback()
        except (httpx.HTTPError, Exception) as exc:
            logger.debug("spotify: status probe failed: %s", exc)
            pb = {}

        track = None
        if pb.get("item"):
            item = pb["item"]
            artists = item.get("artists") or []
            track = {
                "id":          item.get("id", ""),
                "uri":         item.get("uri", ""),
                "title":       item.get("name", ""),
                "artist":      ", ".join(a.get("name", "") for a in artists),
                "album":       (item.get("album") or {}).get("name", ""),
                "duration_ms": item.get("duration_ms", 0),
            }

        device = pb.get("device") or {}
        return JSONResponse({
            "authed":              True,
            "librespot_available": librespot.available,
            "librespot_running":   librespot.running,
            "playing":             pb.get("is_playing", False),
            "progress_ms":         pb.get("progress_ms", 0),
            "volume_pct":          device.get("volume_percent", 100),
            "device_id":           device.get("id", ""),
            "device_name":         device.get("name", ""),
            "librespot_device":    DEVICE_NAME,
            "track":               track,
        })

    # ---- devices ----

    async def devices_list(_request: Request) -> JSONResponse:
        """Return available Spotify Connect devices."""
        if not api.authed:
            return JSONResponse({"error": "not authenticated"}, status_code=401)
        try:
            devs = await api.devices()
        except (httpx.HTTPError, Exception) as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        return JSONResponse(devs)

    # ---- library ----

    async def library(_request: Request) -> JSONResponse:
        """Return the user's saved tracks."""
        if not api.authed:
            return JSONResponse({"error": "not authenticated"}, status_code=401)
        try:
            tracks = await api.saved_tracks()
        except (httpx.HTTPError, Exception) as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        logger.info("spotify: library returned %d tracks", len(tracks))
        return JSONResponse(tracks)

    # ---- playback commands ----

    async def command(request: Request) -> JSONResponse:
        """Dispatch a playback command to the Spotify API."""
        if not api.authed:
            return JSONResponse({"error": "not authenticated"}, status_code=401)
        body     = await request.json()
        cmd_type = body.get("type", "")
        device   = body.get("device_id", "")
        try:
            match cmd_type:
                case "Play":
                    uris = body.get("uris")
                    await api.play(device_id=device, uris=uris)
                case "Pause":
                    await api.pause(device_id=device)
                case "Next":
                    await api.next_track(device_id=device)
                case "Previous":
                    await api.previous_track(device_id=device)
                case "Seek":
                    await api.seek(int(body.get("position_ms", 0)), device_id=device)
                case "Volume":
                    await api.set_volume(int(body.get("percent", 100)), device_id=device)
                case "Transfer":
                    await api.transfer(device, play=body.get("play", False))
                case _:
                    return JSONResponse({"error": f"unknown command: {cmd_type}"}, status_code=400)
        except (httpx.HTTPError, Exception) as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        return JSONResponse({"ok": True})

    # ---- librespot restart ----

    async def restart_librespot(_request: Request) -> JSONResponse:
        """Restart librespot using the current access token (no OAuth needed).

        Intended for recovery when the backend was restarted or librespot
        crashed but valid tokens are still stored.
        """
        if not api.authed:
            return JSONResponse({"error": "not authenticated"}, status_code=401)
        try:
            token = await api._token()  # refresh if needed
            await librespot.stop()
            await librespot.start(token)
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        return JSONResponse({"ok": True, "running": librespot.running})

    # ---- disconnect ----

    async def disconnect(_request: Request) -> JSONResponse:
        """Clear stored tokens and stop librespot."""
        api.clear()
        await librespot.stop()
        await db.set_setting(_DB_ACCESS,  "")
        await db.set_setting(_DB_REFRESH, "")
        await db.set_setting(_DB_EXPIRY,  "0")
        return JSONResponse({"ok": True, "authed": False})

    return [
        Route("/api/spotify/auth/start",          auth_start),
        Route("/api/spotify/auth/callback",        auth_callback),
        Route("/api/spotify/status",               status),
        Route("/api/spotify/devices",              devices_list),
        Route("/api/spotify/library",              library),
        Route("/api/spotify/command",              command,            methods=["POST"]),
        Route("/api/spotify/librespot/restart",    restart_librespot,  methods=["POST"]),
        Route("/api/spotify/disconnect",           disconnect,         methods=["POST"]),
    ]
