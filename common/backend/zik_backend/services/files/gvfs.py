"""gvfs helpers for mounting SMB shares via `gio mount`."""

import asyncio
import os


def gvfs_mount_path(server: str, share: str, subpath: str = "") -> str:
    """Return the local path where gvfs mounts smb://server/share."""
    uid = os.getuid()
    # gvfs 1.x places mounts under /run/user/{uid}/gvfs/smb-share:server=…,share=…/
    base = f"/run/user/{uid}/gvfs/smb-share:server={server},share={share}"
    return os.path.join(base, subpath.lstrip("/")) if subpath else base


async def gvfs_mount(
    server: str,
    share: str,
    username: str,
    password: str,
) -> tuple[bool, str]:
    """Run `gio mount smb://[user:pass@]server/share`. Return (ok, error_msg).

    Credentials are embedded in the URI (visible in /proc — demo only; v2 will
    use GNOME keyring / stdin handshake instead).
    """
    uri = (
        f"smb://{username}:{password}@{server}/{share}"
        if username
        else f"smb://{server}/{share}"
    )
    try:
        proc = await asyncio.create_subprocess_exec(
            "gio", "mount", uri,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _out, err = await asyncio.wait_for(proc.communicate(), timeout=15.0)
        if proc.returncode == 0:
            return True, ""
        return False, err.decode(errors="replace").strip()
    except FileNotFoundError:
        return False, "gio not found — install gvfs-backends"
    except TimeoutError:
        return False, "gio mount timed out"


async def gvfs_unmount(server: str, share: str) -> tuple[bool, str]:
    """Run `gio mount -u smb://server/share`. Return (ok, error_msg)."""
    uri = f"smb://{server}/{share}"
    try:
        proc = await asyncio.create_subprocess_exec(
            "gio", "mount", "-u", uri,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _out, err = await asyncio.wait_for(proc.communicate(), timeout=10.0)
        if proc.returncode == 0:
            return True, ""
        return False, err.decode(errors="replace").strip()
    except FileNotFoundError:
        return False, "gio not found — install gvfs-backends"
    except TimeoutError:
        return False, "gio unmount timed out"
