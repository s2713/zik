"""Admin API — network policy management for Target 1 (demo stubs).

In production (Target 2+) Wi-Fi networks are managed via nmcli/NetworkManager
and the privhelper binary.  Here everything is in-memory.
"""

import re
from dataclasses import asdict, dataclass

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

_SSID_RE = re.compile(r"^[\w\s\-\.]{1,32}$")
_SECURITY_OPTIONS = ("WPA2", "WPA3", "WPA2/WPA3", "Open")


@dataclass
class NetworkPolicy:
    """Global Wi-Fi policy defaults (per-user wifi flag still applies on top)."""
    wifi_connect_allowed: bool = True   # device-wide connect permission
    wifi_add_allowed:     bool = False  # device-wide add-new-network permission


@dataclass
class WifiNetwork:
    """System Wi-Fi connection entry (stub; not connected to nmcli in demo)."""
    ssid:        str
    security:    str  = "WPA2"
    system_wide: bool = True   # True = all users; False = admin only


def make_network_store() -> tuple[NetworkPolicy, list[WifiNetwork]]:
    """Return a fresh in-memory network policy and an empty network list."""
    return NetworkPolicy(), []


def make_admin_network_router(
    sessions: dict,
    policy:   NetworkPolicy,
    networks: list[WifiNetwork],
) -> list:
    """Return Starlette Route list for admin network-management endpoints."""

    def _require_admin(request: Request) -> dict | None:
        """Return the session dict if the caller is an authenticated admin, else None."""
        sid = request.cookies.get("__Host-zik-session")
        if not sid or sid not in sessions:
            return None
        s = sessions[sid]
        return s if s.get("is_admin") else None

    async def get_network(request: Request) -> JSONResponse:
        """Return current network policy and system Wi-Fi network list."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        return JSONResponse({
            "policy":   asdict(policy),
            "networks": [asdict(n) for n in networks],
        })

    async def patch_policy(request: Request) -> JSONResponse:
        """Update global Wi-Fi policy flags."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        body = await request.json()
        if "wifi_connect_allowed" in body:
            policy.wifi_connect_allowed = bool(body["wifi_connect_allowed"])
        if "wifi_add_allowed" in body:
            policy.wifi_add_allowed = bool(body["wifi_add_allowed"])
        return JSONResponse({"ok": True, "policy": asdict(policy)})

    async def add_network(request: Request) -> JSONResponse:
        """Add a system Wi-Fi network entry."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        body = await request.json()
        ssid = str(body.get("ssid", "")).strip()
        if not ssid or not _SSID_RE.match(ssid):
            return JSONResponse({"error": "invalid-ssid"}, status_code=400)
        if any(n.ssid == ssid for n in networks):
            return JSONResponse({"error": "already-exists"}, status_code=409)
        security    = str(body.get("security", "WPA2"))
        system_wide = bool(body.get("system_wide", True))
        if security not in _SECURITY_OPTIONS:
            security = "WPA2"
        net = WifiNetwork(ssid=ssid, security=security, system_wide=system_wide)
        networks.append(net)
        return JSONResponse({"ok": True, "network": asdict(net)})

    async def delete_network(request: Request) -> JSONResponse:
        """Remove a system Wi-Fi network entry by SSID."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        ssid = request.path_params["ssid"]
        idx  = next((i for i, n in enumerate(networks) if n.ssid == ssid), None)
        if idx is None:
            return JSONResponse({"error": "not-found"}, status_code=404)
        networks.pop(idx)
        return JSONResponse({"ok": True})

    return [
        Route("/api/admin/network",              get_network,    methods=["GET"]),
        Route("/api/admin/network/policy",       patch_policy,   methods=["PATCH"]),
        Route("/api/admin/network/wifi",         add_network,    methods=["POST"]),
        Route("/api/admin/network/wifi/{ssid}",  delete_network, methods=["DELETE"]),
    ]
