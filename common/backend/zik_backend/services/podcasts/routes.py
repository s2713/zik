"""HTTP routes for the Podcasts service.

Backend is a stateless RSS proxy: it fetches and parses feeds on demand.
Subscribed feed URLs (with their titles) are persisted in the settings DB.
Episode audio is streamed directly by the browser from the enclosure URLs
(online playback), or served from the local offline store after a download.

Offline download flow:
  POST /api/podcasts/episodes/save       → {task_id}
  GET  /api/podcasts/episodes/save/{id}  → SSE progress stream
  GET  /api/podcasts/episodes/saved      → list of saved episodes
  GET  /api/podcasts/episodes/saved/{feed_slug}/{ep_slug}  → audio file
  DELETE /api/podcasts/episodes/save     → remove saved episode
"""

import asyncio
import hashlib
import json
import logging
import secrets
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, StreamingResponse
from starlette.routing import Route

from ..files.db import LibraryDB
from ...storage.quota import DEFAULT_LIMIT, QUOTA_KEY, disk_usage

logger = logging.getLogger(__name__)

_NS_ITUNES  = "http://www.itunes.com/dtds/podcast-1.0.dtd"
_FEEDS_KEY  = "podcast.feeds"
_MAX_EP     = 200
_TIMEOUT    = 20.0
_UA         = "zik-podcast/1.0"


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


def _slug(url: str) -> str:
    """16-char hex slug derived from a URL (collision-resistant enough for filenames)."""
    return hashlib.sha256(url.encode()).hexdigest()[:16]


def _parse_feed(xml_bytes: bytes, url: str) -> dict:
    """Parse RSS bytes into feed metadata + episode list (max _MAX_EP items)."""
    root    = ET.fromstring(xml_bytes)
    ch      = root.find("channel")
    channel = ch if ch is not None else root

    title_el = channel.find("title")
    title = (title_el.text or "") if title_el is not None else ""

    # Artwork: prefer <image><url>, then itunes:image href.
    image = ""
    img = channel.find("image")
    if img is not None:
        iu = img.find("url")
        if iu is not None:
            image = iu.text or ""
    if not image:
        img = channel.find(_itunes("image"))
        if img is not None:
            image = img.get("href", "")

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
        r = await c.get(url, headers={"User-Agent": _UA})
        r.raise_for_status()
        return r.content


async def _head_size(url: str) -> int:
    """Return Content-Length from a HEAD request; 0 if unavailable or error."""
    try:
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as c:
            r = await c.head(url, headers={"User-Agent": _UA})
            return int(r.headers.get("content-length", 0))
    except Exception:
        return 0


async def _download_worker(
    queue: asyncio.Queue,
    audio_url: str,
    audio_path: Path,
    meta_path: Path,
    meta: dict,
    limit_bytes: int,
    offline_dir: Path,
) -> None:
    """Stream-download an episode, reporting progress via queue.

    Writes to a .tmp file then renames atomically.  Enforces quota after each
    chunk by summing current disk usage + bytes received; deletes partial file
    on quota violation or any error.
    """
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = audio_path.with_suffix(".tmp")
    try:
        async with httpx.AsyncClient(timeout=None, follow_redirects=True) as c:
            async with c.stream("GET", audio_url, headers={"User-Agent": _UA}) as r:
                r.raise_for_status()
                total = int(r.headers.get("content-length", 0))
                received = 0
                with open(tmp, "wb") as f:
                    async for chunk in r.aiter_bytes(65536):
                        # Enforce quota chunk-by-chunk so we never overshoot badly.
                        if limit_bytes > 0:
                            base = disk_usage(offline_dir)
                            if base + received + len(chunk) > limit_bytes:
                                tmp.unlink(missing_ok=True)
                                await queue.put({"type": "error", "message": "quota exceeded"})
                                return
                        f.write(chunk)
                        received += len(chunk)
                        await queue.put({"type": "progress", "received": received, "total": total})
        tmp.rename(audio_path)
        meta_path.write_text(json.dumps(meta))
        await queue.put({"type": "done", "local_url": meta["local_url"]})
    except Exception as exc:
        tmp.unlink(missing_ok=True)
        await queue.put({"type": "error", "message": str(exc)})


