"""HTTP routes for the Podcasts service.

Backend is a stateless RSS proxy: it fetches and parses feeds on demand.
Subscribed feed URLs (with their titles) are persisted in the settings DB.
Episode audio is streamed directly by the browser from the enclosure URLs.
"""

import json
import logging
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

import httpx
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from ..files.db import LibraryDB

logger = logging.getLogger(__name__)

_NS_ITUNES  = "http://www.itunes.com/dtds/podcast-1.0.dtd"
_FEEDS_KEY  = "podcast.feeds"
_MAX_EP     = 200
_TIMEOUT    = 20.0


def _itunes(tag: str) -> str:
    """Clark-notation helper for itunes namespace."""
    return f"{{{_NS_ITUNES}}}{tag}"


def _duration_s(raw: str) -> int:
    """Parse HH:MM:SS, MM:SS, or plain-seconds string to int seconds."""
    if not raw:
        return 0
    parts = raw.strip().split(":")
    try:
        if len(parts) == 1:
            return int(float(parts[0]))
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    except (ValueError, IndexError):
        return 0


def _parse_feed(xml_bytes: bytes, url: str) -> dict:
    """Parse RSS bytes into feed metadata + episode list (max _MAX_EP items)."""
    root    = ET.fromstring(xml_bytes)
    ch      = root.find("channel")
    channel = ch if ch is not None else root

    # Title
    title_el = channel.find("title")
    title = (title_el.text or "") if title_el is not None else ""

    # Artwork
    image = ""
    if (img := channel.find("image")) is not None and (iu := img.find("url")) is not None:
        image = iu.text or ""
    if not image and (img := channel.find(_itunes("image"))) is not None:
        image = img.get("href", "")

    # Description
    desc_el = channel.find("description")
    description = ((desc_el.text or "")[:300]) if desc_el is not None else ""

    episodes: list[dict] = []
    for item in channel.findall("item")[:_MAX_EP]:
        enc = item.find("enclosure")
        if enc is None:
            continue
        enc_url  = enc.get("url", "")
        enc_mime = enc.get("type", "audio/mpeg")
        if not enc_url or not enc_mime.startswith("audio/"):
            continue

        guid_el  = item.find("guid")
        guid     = (guid_el.text if guid_el is not None else None) or enc_url

        ep_title_el = item.find("title")
        ep_title    = (ep_title_el.text or "") if ep_title_el is not None else ""

        pub_date = ""
        pd_el    = item.find("pubDate")
        if pd_el is not None and pd_el.text:
            try:
                pub_date = parsedate_to_datetime(pd_el.text).date().isoformat()
            except Exception:
                pub_date = pd_el.text[:10]

        duration = 0
        dur_el   = item.find(_itunes("duration"))
        if dur_el is not None:
            duration = _duration_s(dur_el.text or "")

        ep_desc = ""
        for tag in ("description", _itunes("summary")):
            d_el = item.find(tag)
            if d_el is not None and d_el.text:
                ep_desc = d_el.text[:300]
                break

        episodes.append({
            "guid":        guid,
            "title":       ep_title,
            "pub_date":    pub_date,
            "duration":    duration,
            "url":         enc_url,
            "mime":        enc_mime,
            "description": ep_desc,
        })

    return {
        "url":         url,
        "title":       title,
        "description": description,
        "image":       image,
        "episodes":    episodes,
    }


async def _fetch_xml(url: str) -> bytes:
    """Fetch a URL and return raw bytes; raises httpx.HTTPError on failure."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as c:
        r = await c.get(url, headers={"User-Agent": "zik-podcast/1.0"})
        r.raise_for_status()
        return r.content


async def _load_feeds(db: LibraryDB) -> list[dict]:
    """Read saved feeds list from DB; returns [] on missing or corrupt data."""
    raw = await db.get_setting(_FEEDS_KEY)
    if not raw:
        return []
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return []


async def _save_feeds(db: LibraryDB, feeds: list[dict]) -> None:
    await db.set_setting(_FEEDS_KEY, json.dumps(feeds))


def make_podcasts_router(db: LibraryDB) -> list:
    """Return Starlette Route objects for the podcasts service."""

    async def list_feeds(_request: Request) -> JSONResponse:
        """Return saved feeds (url + title + image, no episodes)."""
        return JSONResponse(await _load_feeds(db))

    async def add_feed(request: Request) -> JSONResponse:
        """Fetch an RSS URL, persist it, and return full feed with episodes."""
        body = await request.json()
        url  = (body.get("url") or "").strip()
        if not url:
            return JSONResponse({"error": "url required"}, status_code=400)
        try:
            xml_bytes = await _fetch_xml(url)
        except httpx.HTTPError as exc:
            return JSONResponse({"error": f"fetch failed: {exc}"}, status_code=503)
        try:
            feed = _parse_feed(xml_bytes, url)
        except ET.ParseError as exc:
            return JSONResponse({"error": f"invalid RSS: {exc}"}, status_code=422)

        # Upsert: replace existing entry for same URL, then append.
        feeds = await _load_feeds(db)
        feeds = [f for f in feeds if f["url"] != url]
        feeds.append({"url": url, "title": feed["title"], "image": feed["image"]})
        await _save_feeds(db, feeds)
        logger.info("podcasts: subscribed '%s' (%d episodes)", feed["title"], len(feed["episodes"]))
        return JSONResponse(feed)

    async def remove_feed(request: Request) -> JSONResponse:
        """Remove a saved feed by URL."""
        body  = await request.json()
        url   = (body.get("url") or "").strip()
        feeds = await _load_feeds(db)
        feeds = [f for f in feeds if f["url"] != url]
        await _save_feeds(db, feeds)
        return JSONResponse({"ok": True})

    async def episodes(request: Request) -> JSONResponse:
        """Fetch and parse a podcast RSS feed; return full feed with episodes."""
        url = request.query_params.get("url", "").strip()
        if not url:
            return JSONResponse({"error": "url required"}, status_code=400)
        try:
            xml_bytes = await _fetch_xml(url)
        except httpx.HTTPError as exc:
            return JSONResponse({"error": f"fetch failed: {exc}"}, status_code=503)
        try:
            feed = _parse_feed(xml_bytes, url)
        except ET.ParseError as exc:
            return JSONResponse({"error": f"invalid RSS: {exc}"}, status_code=422)
        return JSONResponse(feed)

    return [
        Route("/api/podcasts/feeds",        list_feeds),
        Route("/api/podcasts/feeds",        add_feed,    methods=["POST"]),
        Route("/api/podcasts/feeds/remove", remove_feed, methods=["POST"]),
        Route("/api/podcasts/episodes",     episodes),
    ]
