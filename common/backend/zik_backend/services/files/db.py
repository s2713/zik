"""SQLite library index for the files service (aiosqlite, WAL mode)."""

import contextlib

import aiosqlite

_SCHEMA = """
CREATE TABLE IF NOT EXISTS playlists (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    owner          TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    last_played_at TEXT
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    service_id  TEXT NOT NULL DEFAULT '',
    track_id    TEXT NOT NULL DEFAULT '',
    audio_url   TEXT NOT NULL DEFAULT '',
    art_url     TEXT NOT NULL DEFAULT '',
    title       TEXT NOT NULL DEFAULT '',
    artist      TEXT NOT NULL DEFAULT '',
    album       TEXT NOT NULL DEFAULT '',
    duration    REAL NOT NULL DEFAULT 0.0,
    added_at    TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (playlist_id, position)
);

CREATE TABLE IF NOT EXISTS lan_sources (
    id       TEXT PRIMARY KEY,
    label    TEXT NOT NULL,
    kind     TEXT NOT NULL DEFAULT 'smb',
    server   TEXT NOT NULL,
    share    TEXT NOT NULL,
    subpath  TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
    id           TEXT PRIMARY KEY,
    path         TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL DEFAULT '',
    artist       TEXT NOT NULL DEFAULT '',
    album        TEXT NOT NULL DEFAULT '',
    genre        TEXT NOT NULL DEFAULT '',
    track_number INTEGER,
    year         INTEGER,
    duration     REAL NOT NULL DEFAULT 0.0,
    mtime        REAL NOT NULL DEFAULT 0.0,
    source_id    TEXT NOT NULL DEFAULT 'internal'
);
"""

# Columns allowed as sort keys; guards against SQL injection via the query param.
_SORT_COLS = frozenset({"title", "artist", "album", "genre", "track_number", "year"})


