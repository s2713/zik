"""HTTP routes for the Radio service.

Two sources:
- radio-browser.info: community-curated database of ~30k internet radio stations
- SomaFM: ~30 hand-curated commercial-free channels

Station favorites are persisted in the settings DB.
Audio is streamed directly by the browser from the station URL.
"""

import asyncio
import json
import logging

import httpx
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from ..files.db import LibraryDB

logger = logging.getLogger(__name__)

_RB_BASE      = "https://de1.api.radio-browser.info/json"
_SOMAFM_API   = "https://somafm.com/channels.json"
_FAV_KEY      = "radio.favorites"
_TIMEOUT      = 15.0
_UA           = "zik-radio/1.0"
_QUALITY_RANK = {"highest": 3, "high": 2, "low": 1}  # "low">"highest" alphabetically — use int rank


async def _fetch_pls_url(client: httpx.AsyncClient, pls_url: str) -> str:
    """Fetch a .pls playlist file and extract the File1= stream URL."""
    try:
        r = await client.get(pls_url, headers={"User-Agent": _UA})
        r.raise_for_status()
        for line in r.text.splitlines():
            if line.lower().startswith("file1="):
                return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return ""


async def _somafm_get() -> list[dict]:
    """Fetch SomaFM channels and resolve MP3 stream URLs from .pls files.

    Returns a list of processed channel dicts ready to send to the frontend.
    Raises httpx.HTTPError if the channels.json fetch fails.
    PLS resolutions are attempted concurrently; channels that fail are skipped.
    """
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        r = await c.get(_SOMAFM_API, headers={"User-Agent": _UA})
        r.raise_for_status()
        raw_channels: list[dict] = r.json().get("channels", [])

    # Pick the best MP3 playlist per channel; drop channels with no MP3 playlist.
    valid: list[tuple[dict, str]] = []
    for ch in raw_channels:
        playlists = sorted(
            [p for p in ch.get("playlists", []) if p.get("format") == "mp3"],
            key=lambda p: _QUALITY_RANK.get(p.get("quality", ""), 0),
            reverse=True,
        )
        if playlists:
            valid.append((ch, playlists[0]["url"]))

    # Resolve all .pls files concurrently to get the actual ice*.somafm.com URLs.
    async with httpx.AsyncClient(timeout=10.0) as c:
        stream_urls = await asyncio.gather(
            *[_fetch_pls_url(c, pls_url) for _, pls_url in valid]
        )

    channels = []
    for (ch, _), url in zip(valid, stream_urls, strict=False):
        if not url:
            continue
        channels.append({
            "id":          ch.get("id", ""),
            "name":        ch.get("title", ""),
            "description": ch.get("description", ""),
            "image":       ch.get("xlimage") or ch.get("largeimage") or ch.get("image", ""),
            "url":         url,
            "listeners":   ch.get("listeners", 0),
            "genre":       ch.get("genre", ""),
            "source":      "somafm",
        })
    return channels


async def _rb_get(path: str, params: dict | None = None) -> list | dict:
    """GET from radio-browser.info; raises httpx.HTTPError on failure."""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        r = await c.get(
            f"{_RB_BASE}{path}",
            params=params or {},
            headers={"User-Agent": _UA},
        )
        r.raise_for_status()
        return r.json()


def _station_dict(s: dict) -> dict:
    """Normalise a radio-browser station object to the fields we need."""
    return {
        "uuid":    s.get("stationuuid", ""),
        "name":    s.get("name", ""),
        "url":     s.get("url_resolved") or s.get("url", ""),
        "favicon": s.get("favicon", ""),
        "tags":    s.get("tags", ""),
        "country": s.get("country", ""),
        "codec":   s.get("codec", ""),
        "bitrate": int(s.get("bitrate") or 0),
        "votes":   int(s.get("votes") or 0),
        "source":  "radiobrowser",
    }


async def _load_favorites(db: LibraryDB) -> list[dict]:
    raw = await db.get_setting(_FAV_KEY)
    if not raw:
        return []
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return []


