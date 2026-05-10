"""HTTP routes for the cross-service playlists feature."""

import json
import logging
import uuid
from datetime import datetime, timezone

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from ..files.db import LibraryDB

logger = logging.getLogger(__name__)


def _now() -> str:
    """Return current UTC time as ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


def make_playlists_router(db: LibraryDB, sessions: dict) -> list[Route]:
    """Return Starlette routes for the playlists service."""

    def _user(request: Request) -> str | None:
        """Extract the current username from the session cookie."""
        sid = request.cookies.get("__Host-zik-session")
        return sessions.get(sid, {}).get("user") if sid else None

    # --- /api/playlists ---

    async def playlists_collection(request: Request) -> JSONResponse:
        """GET → list all; POST → create new."""
        user = _user(request)
        if not user:
            return JSONResponse({"error": "not logged in"}, status_code=401)
        if request.method == "POST":
            body = await request.json()
            name = str(body.get("name", "")).strip() or "New playlist"
            pl_id = str(uuid.uuid4())
            now = _now()
            await db.create_playlist(pl_id, name, user, now)
            return JSONResponse({
                "id": pl_id, "name": name, "owner": user,
                "created_at": now, "updated_at": now,
                "last_played_at": None, "track_count": 0,
            }, status_code=201)
        playlists = await db.list_playlists(user)
        return JSONResponse(playlists)

    # --- /api/playlists/import (must come before /{id}) ---

    async def import_playlist(request: Request) -> JSONResponse:
        """POST — create a new playlist from an exported JSON file."""
        user = _user(request)
        if not user:
            return JSONResponse({"error": "not logged in"}, status_code=401)
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON"}, status_code=400)
        if body.get("version") != 1:
            return JSONResponse({"error": "unsupported format version"}, status_code=400)
        name   = str(body.get("name", "Imported playlist")).strip() or "Imported playlist"
        tracks = body.get("tracks", [])
        pl_id  = str(uuid.uuid4())
        now    = _now()
        await db.create_playlist(pl_id, name, user, now)
        if tracks:
            await db.add_playlist_tracks(pl_id, tracks, now)
        return JSONResponse({
            "id": pl_id, "name": name, "owner": user,
            "created_at": now, "updated_at": now,
            "last_played_at": None, "track_count": len(tracks),
        }, status_code=201)

    # --- /api/playlists/{id} ---

    async def playlist_detail(request: Request) -> JSONResponse:
        """GET → detail with tracks; PUT → rename; DELETE → delete."""
        user = _user(request)
        if not user:
            return JSONResponse({"error": "not logged in"}, status_code=401)
        pl_id = request.path_params["id"]

        if request.method == "GET":
            pl = await db.get_playlist(pl_id, user)
            if pl is None:
                return JSONResponse({"error": "not found"}, status_code=404)
            tracks = await db.get_playlist_tracks(pl_id)
            return JSONResponse({**pl, "tracks": tracks})

        if request.method == "PUT":
            body = await request.json()
            name = str(body.get("name", "")).strip()
            if not name:
                return JSONResponse({"error": "name required"}, status_code=400)
            ok = await db.rename_playlist(pl_id, name, user, _now())
            if not ok:
                return JSONResponse({"error": "not found"}, status_code=404)
            return JSONResponse({"ok": True})

        if request.method == "DELETE":
            ok = await db.delete_playlist(pl_id, user)
            if not ok:
                return JSONResponse({"error": "not found"}, status_code=404)
            return JSONResponse({"ok": True})

        return JSONResponse({"error": "method not allowed"}, status_code=405)

    # --- /api/playlists/{id}/tracks ---

    async def playlist_tracks(request: Request) -> JSONResponse:
        """POST — append tracks to a playlist."""
        user = _user(request)
        if not user:
            return JSONResponse({"error": "not logged in"}, status_code=401)
        pl_id = request.path_params["id"]
        if await db.get_playlist(pl_id, user) is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        body   = await request.json()
        tracks = body if isinstance(body, list) else body.get("tracks", [])
        count  = await db.add_playlist_tracks(pl_id, tracks, _now())
        return JSONResponse({"ok": True, "track_count": count})

    # --- /api/playlists/{id}/tracks/{pos} ---

    async def remove_track(request: Request) -> JSONResponse:
        """DELETE — remove one track at position, shift remainder."""
        user = _user(request)
        if not user:
            return JSONResponse({"error": "not logged in"}, status_code=401)
        pl_id    = request.path_params["id"]
        position = int(request.path_params["pos"])
        ok = await db.remove_playlist_track(pl_id, position, user, _now())
        if not ok:
            return JSONResponse({"error": "not found"}, status_code=404)
        return JSONResponse({"ok": True})

    # --- /api/playlists/{id}/reorder ---

    async def reorder_tracks(request: Request) -> JSONResponse:
        """POST — move tracks to a new position (queue.move semantics)."""
        user = _user(request)
        if not user:
            return JSONResponse({"error": "not logged in"}, status_code=401)
        pl_id = request.path_params["id"]
        body  = await request.json()
        from_positions = [int(p) for p in body.get("from_positions", [])]
        to_position    = int(body.get("to_position", 0))
        ok = await db.reorder_playlist_tracks(pl_id, from_positions, to_position, user, _now())
        if not ok:
            return JSONResponse({"error": "not found"}, status_code=404)
        return JSONResponse({"ok": True})

    # --- /api/playlists/{id}/last-played ---

    async def touch_last_played(request: Request) -> JSONResponse:
        """POST — update last_played_at to now."""
        user = _user(request)
        if not user:
            return JSONResponse({"error": "not logged in"}, status_code=401)
        pl_id = request.path_params["id"]
        ok = await db.touch_playlist_last_played(pl_id, user, _now())
        if not ok:
            return JSONResponse({"error": "not found"}, status_code=404)
        return JSONResponse({"ok": True})

    # --- /api/playlists/{id}/export ---

    async def export_playlist(request: Request) -> Response:
        """GET — download playlist as a portable JSON file (version 1 format)."""
        user = _user(request)
        if not user:
            return JSONResponse({"error": "not logged in"}, status_code=401)
        pl_id = request.path_params["id"]
        pl    = await db.get_playlist(pl_id, user)
        if pl is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        tracks = await db.get_playlist_tracks(pl_id)
        payload = {
            "version": 1,
            "name":    pl["name"],
            "exported_at": _now(),
            "tracks": [
                {
                    "service_id": t["service_id"],
                    "track_id":   t["track_id"],
                    "audio_url":  t["audio_url"],
                    "art_url":    t["art_url"],
                    "title":      t["title"],
                    "artist":     t["artist"],
                    "album":      t["album"],
                    "duration":   t["duration"],
                }
                for t in tracks
            ],
        }
        safe = "".join(c if c.isalnum() or c in " -_" else "_" for c in pl["name"])
        return Response(
            content=json.dumps(payload, ensure_ascii=False, indent=2),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{safe}.json"'},
        )

    return [
        Route("/api/playlists",                              playlists_collection, methods=["GET", "POST"]),
        Route("/api/playlists/import",                       import_playlist,      methods=["POST"]),
        Route("/api/playlists/{id}",                         playlist_detail,      methods=["GET", "PUT", "DELETE"]),
        Route("/api/playlists/{id}/tracks",                  playlist_tracks,      methods=["POST"]),
        Route("/api/playlists/{id}/tracks/{pos:int}",        remove_track,         methods=["DELETE"]),
        Route("/api/playlists/{id}/reorder",                 reorder_tracks,       methods=["POST"]),
        Route("/api/playlists/{id}/last-played",             touch_last_played,    methods=["POST"]),
        Route("/api/playlists/{id}/export",                  export_playlist),
    ]