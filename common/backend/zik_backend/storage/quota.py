"""Shared quota utilities: disk usage measurement and DB key constants."""

from pathlib import Path

QUOTA_KEY = "quota.limit_bytes"
DEFAULT_LIMIT = 1 * 1024 * 1024 * 1024  # 1 GB


def disk_usage(path: Path) -> int:
    """Return total bytes of all regular files under path (0 if path absent)."""
    if not path.exists():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())