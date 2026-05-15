"""Admin API — OTA app update.

Download flow:
  1. GET /api/admin/update/check  — fetch manifest, return current vs. latest.
  2. POST /api/admin/update/start — download artifacts, verify checksums + GPG
                                    signatures, call zik-privhelp to install.

The version manifest is a JSON file at a configurable URL (default: GitHub raw).
Artifact signatures are verified with gpg against the maintainer keyring at
GPG_KEYRING_PATH; verification is skipped in demo mode when the keyring is absent.
"""

import asyncio
import hashlib
import subprocess
import tarfile
import tempfile
from pathlib import Path

import httpx
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

MANIFEST_URL_FILE = Path("/etc/zik/update-manifest-url")
DEFAULT_MANIFEST_URL = (
    "https://raw.githubusercontent.com/zik-music/zik/main/releases/latest.json"
)
VERSION_FILE     = Path("/opt/zik/current/version")
PRIVHELP_BIN     = Path("/usr/libexec/zik/zik-privhelp")
GPG_KEYRING_PATH = Path("/usr/share/zik/trustedkeys.gpg")


def _manifest_url() -> str:
    """Return the configured manifest URL, or the default."""
    if MANIFEST_URL_FILE.exists():
        return MANIFEST_URL_FILE.read_text().strip()
    return DEFAULT_MANIFEST_URL


def _current_version() -> str:
    """Return the running version string, or 'unknown'."""
    try:
        return VERSION_FILE.read_text().strip()
    except OSError:
        return "unknown"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _gpg_verify(sig_path: Path, artifact_path: Path) -> bool:
    """Verify a detached GPG signature against the maintainer keyring."""
    result = subprocess.run(
        [
            "gpg", "--batch", "--no-default-keyring",
            "--keyring", str(GPG_KEYRING_PATH),
            "--verify", str(sig_path), str(artifact_path),
        ],
        capture_output=True,
    )
    return result.returncode == 0


def make_admin_update_router(sessions: dict) -> list:
    """Return Starlette Route list for update check and install endpoints."""

    def _require_admin(request: Request) -> dict | None:
        sid = request.cookies.get("__Host-zik-session")
        if not sid or sid not in sessions:
            return None
        s = sessions[sid]
        return s if s.get("is_admin") else None

    async def check_update(request: Request) -> JSONResponse:
        """GET /api/admin/update/check — fetch manifest and compare versions."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        current = _current_version()
        url = _manifest_url()
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.get(url)
                r.raise_for_status()
                manifest = r.json()
        except Exception as exc:
            return JSONResponse(
                {"error": f"manifest fetch failed: {exc}"},
                status_code=502,
            )
        latest = manifest.get("latest", "unknown")
        changelog_url = manifest.get("changelog_url", "")
        up_to_date = current == latest
        return JSONResponse({
            "current":       current,
            "latest":        latest,
            "up_to_date":    up_to_date,
            "changelog_url": changelog_url,
        })

    async def start_update(request: Request) -> JSONResponse:
        """POST /api/admin/update/start — download, verify, and install a release."""
        if _require_admin(request) is None:
            return JSONResponse({"error": "forbidden"}, status_code=403)
        if not PRIVHELP_BIN.exists():
            return JSONResponse(
                {"error": "update not supported in demo mode"},
                status_code=501,
            )

        # Fetch the manifest.
        url = _manifest_url()
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                r = await client.get(url)
                r.raise_for_status()
                manifest = r.json()
        except Exception as exc:
            return JSONResponse(
                {"error": f"manifest fetch failed: {exc}"},
                status_code=502,
            )

        version = manifest.get("latest", "")
        artifacts = manifest.get("artifacts", {})
        backend_info  = artifacts.get("backend", {})
        frontend_info = artifacts.get("frontend", {})

        if not version or not backend_info.get("url") or not frontend_info.get("url"):
            return JSONResponse(
                {"error": "manifest is incomplete or no release is available"},
                status_code=422,
            )
        if version == _current_version():
            return JSONResponse({"error": "already on this version"}, status_code=409)

        with tempfile.TemporaryDirectory(prefix="zik-update-") as tmpdir:
            tmp = Path(tmpdir)
            wheel_path        = tmp / f"zik_backend-{version}.whl"
            wheel_sig_path    = Path(str(wheel_path) + ".asc")
            frontend_tar_path = tmp / f"zik-frontend-{version}.tar.gz"
            frontend_sig_path = Path(str(frontend_tar_path) + ".asc")
            frontend_dir      = tmp / "frontend"

            # Download all artifacts.
            try:
                async with httpx.AsyncClient(timeout=120) as client:
                    for artifact_path, info in [
                        (wheel_path,        backend_info),
                        (frontend_tar_path, frontend_info),
                    ]:
                        r = await client.get(info["url"])
                        r.raise_for_status()
                        artifact_path.write_bytes(r.content)
                        # Checksum check.
                        if info.get("sha256") and _sha256(r.content) != info["sha256"]:
                            return JSONResponse(
                                {"error": f"checksum mismatch for {artifact_path.name}"},
                                status_code=422,
                            )
                        # Download detached GPG signature (best-effort, may be absent).
                        sig_r = await client.get(info["url"] + ".asc")
                        if sig_r.status_code == 200:
                            Path(str(artifact_path) + ".asc").write_bytes(sig_r.content)
            except httpx.HTTPError as exc:
                return JSONResponse(
                    {"error": f"download failed: {exc}"},
                    status_code=502,
                )

            # GPG verification (skipped in demo mode when keyring is absent).
            if GPG_KEYRING_PATH.exists():
                for artifact, sig in [
                    (wheel_path, wheel_sig_path),
                    (frontend_tar_path, frontend_sig_path),
                ]:
                    if sig.exists() and not _gpg_verify(sig, artifact):
                        return JSONResponse(
                            {"error": f"GPG verification failed for {artifact.name}"},
                            status_code=422,
                        )

            # Extract the frontend tarball.
            frontend_dir.mkdir()
            with tarfile.open(frontend_tar_path) as tf:
                tf.extractall(frontend_dir, filter="data")

            # Call privhelp to install (runs as root via setuid).
            proc = await asyncio.create_subprocess_exec(
                str(PRIVHELP_BIN),
                "update",
                "--version", version,
                "--wheel", str(wheel_path),
                "--frontend-dir", str(frontend_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()
            if proc.returncode != 0:
                return JSONResponse(
                    {"error": f"install failed: {stderr.decode().strip()}"},
                    status_code=500,
                )

        return JSONResponse({"ok": True, "version": version})

    return [
        Route("/api/admin/update/check", check_update,  methods=["GET"]),
        Route("/api/admin/update/start", start_update, methods=["POST"]),
    ]
