"""Admin API — device management.

In demo mode (privhelp absent): fsck and reinstall return 501; recovery phrase
generation and verification are fully functional (hash stored in-memory
instead of /var/lib/zik/ which may not be writable).

In production (Target 2+): fsck schedules a reboot into the maintenance
partition; reinstall calls privhelp directly; recovery phrase hash is
persisted to /var/lib/zik/recovery-phrase.hash.
"""

import asyncio
from dataclasses import asdict, dataclass
from pathlib import Path

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .recovery_phrase import (
    generate_phrase,
    hash_phrase,
    phrase_is_set,
    store_phrase_hash,
)

PRIVHELP_BIN = Path("/usr/libexec/zik/zik-privhelp")

# In demo mode (no PRIVHELP_BIN), keep the phrase hash in process memory so
# the admin-panel flow still works without needing /var/lib/zik/.
_demo_phrase_hash: str | None = None


def _is_demo() -> bool:
    """True when running on the demo target (no privhelp binary)."""
    return not PRIVHELP_BIN.exists()


@dataclass
class DeviceConfig:
    """Device-level configuration managed by the admin."""
    default_quota_mb: int = 1024  # quota assigned to newly created users


def make_device_store() -> DeviceConfig:
    """Return a fresh in-memory device configuration."""
    return DeviceConfig()


def make_admin_device_router(
    sessions: dict,
    config:   DeviceConfig,
) -> list:
    """Return Starlette Route list for admin device-management endpoints."""

    def _require_admin(request: Request) -> dict | None:
        """Return the session dict if the caller is an authenticated admin, else None."""
        sid = request.cookies.get("__Host-zik-session")
        if not sid or sid not in sessions:
            return None
        s = sessions[sid]
        return s if s.get("is_admin") else None

    async def get_config(request: Request) -> JSONResponse:
        """Return current device configuration."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        return JSONResponse(asdict(config))

    async def patch_config(request: Request) -> JSONResponse:
        """Update device configuration (only default_quota_mb for now)."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        body = await request.json()
        if "default_quota_mb" in body:
            config.default_quota_mb = max(0, int(body["default_quota_mb"]))
        return JSONResponse({"ok": True, "config": asdict(config)})

    # ---- recovery phrase -------------------------------------------------------

    async def get_recovery_phrase_status(request: Request) -> JSONResponse:
        """GET /api/admin/device/recovery-phrase — return whether the phrase is set.

        Does NOT return the phrase itself; the plaintext is shown exactly once
        via the POST endpoint.
        """
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        global _demo_phrase_hash
        is_set = _demo_phrase_hash is not None if _is_demo() else phrase_is_set()
        return JSONResponse({"set": is_set})

    async def generate_recovery_phrase(request: Request) -> JSONResponse:
        """POST /api/admin/device/recovery-phrase — generate, store hash, return phrase once.

        If a phrase is already set, calling this replaces it (admin confirms in UI).
        """
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        global _demo_phrase_hash
        phrase = generate_phrase()
        if _is_demo():
            _demo_phrase_hash = hash_phrase(phrase)
        else:
            store_phrase_hash(phrase)
        return JSONResponse({"phrase": phrase})

    # ---- fsck ------------------------------------------------------------------

    async def schedule_fsck(request: Request) -> JSONResponse:
        """POST /api/admin/device/fsck — reboot to maintenance partition for fsck.

        On production: calls privhelp grub-reboot then reboots the device.
        On demo: returns 501.
        """
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        if _is_demo():
            return JSONResponse({"error": "not-available-in-demo"}, status_code=501)

        # Schedule maintenance boot for the next reboot.
        proc = await asyncio.create_subprocess_exec(
            str(PRIVHELP_BIN), "grub-reboot", "--entry", "maintenance",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            return JSONResponse(
                {"error": f"grub-reboot failed: {stderr.decode().strip()}"},
                status_code=500,
            )

        # Trigger system reboot (non-blocking — response goes out before reboot).
        await asyncio.create_subprocess_exec("systemctl", "reboot")
        return JSONResponse({"ok": True, "rebooting": True})

    # ---- reinstall -------------------------------------------------------------

    async def reinstall(request: Request) -> JSONResponse:
        """POST /api/admin/device/reinstall — reinstall app from current release.

        Re-creates the Python venv and re-installs the wheel from the saved copy
        in the current release directory, then restarts the backend.
        On demo: returns 501.
        """
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        if _is_demo():
            return JSONResponse({"error": "not-available-in-demo"}, status_code=501)

        proc = await asyncio.create_subprocess_exec(
            str(PRIVHELP_BIN), "reinstall",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            return JSONResponse(
                {"error": f"reinstall failed: {stderr.decode().strip()}"},
                status_code=500,
            )
        return JSONResponse({"ok": True})

    # ---- format drive (stub) ---------------------------------------------------

    async def stub_action(request: Request) -> JSONResponse:
        """Placeholder for hardware actions not yet implemented."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        return JSONResponse({"ok": False, "error": "not-available-in-demo"}, status_code=501)

    return [
        Route("/api/admin/device",                 get_config,                 methods=["GET"]),
        Route("/api/admin/device",                 patch_config,               methods=["PATCH"]),
        Route("/api/admin/device/recovery-phrase", get_recovery_phrase_status, methods=["GET"]),
        Route("/api/admin/device/recovery-phrase", generate_recovery_phrase,   methods=["POST"]),
        Route("/api/admin/device/fsck",            schedule_fsck,              methods=["POST"]),
        Route("/api/admin/device/reinstall",       reinstall,                  methods=["POST"]),
        Route("/api/admin/device/format-drive",    stub_action,                methods=["POST"]),
    ]
