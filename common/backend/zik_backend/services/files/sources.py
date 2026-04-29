"""Source registry: named roots that can be independently mounted/unmounted."""

from dataclasses import asdict, dataclass, field


@dataclass
class Source:
    """A named audio file root (internal storage, removable drive, SMB share, etc.)."""
    id: str       # stable identifier, e.g. "internal", "removable", or a uuid
    label: str    # human-readable display name
    root: str     # local filesystem path (for SMB: the gvfs mount point)
    kind: str     # "internal" | "removable" | "smb"
    mounted: bool # whether currently active / visible in the library
    # kind-specific config; passwords are excluded from API responses (see as_dict).
    config: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        """Serialise to a plain dict for JSON responses (password redacted)."""
        d = asdict(self)
        if d.get("config"):
            d["config"] = {k: v for k, v in d["config"].items() if k != "password"}
        return d


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

    def add_source(self, source: Source) -> None:
        """Add a new source (e.g. a persisted LAN share loaded at startup)."""
        self._sources[source.id] = source

    def remove_source(self, source_id: str) -> Source | None:
        """Remove and return a source, or None if not found."""
        return self._sources.pop(source_id, None)

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
