"""Source registry: named roots that can be independently mounted/unmounted."""

from dataclasses import asdict, dataclass


@dataclass
class Source:
    """A named audio file root (internal storage, removable drive, etc.)."""
    id: str       # stable identifier, e.g. "internal" or "removable"
    label: str    # human-readable display name
    root: str     # filesystem path
    kind: str     # "internal" | "removable"
    mounted: bool # whether currently active / visible in the library

    def as_dict(self) -> dict:
        """Serialise to a plain dict for JSON responses."""
        return asdict(self)


class SourceManager:
    """Hold the list of configured sources and their mount state."""

    def __init__(self, sources: list[Source]) -> None:
        # Preserve insertion order; id must be unique.
        self._sources: dict[str, Source] = {s.id: s for s in sources}

    def list_all(self) -> list[Source]:
        """Return all sources in insertion order."""
        return list(self._sources.values())

    def get(self, source_id: str) -> Source | None:
        """Return the source with the given id, or None."""
        return self._sources.get(source_id)

    def mount(self, source_id: str) -> Source | None:
        """Mark source as mounted and return it, or None if unknown."""
        s = self._sources.get(source_id)
        if s:
            s.mounted = True
        return s

    def unmount(self, source_id: str) -> Source | None:
        """Mark source as unmounted and return it, or None if unknown."""
        s = self._sources.get(source_id)
        if s:
            s.mounted = False
        return s