class LibraryDB:
    """Async SQLite wrapper; opens lazily on first use, closed explicitly at shutdown."""

    def __init__(self, db_path: str) -> None:
        self._path = db_path
        self._db: aiosqlite.Connection | None = None

    async def _ensure_open(self) -> aiosqlite.Connection:
        """Open the connection once and return it; idempotent."""
        if self._db is None:
            await self.open()
        return self._db  # type: ignore[return-value]

    async def open(self) -> None:
        """Open the connection, apply WAL mode, create schema, run migrations."""
        self._db = await aiosqlite.connect(self._path)
        self._db.row_factory = aiosqlite.Row
        await self._db.execute("PRAGMA journal_mode=WAL")
        await self._db.executescript(_SCHEMA)
        # Migration: add source_id to databases created before M3.
        with contextlib.suppress(aiosqlite.OperationalError):
            await self._db.execute(
                "ALTER TABLE tracks ADD COLUMN"
                " source_id TEXT NOT NULL DEFAULT 'internal'"
            )
        await self._db.commit()

    async def close(self) -> None:
        """Close the database connection."""
        if self._db:
            await self._db.close()
            self._db = None

    async def upsert_track(self, row: dict) -> None:
        """Insert or replace one track row (row must include source_id)."""
        db = await self._ensure_open()
        await db.execute(
            """
            INSERT INTO tracks
                (id, path, title, artist, album, genre,
                 track_number, year, duration, mtime, source_id)
            VALUES
                (:id, :path, :title, :artist, :album, :genre,
                 :track_number, :year, :duration, :mtime, :source_id)
            ON CONFLICT(id) DO UPDATE SET
                path=excluded.path, title=excluded.title,
                artist=excluded.artist, album=excluded.album,
                genre=excluded.genre, track_number=excluded.track_number,
                year=excluded.year, duration=excluded.duration,
                mtime=excluded.mtime, source_id=excluded.source_id
            """,
            row,
        )

    async def delete_stale_for_source(self, source_id: str, live_ids: set[str]) -> None:
        """Remove tracks belonging to source_id that are no longer in live_ids."""
        db = await self._ensure_open()
        if not live_ids:
            await db.execute("DELETE FROM tracks WHERE source_id = ?", (source_id,))
        else:
            placeholders = ",".join("?" * len(live_ids))
            await db.execute(
                f"DELETE FROM tracks WHERE source_id = ?"
                f" AND id NOT IN ({placeholders})",
                (source_id, *live_ids),
            )
        await db.commit()

    async def delete_by_source(self, source_id: str) -> None:
        """Remove all tracks belonging to source_id (used on unmount)."""
        db = await self._ensure_open()
        await db.execute("DELETE FROM tracks WHERE source_id = ?", (source_id,))
        await db.commit()

    async def commit(self) -> None:
        """Flush pending writes to disk."""
        db = await self._ensure_open()
        await db.commit()

    async def list_tracks(self, sort: str = "artist") -> list[dict]:
        """Return all tracks sorted by *sort* column (default: artist)."""
        db = await self._ensure_open()
        col = sort if sort in _SORT_COLS else "artist"
        # Secondary sort: album, then track_number, then title for a natural order.
        async with db.execute(
            f"SELECT * FROM tracks ORDER BY {col} COLLATE NOCASE,"
            " album COLLATE NOCASE, track_number, title COLLATE NOCASE"
        ) as cursor:
            rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def get_track(self, track_id: str) -> dict | None:
        """Return a single track dict or None if not found."""
        db = await self._ensure_open()
        async with db.execute(
            "SELECT * FROM tracks WHERE id = ?", (track_id,)
        ) as cursor:
            row = await cursor.fetchone()
        return dict(row) if row else None

    # --- LAN source persistence ---

    async def add_lan_source(self, row: dict) -> None:
        """Insert or replace a LAN source row."""
        db = await self._ensure_open()
        await db.execute(
            """
            INSERT INTO lan_sources
                (id, label, kind, server, share, subpath, username, password)
            VALUES
                (:id, :label, :kind, :server, :share, :subpath, :username, :password)
            ON CONFLICT(id) DO UPDATE SET
                label=excluded.label, kind=excluded.kind,
                server=excluded.server, share=excluded.share,
                subpath=excluded.subpath, username=excluded.username,
                password=excluded.password
            """,
            row,
        )
        await db.commit()

    async def remove_lan_source(self, source_id: str) -> None:
        """Delete a LAN source row by id."""
        db = await self._ensure_open()
        await db.execute("DELETE FROM lan_sources WHERE id = ?", (source_id,))
        await db.commit()

    async def list_lan_sources(self) -> list[dict]:
        """Return all persisted LAN sources."""
        db = await self._ensure_open()
        async with db.execute("SELECT * FROM lan_sources") as cursor:
            rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    # --- generic key-value settings ---

    async def get_setting(self, key: str) -> str | None:
        """Return a setting value by key, or None if not set."""
        db = await self._ensure_open()
        async with db.execute(
            "SELECT value FROM settings WHERE key = ?", (key,)
        ) as cursor:
            row = await cursor.fetchone()
        return row["value"] if row else None

    async def set_setting(self, key: str, value: str) -> None:
        """Upsert a setting key-value pair."""
        db = await self._ensure_open()
        await db.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        await db.commit()

    # --- playlist persistence ---

    async def list_playlists(self, owner: str) -> list[dict]:
        """Return all playlists owned by *owner* with track count, sorted by name."""
        db = await self._ensure_open()
        async with db.execute(
            """
            SELECT p.id, p.name, p.owner, p.created_at, p.updated_at, p.last_played_at,
                   COUNT(t.playlist_id) AS track_count
            FROM playlists p
            LEFT JOIN playlist_tracks t ON t.playlist_id = p.id
            WHERE p.owner = ?
            GROUP BY p.id
            ORDER BY p.name COLLATE NOCASE
            """,
            (owner,),
        ) as cursor:
            rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def create_playlist(self, pl_id: str, name: str, owner: str, now: str) -> None:
        """Insert a new empty playlist."""
        db = await self._ensure_open()
        await db.execute(
            "INSERT INTO playlists (id, name, owner, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (pl_id, name, owner, now, now),
        )
        await db.commit()

    async def get_playlist(self, pl_id: str, owner: str) -> dict | None:
        """Return the playlist header row, or None if not found / wrong owner."""
        db = await self._ensure_open()
        async with db.execute(
            "SELECT * FROM playlists WHERE id = ? AND owner = ?", (pl_id, owner)
        ) as cursor:
            row = await cursor.fetchone()
        return dict(row) if row else None

    async def get_playlist_tracks(self, pl_id: str) -> list[dict]:
        """Return all tracks for a playlist ordered by position."""
        db = await self._ensure_open()
        async with db.execute(
            "SELECT * FROM playlist_tracks WHERE playlist_id = ? ORDER BY position",
            (pl_id,),
        ) as cursor:
            rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def rename_playlist(self, pl_id: str, name: str, owner: str, now: str) -> bool:
        """Rename a playlist; returns False if not found or wrong owner."""
        db = await self._ensure_open()
        async with db.execute(
            "UPDATE playlists SET name = ?, updated_at = ? WHERE id = ? AND owner = ?",
            (name, now, pl_id, owner),
        ) as cursor:
            changed = cursor.rowcount > 0
        await db.commit()
        return changed

    async def delete_playlist(self, pl_id: str, owner: str) -> bool:
        """Delete a playlist and its tracks; returns False if not found or wrong owner."""
        db = await self._ensure_open()
        async with db.execute(
            "DELETE FROM playlists WHERE id = ? AND owner = ?", (pl_id, owner)
        ) as cursor:
            changed = cursor.rowcount > 0
        if changed:
            await db.execute(
                "DELETE FROM playlist_tracks WHERE playlist_id = ?", (pl_id,)
            )
        await db.commit()
        return changed

    async def add_playlist_tracks(
        self, pl_id: str, tracks: list[dict], now: str
    ) -> int:
        """Append tracks to a playlist; returns the new total track count."""
        db = await self._ensure_open()
        async with db.execute(
            "SELECT COALESCE(MAX(position), -1) FROM playlist_tracks WHERE playlist_id = ?",
            (pl_id,),
        ) as cursor:
            row = await cursor.fetchone()
        next_pos = row[0] + 1  # 0 when empty, max+1 otherwise
        for i, t in enumerate(tracks):
            await db.execute(
                """
                INSERT INTO playlist_tracks
                    (playlist_id, position, service_id, track_id, audio_url,
                     art_url, title, artist, album, duration, added_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    pl_id, next_pos + i,
                    t.get("service_id", ""), t.get("track_id", ""),
                    t.get("audio_url", ""), t.get("art_url", ""),
                    t.get("title", ""), t.get("artist", ""),
                    t.get("album", ""), float(t.get("duration", 0.0)),
                    now,
                ),
            )
        await db.execute(
            "UPDATE playlists SET updated_at = ? WHERE id = ?", (now, pl_id)
        )
        await db.commit()
        async with db.execute(
            "SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = ?", (pl_id,)
        ) as cursor:
            row = await cursor.fetchone()
        return row[0]

    async def remove_playlist_track(
        self, pl_id: str, position: int, owner: str, now: str
    ) -> bool:
        """Remove track at *position* and shift later tracks down; checks ownership."""
        db = await self._ensure_open()
        async with db.execute(
            "SELECT id FROM playlists WHERE id = ? AND owner = ?", (pl_id, owner)
        ) as cursor:
            if not await cursor.fetchone():
                return False
        async with db.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ? AND position = ?",
            (pl_id, position),
        ) as cursor:
            if cursor.rowcount == 0:
                return False
        await db.execute(
            "UPDATE playlist_tracks SET position = position - 1"
            " WHERE playlist_id = ? AND position > ?",
            (pl_id, position),
        )
        await db.execute(
            "UPDATE playlists SET updated_at = ? WHERE id = ?", (now, pl_id)
        )
        await db.commit()
        return True

    async def reorder_playlist_tracks(
        self,
        pl_id: str,
        from_positions: list[int],
        to_position: int,
        owner: str,
        now: str,
    ) -> bool:
        """Move tracks at from_positions to just before to_position (same semantics as queue.move)."""
        db = await self._ensure_open()
        async with db.execute(
            "SELECT id FROM playlists WHERE id = ? AND owner = ?", (pl_id, owner)
        ) as cursor:
            if not await cursor.fetchone():
                return False
        async with db.execute(
            "SELECT * FROM playlist_tracks WHERE playlist_id = ? ORDER BY position",
            (pl_id,),
        ) as cursor:
            all_rows = [dict(r) for r in await cursor.fetchall()]
        if not all_rows:
            return True
        from_set = set(from_positions)
        moved    = sorted([r for r in all_rows if r["position"] in from_set],
                          key=lambda r: r["position"])
        rest     = [r for r in all_rows if r["position"] not in from_set]
        adj      = sum(1 for p in from_positions if p < to_position)
        ins      = max(0, min(to_position - adj, len(rest)))
        result   = rest[:ins] + moved + rest[ins:]
        # Rewrite all positions atomically.
        await db.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?", (pl_id,))
        for i, row in enumerate(result):
            await db.execute(
                """
                INSERT INTO playlist_tracks
                    (playlist_id, position, service_id, track_id, audio_url,
                     art_url, title, artist, album, duration, added_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    pl_id, i,
                    row["service_id"], row["track_id"], row["audio_url"],
                    row["art_url"], row["title"], row["artist"],
                    row["album"], row["duration"], row["added_at"],
                ),
            )
        await db.execute(
            "UPDATE playlists SET updated_at = ? WHERE id = ?", (now, pl_id)
        )
        await db.commit()
        return True

    async def touch_playlist_last_played(
        self, pl_id: str, owner: str, now: str
    ) -> bool:
        """Update last_played_at to now; returns False if not found or wrong owner."""
        db = await self._ensure_open()
        async with db.execute(
            "UPDATE playlists SET last_played_at = ? WHERE id = ? AND owner = ?",
            (now, pl_id, owner),
        ) as cursor:
            changed = cursor.rowcount > 0
        await db.commit()
        return changed
