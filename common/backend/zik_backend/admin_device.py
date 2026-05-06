"""Admin API — device configuration for Target 1 (demo stubs).

In production (Target 2+) format/fsck/update/reinstall go through the privhelper
binary and the maintenance partition.  Here only default_quota_mb is functional;
all hardware actions return a "not available in demo" stub response.
"""

from dataclasses import asdict, dataclass

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route


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

    async def stub_action(request: Request) -> JSONResponse:
        """Placeholder for hardware actions not available in the demo target."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        return JSONResponse({"ok": False, "error": "not-available-in-demo"}, status_code=501)

    return [
        Route("/api/admin/device",              get_config,   methods=["GET"]),
        Route("/api/admin/device",              patch_config, methods=["PATCH"]),
        Route("/api/admin/device/format-drive", stub_action,  methods=["POST"]),
        Route("/api/admin/device/update-app",   stub_action,  methods=["POST"]),
        Route("/api/admin/device/fsck",         stub_action,  methods=["POST"]),
        Route("/api/admin/device/reinstall",    stub_action,  methods=["POST"]),
    ]
