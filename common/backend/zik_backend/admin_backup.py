"""Admin API — config backup export / import (Target 1 demo).

Backup format (JSON file, .zik-backup extension):
  {
    "version": 1,
    "kdf": "scrypt",
    "kdf_n": 16384, "kdf_r": 8, "kdf_p": 1,
    "salt":       "<base64>",   -- 32-byte random salt for scrypt
    "nonce":      "<base64>",   -- 12-byte random nonce for AES-GCM
    "ciphertext": "<base64>"    -- AES-256-GCM over the plaintext JSON
  }

The plaintext JSON contains:
  { "version": 1, "users": {...}, "services": {...},
    "network_policy": {...}, "networks": [...],
    "device": {...}, "lock": {...} }

Admin auth + fresh reauth required for both endpoints.
In production the stores would be read from / written to the persistent DB;
in the demo everything is in-memory.
"""

import base64
import json
import os
from dataclasses import asdict

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

_BACKUP_VERSION = 1
_KDF_N, _KDF_R, _KDF_P = 16384, 8, 1   # scrypt parameters (OWASP minimum)


def _derive_key(passphrase: str, salt: bytes) -> bytes:
    """Derive a 32-byte AES key from passphrase + salt using scrypt."""
    kdf = Scrypt(salt=salt, length=32, n=_KDF_N, r=_KDF_R, p=_KDF_P)
    return kdf.derive(passphrase.encode())


def _encrypt(plaintext: bytes, passphrase: str) -> dict:
    """Return the encrypted blob dict ready to be JSON-serialised."""
    salt  = os.urandom(32)
    nonce = os.urandom(12)
    key   = _derive_key(passphrase, salt)
    ct    = AESGCM(key).encrypt(nonce, plaintext, None)
    return {
        "version":    _BACKUP_VERSION,
        "kdf":        "scrypt",
        "kdf_n":      _KDF_N,
        "kdf_r":      _KDF_R,
        "kdf_p":      _KDF_P,
        "salt":       base64.b64encode(salt).decode(),
        "nonce":      base64.b64encode(nonce).decode(),
        "ciphertext": base64.b64encode(ct).decode(),
    }


def _decrypt(blob: dict, passphrase: str) -> bytes:
    """Decrypt a blob dict; raises ValueError / cryptography exceptions on failure."""
    if blob.get("version") != _BACKUP_VERSION:
        raise ValueError("unsupported backup version")
    if blob.get("kdf") != "scrypt":
        raise ValueError("unsupported kdf")
    salt  = base64.b64decode(blob["salt"])
    nonce = base64.b64decode(blob["nonce"])
    ct    = base64.b64decode(blob["ciphertext"])
    n     = int(blob.get("kdf_n", _KDF_N))
    r     = int(blob.get("kdf_r", _KDF_R))
    p     = int(blob.get("kdf_p", _KDF_P))
    kdf   = Scrypt(salt=salt, length=32, n=n, r=r, p=p)
    key   = kdf.derive(passphrase.encode())
    return AESGCM(key).decrypt(nonce, ct, None)


def make_admin_backup_router(
    sessions:       dict,
    users:          dict,
    services:       dict,
    network_policy,
    networks:       list,
    device_config,
    lock,
) -> list:
    """Return Starlette Route list for config backup/import endpoints."""

    # Import these here to avoid a circular dependency at module level.
    from .admin import UserRecord  # noqa: PLC0415
    from .admin_services import ServiceRecord  # noqa: PLC0415

    def _require_admin_reauth(request: Request) -> dict | None:
        """Return the session dict if the caller is an admin with a fresh reauth."""
        sid = request.cookies.get("__Host-zik-session")
        if not sid or sid not in sessions:
            return None
        s = sessions[sid]
        if not s.get("is_admin"):
            return None
        import time  # noqa: PLC0415
        at = s.get("reauth_at")
        if at is None or (time.monotonic() - at) >= 60:
            return None
        return s

    def _serialise() -> bytes:
        """Serialise all in-memory stores to a plaintext JSON blob."""
        data = {
            "version":        _BACKUP_VERSION,
            "users":          {u: asdict(r) for u, r in users.items()},
            "services":       {s: asdict(r) for s, r in services.items()},
            "network_policy": asdict(network_policy),
            "networks":       [asdict(n) for n in networks],
            "device":         asdict(device_config),
            "lock":           asdict(lock),
        }
        return json.dumps(data).encode()

    def _restore(data: dict) -> None:
        """Restore all in-memory stores from a deserialised plaintext dict."""
        # Users — rebuild UserRecord objects.
        users.clear()
        for name, rec in data.get("users", {}).items():
            users[name] = UserRecord(**{
                k: v for k, v in rec.items()
                if k in UserRecord.__dataclass_fields__
            })

        # Services — rebuild ServiceRecord objects.
        services.clear()
        for sid, rec in data.get("services", {}).items():
            services[sid] = ServiceRecord(**{
                k: v for k, v in rec.items()
                if k in ServiceRecord.__dataclass_fields__
            })

        # Network policy — update fields in-place.
        for k, v in data.get("network_policy", {}).items():
            if hasattr(network_policy, k):
                setattr(network_policy, k, v)

        # Network list — rebuild in-place.
        from .admin_network import WifiNetwork  # noqa: PLC0415
        networks.clear()
        for n in data.get("networks", []):
            networks.append(WifiNetwork(**{
                k: v for k, v in n.items()
                if k in WifiNetwork.__dataclass_fields__
            }))

        # Device config — update fields in-place.
        for k, v in data.get("device", {}).items():
            if hasattr(device_config, k):
                setattr(device_config, k, v)

        # Lock — update fields in-place (clear lock on restore for safety).
        lock.locked       = False
        lock.locked_until = None

    async def export_backup(request: Request) -> Response:
        """Encrypt and return the current config as a downloadable backup file."""
        if _require_admin_reauth(request) is None:
            return JSONResponse({"error": "reauth-required"}, status_code=403)
        body = await request.json()
        passphrase = str(body.get("passphrase", "")).strip()
        if len(passphrase) < 8:
            return JSONResponse({"error": "passphrase-too-short"}, status_code=400)
        blob = _encrypt(_serialise(), passphrase)
        content = json.dumps(blob, indent=2).encode()
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": 'attachment; filename="zik-backup.json"'},
        )

    async def import_backup(request: Request) -> JSONResponse:
        """Decrypt and restore a previously exported backup file."""
        if _require_admin_reauth(request) is None:
            return JSONResponse({"error": "reauth-required"}, status_code=403)
        body = await request.json()
        passphrase = str(body.get("passphrase", "")).strip()
        raw_blob   = body.get("data")
        if not passphrase or not isinstance(raw_blob, dict):
            return JSONResponse({"error": "invalid-request"}, status_code=400)
        try:
            plaintext = _decrypt(raw_blob, passphrase)
            data      = json.loads(plaintext)
        except Exception:
            return JSONResponse({"error": "decrypt-failed"}, status_code=400)
        try:
            _restore(data)
        except Exception as exc:
            return JSONResponse({"error": f"restore-failed: {exc}"}, status_code=400)
        return JSONResponse({"ok": True})

    return [
        Route("/api/admin/backup/export", export_backup, methods=["POST"]),
        Route("/api/admin/backup/import", import_backup, methods=["POST"]),
    ]