class _DownloadManager:
    """Per-router registry of in-flight download tasks and their progress queues."""

    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Queue] = {}

    def start(
        self, task_id: str, audio_url: str, audio_path: Path, meta_path: Path,
        meta: dict, limit_bytes: int, offline_dir: Path,
    ) -> None:
        """Create a queue, register it, and launch the background download task."""
        queue: asyncio.Queue = asyncio.Queue()
        self._tasks[task_id] = queue
        asyncio.create_task(
            _download_worker(queue, audio_url, audio_path, meta_path, meta, limit_bytes, offline_dir)
        )

    def get(self, task_id: str) -> asyncio.Queue | None:
        return self._tasks.get(task_id)

    def remove(self, task_id: str) -> None:
        self._tasks.pop(task_id, None)


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


def make_podcasts_router(db: LibraryDB, offline_dir: Path) -> list:
    """Return Starlette Route objects for the podcasts service."""

    dl = _DownloadManager()
    pod_dir = offline_dir / "podcasts"

    # ---- feed management ----

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

    # ---- offline download ----

    async def save_episode(request: Request) -> JSONResponse:
        """Start downloading an episode for offline playback.

        Returns {task_id} immediately; client polls the SSE endpoint for progress.
        Returns {already_saved: true} with no task_id if the episode is already on disk.
        Returns 409 if the pre-flight quota check fails.
        """
        body      = await request.json()
        feed_url  = (body.get("feed_url") or "").strip()
        episode   = body.get("episode") or {}
        audio_url = (episode.get("url") or "").strip()
        if not feed_url or not audio_url:
            return JSONResponse({"error": "feed_url and episode.url required"}, status_code=400)

        feed_slug = _slug(feed_url)
        ep_slug   = _slug(audio_url)
        ep_dir    = pod_dir / feed_slug
        audio_path = ep_dir / f"{ep_slug}.audio"
        meta_path  = ep_dir / f"{ep_slug}.json"

        # Idempotent: already present on disk.
        if audio_path.exists():
            local_url = f"/api/podcasts/episodes/saved/{feed_slug}/{ep_slug}"
            return JSONResponse({"already_saved": True, "local_url": local_url})

        # Pre-flight quota check using Content-Length from HEAD (best-effort).
        raw_limit   = await db.get_setting(QUOTA_KEY)
        limit_bytes = int(raw_limit) if raw_limit else DEFAULT_LIMIT
        if limit_bytes > 0:
            size_hint = await _head_size(audio_url)
            if size_hint > 0 and disk_usage(offline_dir) + size_hint > limit_bytes:
                return JSONResponse({"error": "quota exceeded"}, status_code=409)

        # Build sidecar metadata.
        meta = {
            "feed_url":    feed_url,
            "audio_url":   audio_url,
            "feed_slug":   feed_slug,
            "ep_slug":     ep_slug,
            "title":       episode.get("title", ""),
            "pub_date":    episode.get("pub_date", ""),
            "duration":    episode.get("duration", 0),
            "mime":        episode.get("mime", "audio/mpeg"),
            "local_url":   f"/api/podcasts/episodes/saved/{feed_slug}/{ep_slug}",
            "downloaded_at": datetime.now(tz=timezone.utc).isoformat(),
        }

        task_id = secrets.token_urlsafe(16)
        dl.start(task_id, audio_url, audio_path, meta_path, meta, limit_bytes, offline_dir)
        logger.info("podcasts: download started task=%s episode='%s'", task_id, meta["title"])
        return JSONResponse({"task_id": task_id, "already_saved": False})

    async def save_progress(request: Request) -> StreamingResponse | JSONResponse:
        """SSE stream reporting download progress for a given task_id.

        Events:
          {"type": "progress", "received": N, "total": M}  (total=0 if unknown)
          {"type": "done",     "local_url": "..."}
          {"type": "error",    "message":   "..."}
        Heartbeat comments (': heartbeat') are sent every second to keep the
        connection alive through proxies.
        """
        task_id = request.path_params["task_id"]
        queue   = dl.get(task_id)
        if queue is None:
            return JSONResponse({"error": "unknown task"}, status_code=404)

        async def _stream():
            try:
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=1.0)
                    except TimeoutError:
                        yield ": heartbeat\n\n"
                        continue
                    yield f"data: {json.dumps(event)}\n\n"
                    if event["type"] in ("done", "error"):
                        dl.remove(task_id)
                        break
            except GeneratorExit:
                pass

        return StreamingResponse(
            _stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    async def list_saved(_request: Request) -> JSONResponse:
        """Return metadata for all saved (offline) episodes."""
        result = []
        if pod_dir.exists():
            for meta_file in sorted(pod_dir.rglob("*.json")):
                try:
                    result.append(json.loads(meta_file.read_text()))
                except Exception:
                    pass
        return JSONResponse(result)

    async def serve_saved(request: Request) -> FileResponse | JSONResponse:
        """Serve a saved episode audio file."""
        feed_slug  = request.path_params["feed_slug"]
        ep_slug    = request.path_params["ep_slug"]
        audio_path = pod_dir / feed_slug / f"{ep_slug}.audio"
        meta_path  = pod_dir / feed_slug / f"{ep_slug}.json"
        if not audio_path.exists():
            return JSONResponse({"error": "not found"}, status_code=404)
        # Read mime from sidecar if available, else default.
        media_type = "audio/mpeg"
        try:
            media_type = json.loads(meta_path.read_text()).get("mime", media_type)
        except Exception:
            pass
        return FileResponse(audio_path, media_type=media_type)

    async def delete_saved(request: Request) -> JSONResponse:
        """Remove a saved episode from disk (audio file + metadata sidecar)."""
        body      = await request.json()
        audio_url = (body.get("audio_url") or "").strip()
        feed_url  = (body.get("feed_url") or "").strip()
        if not audio_url:
            return JSONResponse({"error": "audio_url required"}, status_code=400)

        ep_slug   = _slug(audio_url)
        feed_slug = _slug(feed_url) if feed_url else None

        # Fast path: we know the feed slug.
        if feed_slug:
            ep_dir = pod_dir / feed_slug
            (ep_dir / f"{ep_slug}.audio").unlink(missing_ok=True)
            (ep_dir / f"{ep_slug}.json").unlink(missing_ok=True)
        else:
            # Scan all feed dirs (slower, but feed_url should always be supplied).
            if pod_dir.exists():
                for f in pod_dir.rglob(f"{ep_slug}.audio"):
                    f.unlink(missing_ok=True)
                for f in pod_dir.rglob(f"{ep_slug}.json"):
                    f.unlink(missing_ok=True)
        return JSONResponse({"ok": True})

    return [
        Route("/api/podcasts/feeds",           list_feeds),
        Route("/api/podcasts/feeds",           add_feed,       methods=["POST"]),
        Route("/api/podcasts/feeds/remove",    remove_feed,    methods=["POST"]),
        Route("/api/podcasts/episodes",        episodes),
        Route("/api/podcasts/episodes/save",   save_episode,   methods=["POST"]),
        Route("/api/podcasts/episodes/save/{task_id}", save_progress),
        Route("/api/podcasts/episodes/saved",  list_saved),
        Route("/api/podcasts/episodes/saved/{feed_slug}/{ep_slug}", serve_saved),
        Route("/api/podcasts/episodes/save",   delete_saved,   methods=["DELETE"]),
    ]
