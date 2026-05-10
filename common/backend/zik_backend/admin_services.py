"""Admin API — service management for Target 1 (demo stubs).

In production (Target 2+) service credentials are persisted to the library DB
and the global-enable state affects the PAM session policy.  Here everything
is in-memory.
"""

from dataclasses import dataclass, field

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

_ALL_SERVICES = ["demo", "files", "mpd", "subsonic", "spotify", "podcasts", "radio", "playlists"]

# Credential fields exposed per service in the admin UI.
# Services not in this map have no system-shared credentials.
_CRED_FIELDS: dict[str, list[str]] = {
    "mpd":      ["host", "port", "password", "stream_url"],
    "subsonic": ["server", "user", "password"],
    "spotify":  ["client_id"],
}


@dataclass
class ServiceRecord:
    """In-memory representation of a managed service (demo only)."""
    global_enabled: bool = True
    credentials: dict[str, str] = field(default_factory=dict)


def make_service_store() -> dict[str, ServiceRecord]:
    """Seed the in-memory service store for all known services."""
    return {s: ServiceRecord() for s in _ALL_SERVICES}


def _to_dict(service_id: str, rec: ServiceRecord) -> dict:
    return {
        "id":             service_id,
        "global_enabled": rec.global_enabled,
        "credentials":    dict(rec.credentials),
        "cred_fields":    _CRED_FIELDS.get(service_id, []),
    }


def make_admin_services_router(
    sessions: dict,
    services: dict[str, ServiceRecord],
    audit=None,
) -> list:
    """Return Starlette Route list for admin service-management endpoints."""

    def _require_admin(request: Request) -> dict | None:
        """Return the session dict if the caller is an authenticated admin, else None."""
        sid = request.cookies.get("__Host-zik-session")
        if not sid or sid not in sessions:
            return None
        s = sessions[sid]
        return s if s.get("is_admin") else None

    async def list_services(request: Request) -> JSONResponse:
        """Return all services with their global state and shared credentials."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        return JSONResponse([_to_dict(sid, rec) for sid, rec in services.items()])

    async def patch_service(request: Request) -> JSONResponse:
        """Update global_enabled and/or shared credentials for a service."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        service_id = request.path_params["service_id"]
        if service_id not in services:
            return JSONResponse({"error": "not-found"}, status_code=404)
        body = await request.json()
        rec = services[service_id]
        if "global_enabled" in body:
            new_enabled = bool(body["global_enabled"])
            if audit is not None and rec.global_enabled != new_enabled:
                audit.add("admin",
                          "service-enable" if new_enabled else "service-disable",
                          service_id)
            rec.global_enabled = new_enabled
        if "credentials" in body and isinstance(body["credentials"], dict):
            # Only accept known credential fields for this service.
            allowed = _CRED_FIELDS.get(service_id, [])
            for k, v in body["credentials"].items():
                if k in allowed:
                    rec.credentials[k] = str(v)
        return JSONResponse({"ok": True, "service": _to_dict(service_id, rec)})

    async def global_enabled(request: Request) -> JSONResponse:
        """Return {service_id: bool} map of global enable flags; public, no auth required."""
        return JSONResponse({sid: rec.global_enabled for sid, rec in services.items()})

    return [
        Route("/api/admin/services",               list_services,  methods=["GET"]),
        Route("/api/admin/services/{service_id}",  patch_service,  methods=["PATCH"]),
        Route("/api/services/global",              global_enabled, methods=["GET"]),
    ]
