"""Walk a directory tree and extract audio metadata with mutagen."""

import hashlib
import os
from collections.abc import Iterator
from typing import TypedDict

from mutagen import File as MutagenFile
from mutagen import MutagenError

# File extensions recognised as audio.
AUDIO_EXTS = frozenset({".flac", ".mp3", ".ogg", ".opus", ".m4a", ".wav"})


class TrackRow(TypedDict):
    """Flat dict representing one track in the library index."""
    id: str
    path: str
    title: str
    artist: str
    album: str
    genre: str
    track_number: int | None
    year: int | None
    duration: float
    mtime: float


def track_id(path: str) -> str:
    """Stable 12-char hex id derived from the absolute path."""
    return hashlib.sha1(path.encode()).hexdigest()[:12]


def _first(tags: dict, *keys: str) -> str:
    """Return the first non-empty string value found among the given tag keys."""
    for key in keys:
        val = tags.get(key)
        if val:
            # mutagen returns lists for most tag types.
            item = val[0] if isinstance(val, list) else val
            text = str(item).strip()
            if text:
                return text
    return ""


def _int_tag(tags: dict, *keys: str) -> int | None:
    """Extract an integer from the first matching tag key; return None on failure."""
    raw = _first(tags, *keys)
    if not raw:
        return None
    # Track-number tags may be "3/12" — take only the first component.
    try:
        return int(raw.split("/")[0])
    except ValueError:
        return None


def scan_file(path: str, mtime: float) -> TrackRow | None:
    """Read metadata from one audio file; return TrackRow or None on error."""
    try:
        audio = MutagenFile(path, easy=True)
    except (OSError, MutagenError):
        return None
    if audio is None:
        return None
    name = os.path.basename(path)
    tags: dict = audio.tags or {}
    duration: float = getattr(audio.info, "length", 0.0)
    title = _first(tags, "title") or os.path.splitext(name)[0]
    return TrackRow(
        id=track_id(path),
        path=path,
        title=title,
        artist=_first(tags, "artist", "albumartist"),
        album=_first(tags, "album"),
        genre=_first(tags, "genre"),
        track_number=_int_tag(tags, "tracknumber"),
        year=_int_tag(tags, "date", "year"),
        duration=duration,
        mtime=mtime,
    )


def scan_directory(root: str) -> Iterator[TrackRow]:
    """Yield one TrackRow per readable audio file found under *root*."""
    for dirpath, _dirs, filenames in os.walk(root):
        for name in filenames:
            ext = os.path.splitext(name)[1].lower()
            if ext not in AUDIO_EXTS:
                continue
            path = os.path.join(dirpath, name)
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            row = scan_file(path, mtime)
            if row is not None:
                yield row
