"""SQLite library index for the files service (aiosqlite, WAL mode)."""

import aiosqlite

_SCHEMA = """
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
    mtime        REAL NOT NULL DEFAULT 0.0
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
        """Open the connection and apply WAL mode + schema."""
        self._db = await aiosqlite.connect(self._path)
        self._db.row_factory = aiosqlite.Row
        await self._db.execute("PRAGMA journal_mode=WAL")
        await self._db.executescript(_SCHEMA)
        await self._db.commit()

    async def close(self) -> None:
        """Close the database connection."""
        if self._db:
            await self._db.close()
            self._db = None

    async def upsert_track(self, row: dict) -> None:
        """Insert or replace one track row."""
        db = await self._ensure_open()
        await db.execute(
            """
            INSERT INTO tracks
                (id, path, title, artist, album, genre,
                 track_number, year, duration, mtime)
            VALUES
                (:id, :path, :title, :artist, :album, :genre,
                 :track_number, :year, :duration, :mtime)
            ON CONFLICT(id) DO UPDATE SET
                path=excluded.path, title=excluded.title,
                artist=excluded.artist, album=excluded.album,
                genre=excluded.genre, track_number=excluded.track_number,
                year=excluded.year, duration=excluded.duration,
                mtime=excluded.mtime
            """,
            row,
        )

    async def delete_stale(self, live_ids: set[str]) -> None:
        """Remove tracks whose ids are no longer in the scanned set."""
        db = await self._ensure_open()
        if not live_ids:
            await db.execute("DELETE FROM tracks")
        else:
            placeholders = ",".join("?" * len(live_ids))
            await db.execute(
                f"DELETE FROM tracks WHERE id NOT IN ({placeholders})",
                tuple(live_ids),
            )
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