async def _save_favorites(db: LibraryDB, favs: list[dict]) -> None:
    await db.set_setting(_FAV_KEY, json.dumps(favs))


def _station_key(s: dict) -> str:
    """Unique key for a station (uuid for radio-browser, url for SomaFM)."""
    return s.get("uuid") or s.get("url", "")


def make_radio_router(db: LibraryDB) -> list:
    """Return Starlette Route objects for the radio service."""

    async def search(request: Request) -> JSONResponse:
        """Search radio-browser by name, tag, or country."""
        q       = request.query_params.get("q", "").strip()
        tag     = request.query_params.get("tag", "").strip()
        country = request.query_params.get("country", "").strip()
        limit   = min(int(request.query_params.get("limit", "30")), 100)
        if not q and not tag and not country:
            return JSONResponse({"error": "q, tag, or country required"}, status_code=400)
        params: dict = {"hidebroken": "true", "limit": limit,
                        "order": "votes", "reverse": "true"}
        if q:
            params["name"] = q
        if tag:
            params["tag"] = tag
        if country:
            params["country"] = country
        try:
            data = await _rb_get("/stations/search", params)
        except httpx.HTTPError as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        return JSONResponse([_station_dict(s) for s in data])

    async def popular(request: Request) -> JSONResponse:
        """Return top stations by vote count."""
        limit = min(int(request.query_params.get("limit", "30")), 100)
        try:
            data = await _rb_get("/stations/topvote",
                                 {"hidebroken": "true", "limit": limit})
        except httpx.HTTPError as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        return JSONResponse([_station_dict(s) for s in data])

    async def tags(_request: Request) -> JSONResponse:
        """Return popular genre tags from radio-browser."""
        try:
            data = await _rb_get("/tags",
                                 {"order": "stationcount", "reverse": "true", "limit": 50})
        except httpx.HTTPError as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        return JSONResponse([
            {"name": t.get("name", ""), "count": t.get("stationcount", 0)}
            for t in data if t.get("name")
        ])

    async def resolve(request: Request) -> JSONResponse:
        """Register a radio-browser click and return the resolved stream URL."""
        uuid = request.path_params["uuid"]
        try:
            data = await _rb_get(f"/url/{uuid}")
        except httpx.HTTPError as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        # API returns a single object; some implementations wrap it in a list.
        obj = data[0] if isinstance(data, list) and data else data
        return JSONResponse({"url": obj.get("url", "") if isinstance(obj, dict) else ""})

    async def somafm(_request: Request) -> JSONResponse:
        """Return SomaFM channels with resolved MP3 stream URLs."""
        try:
            channels = await _somafm_get()
        except httpx.HTTPError as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        return JSONResponse(channels)

    async def list_favorites(_request: Request) -> JSONResponse:
        return JSONResponse(await _load_favorites(db))

    async def add_favorite(request: Request) -> JSONResponse:
        """Add or update a station in favorites."""
        body    = await request.json()
        station = body.get("station")
        if not station or not station.get("url"):
            return JSONResponse({"error": "station with url required"}, status_code=400)
        favs = await _load_favorites(db)
        key  = _station_key(station)
        favs = [f for f in favs if _station_key(f) != key]
        favs.append(station)
        await _save_favorites(db, favs)
        return JSONResponse({"ok": True})

    async def remove_favorite(request: Request) -> JSONResponse:
        """Remove a station from favorites by uuid or url."""
        body = await request.json()
        key  = body.get("uuid") or body.get("url", "")
        favs = await _load_favorites(db)
        favs = [f for f in favs if _station_key(f) != key]
        await _save_favorites(db, favs)
        return JSONResponse({"ok": True})

    return [
        Route("/api/radio/search",           search),
        Route("/api/radio/popular",          popular),
        Route("/api/radio/tags",             tags),
        Route("/api/radio/resolve/{uuid}",   resolve),
        Route("/api/radio/somafm",           somafm),
        Route("/api/radio/favorites",        list_favorites),
        Route("/api/radio/favorites",        add_favorite,    methods=["POST"]),
        Route("/api/radio/favorites/remove", remove_favorite, methods=["POST"]),
    ]
