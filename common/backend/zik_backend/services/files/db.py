"""SQLite library index for the files service (aiosqlite, WAL mode)."""

import contextlib

import aiosqlite

_SCHEMA = """
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
