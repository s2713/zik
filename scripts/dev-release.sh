#!/usr/bin/env bash
# scripts/dev-release.sh — build artifacts, generate a local manifest.json, and serve
# everything on a local HTTP server so the full OTA path can be tested on real hardware
# without going through GitHub Releases (P6.10).
#
# Usage:
#   VERSION=1.1.0 make dev-release         # from repo root
#   ./scripts/dev-release.sh 1.1.0         # directly; optional second arg = port
#   ./scripts/dev-release.sh 1.1.0 9000    # custom port
#
# On the target device (via SSH after the server is running):
#   sudo sh -c 'echo "http://DEV_HOST_IP:PORT/manifest.json" > /etc/zik/update-manifest-url'
# Then open the admin panel → Device → Updates → Check for updates.
#
# Notes:
#   - GPG signing is skipped; the target device needs no keyring (dev workflow only).
#   - SHA256 checksums are computed and embedded in manifest.json; the backend verifies them.
#   - VERSION must be strictly greater than the version installed on the target device
#     (monotonic check T-SW-15); use a suffix like "1.1.0-dev" if needed.
#   - Pass --no-build to skip the poetry/pnpm build step if artifacts are already built.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- argument parsing --------------------------------------------------------

VERSION="${1:-${VERSION:-}}"
PORT="${2:-${PORT:-8765}}"
NO_BUILD=0
for arg in "$@"; do [[ "$arg" == "--no-build" ]] && NO_BUILD=1; done

[[ -n "$VERSION" ]] || {
    echo "usage: dev-release.sh <VERSION> [<PORT>]  or  VERSION=x.y.z make dev-release" >&2
    exit 1
}

die()  { echo "dev-release: error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

# ---- build -------------------------------------------------------------------

if (( ! NO_BUILD )); then
    info "building backend wheel"
    (cd "${REPO_ROOT}/common/backend" && poetry build --format wheel -q)

    info "building frontend"
    (cd "${REPO_ROOT}/common/frontend" && pnpm build --silent)
fi

# ---- locate built artifacts --------------------------------------------------

WHEEL="$(find "${REPO_ROOT}/common/backend/dist" -name "*.whl" | sort -V | tail -1)"
[[ -n "$WHEEL" ]] || die "no wheel found in common/backend/dist — run without --no-build first"

FRONTEND_DIST="${REPO_ROOT}/common/frontend/dist"
[[ -d "$FRONTEND_DIST" ]] || die "frontend dist not found at ${FRONTEND_DIST} — run without --no-build first"

WHEEL_NAME="$(basename "$WHEEL")"
FRONTEND_TAR="zik-frontend-${VERSION}.tar.gz"

# ---- prepare serve directory -------------------------------------------------

SERVE_DIR="$(mktemp -d /tmp/zik-dev-release.XXXXXX)"
trap 'rm -rf "${SERVE_DIR}"' EXIT INT TERM

info "staging artifacts in ${SERVE_DIR}"

cp "$WHEEL" "${SERVE_DIR}/${WHEEL_NAME}"

# Create a tarball where the root IS the dist contents (no wrapper directory).
tar -czf "${SERVE_DIR}/${FRONTEND_TAR}" -C "${FRONTEND_DIST}" .

# ---- compute SHA256 ----------------------------------------------------------

WHEEL_SHA256="$(sha256sum "${SERVE_DIR}/${WHEEL_NAME}" | awk '{print $1}')"
FRONTEND_SHA256="$(sha256sum "${SERVE_DIR}/${FRONTEND_TAR}" | awk '{print $1}')"

# ---- determine local IP ------------------------------------------------------

LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[[ -n "$LOCAL_IP" ]] || LOCAL_IP="127.0.0.1"
BASE_URL="http://${LOCAL_IP}:${PORT}"

# ---- write manifest.json -----------------------------------------------------

MANIFEST="${SERVE_DIR}/manifest.json"
python3 - << PYEOF
import json
manifest = {
    "latest": "${VERSION}",
    "changelog_url": "",
    "artifacts": {
        "backend": {
            "url":    "${BASE_URL}/${WHEEL_NAME}",
            "sha256": "${WHEEL_SHA256}",
        },
        "frontend": {
            "url":    "${BASE_URL}/${FRONTEND_TAR}",
            "sha256": "${FRONTEND_SHA256}",
        },
    },
}
with open("${MANIFEST}", "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PYEOF

info "manifest written: ${MANIFEST}"
info ""
info "  version  : ${VERSION}"
info "  wheel    : ${WHEEL_NAME}  (sha256: ${WHEEL_SHA256:0:16}…)"
info "  frontend : ${FRONTEND_TAR}  (sha256: ${FRONTEND_SHA256:0:16}…)"
info ""
info "Serving at ${BASE_URL}/"
info ""
info "On the target device, run (via SSH):"
echo ""
echo "    sudo sh -c 'echo ${BASE_URL}/manifest.json > /etc/zik/update-manifest-url'"
echo ""
info "Then: Admin panel → Device → Updates → Check for updates."
info "Press Ctrl+C to stop the server."
echo ""

# ---- serve -------------------------------------------------------------------

cd "${SERVE_DIR}"
exec python3 -m http.server "${PORT}" --bind 0.0.0.0
