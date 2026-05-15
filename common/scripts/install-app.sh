#!/usr/bin/env bash
# common/scripts/install-app.sh — install zik build artifacts into a root tree.
#
# Usage:
#   install-app.sh --root <destdir> --src <repo-root> --version <tag>
#                  [--privhelp-bin <path>] [--pam-so <path>]
#
# Installs:
#   $ROOT/opt/zik/releases/$VERSION/   — app files
#   $ROOT/opt/zik/current              — symlink → releases/$VERSION
#   $ROOT/etc/systemd/system/          — system units
#   $ROOT/etc/systemd/user/            — user units
#   $ROOT/usr/lib/pam.d/               — PAM module (if --pam-so supplied)
#   $ROOT/usr/libexec/zik/             — privhelp + kiosk launcher
#
# This script is called by build-image.sh during image creation and will be
# called again by the OTA update mechanism at P6.3 (with --root /).

set -euo pipefail

ROOT=""
SRC=""
VERSION=""
PRIVHELP_BIN=""
PAM_SO=""

die()  { echo "install-app: error: $*" >&2; exit 1; }
info() { echo "install-app: $*"; }

while (($#)); do
    case "$1" in
        --root)         ROOT="$2";         shift 2 ;;
        --src)          SRC="$2";          shift 2 ;;
        --version)      VERSION="$2";      shift 2 ;;
        --privhelp-bin) PRIVHELP_BIN="$2"; shift 2 ;;
        --pam-so)       PAM_SO="$2";       shift 2 ;;
        *) die "unknown argument: $1" ;;
    esac
done

[[ -n "$ROOT" ]]    || die "--root is required"
[[ -n "$SRC" ]]     || die "--src is required"
[[ -n "$VERSION" ]] || die "--version is required"
[[ -d "$ROOT" ]]    || die "root directory does not exist: $ROOT"
[[ -d "$SRC" ]]     || die "source directory does not exist: $SRC"

RELEASE_DIR="${ROOT}/opt/zik/releases/${VERSION}"
LIBEXEC_DIR="${ROOT}/usr/libexec/zik"

# ---- directory skeleton ------------------------------------------------------

info "creating directory skeleton"
install -d -m 0755 "${ROOT}/opt/zik/releases"
install -d -m 0755 "${RELEASE_DIR}"
install -d -m 0755 "${RELEASE_DIR}/backend"
install -d -m 0755 "${RELEASE_DIR}/frontend"
install -d -m 0755 "${LIBEXEC_DIR}"
install -d -m 0750 "${ROOT}/var/lib/zik"
install -d -m 0750 "${ROOT}/var/cache/zik"
install -d -m 0750 "${ROOT}/var/log/zik"
install -d -m 0755 "${ROOT}/etc/zik"

# ---- backend wheel -----------------------------------------------------------

info "installing backend"
WHEEL="$(find "${SRC}/common/backend/dist" -maxdepth 1 -name '*.whl' | head -1)"
[[ -n "$WHEEL" ]] || die "no backend wheel found in ${SRC}/common/backend/dist/ — run 'poetry build' first"

# Create a venv at the release path and install the wheel into it.
python3 -m venv "${RELEASE_DIR}/venv"
"${RELEASE_DIR}/venv/bin/pip" install --quiet --no-deps "${WHEEL}"

# Write the version file.
echo "${VERSION}" > "${RELEASE_DIR}/version"

# ---- frontend static assets --------------------------------------------------

info "installing frontend"
FRONTEND_DIST="${SRC}/common/frontend/dist"
[[ -d "$FRONTEND_DIST" ]] || die "frontend dist not found — run 'pnpm build' first"
cp -a "${FRONTEND_DIST}/." "${RELEASE_DIR}/frontend/"

# ---- privhelp binary ---------------------------------------------------------

if [[ -n "$PRIVHELP_BIN" ]]; then
    info "installing privhelp"
    [[ -f "$PRIVHELP_BIN" ]] || die "privhelp binary not found: $PRIVHELP_BIN"
    install -m 0755 "$PRIVHELP_BIN" "${LIBEXEC_DIR}/zik-privhelp"
    # setuid root is applied by build-image.sh after chroot setup (requires root).
else
    info "skipping privhelp (--privhelp-bin not supplied)"
fi

# ---- PAM module --------------------------------------------------------------

if [[ -n "$PAM_SO" ]]; then
    info "installing PAM module"
    [[ -f "$PAM_SO" ]] || die "PAM .so not found: $PAM_SO"
    PAM_LIB_DIR="${ROOT}/usr/lib/$(uname -m)-linux-gnu/security"
    install -d -m 0755 "${PAM_LIB_DIR}"
    install -m 0644 "$PAM_SO" "${PAM_LIB_DIR}/pam_zik_adminlock.so"
else
    info "skipping PAM module (--pam-so not supplied)"
fi

# ---- systemd units -----------------------------------------------------------

info "installing systemd units"
SYSTEMD_SRC="${SRC}/common/systemd"

install -d -m 0755 "${ROOT}/etc/systemd/system"
install -d -m 0755 "${ROOT}/etc/systemd/user"

shopt -s nullglob
for unit in "${SYSTEMD_SRC}"/*.service "${SYSTEMD_SRC}"/*.timer; do
    install -m 0644 "$unit" "${ROOT}/etc/systemd/system/"
done
for unit in "${SYSTEMD_SRC}/user"/*.service "${SYSTEMD_SRC}/user"/*.timer; do
    install -m 0644 "$unit" "${ROOT}/etc/systemd/user/"
done
shopt -u nullglob

# ---- kiosk launcher ----------------------------------------------------------

info "installing kiosk launcher"
CHROMIUM_FLAGS_FILE="${SRC}/targets/chromebook/overrides/chromium-flags"

# Build the chromium flags argument list from the flags file.
CHROMIUM_FLAGS=""
if [[ -f "$CHROMIUM_FLAGS_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${line// }" ]]           && continue
        CHROMIUM_FLAGS="${CHROMIUM_FLAGS} ${line}"
    done < "$CHROMIUM_FLAGS_FILE"
fi

cat > "${LIBEXEC_DIR}/start-kiosk.sh" << KIOSK_EOF
#!/usr/bin/env bash
# Auto-generated by install-app.sh — do not edit manually.
set -euo pipefail
exec cage -d -- chromium${CHROMIUM_FLAGS}
KIOSK_EOF
chmod 0755 "${LIBEXEC_DIR}/start-kiosk.sh"

# ---- backend launcher wrapper ------------------------------------------------

# Thin wrapper so systemd ExecStart can point to a stable path that the OTA
# symlink swap keeps current without touching unit files.
cat > "${LIBEXEC_DIR}/zik-backend" << BACKEND_EOF
#!/usr/bin/env bash
# Auto-generated by install-app.sh — do not edit manually.
exec /opt/zik/current/venv/bin/python -m zik_backend "\$@"
BACKEND_EOF
chmod 0755 "${LIBEXEC_DIR}/zik-backend"

# ---- /opt/zik/current symlink ------------------------------------------------

info "updating /opt/zik/current → releases/${VERSION}"
# Atomic symlink swap: ln -sfn creates a new symlink then renames atomically.
ln -sfn "releases/${VERSION}" "${ROOT}/opt/zik/current"

# ---- ownership ---------------------------------------------------------------
# Applied here only when running as root (i.e. inside chroot during image build).
# When called by the OTA updater (P6.3) it also runs as root.

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    info "setting ownership"
    chown -R zik:zik "${ROOT}/opt/zik" 2>/dev/null || true
    chown -R zik:zik "${ROOT}/var/lib/zik" 2>/dev/null || true
    chown -R zik:zik "${ROOT}/var/cache/zik" 2>/dev/null || true
    chown -R zik:zik "${ROOT}/var/log/zik" 2>/dev/null || true
fi

info "done — installed version ${VERSION} to ${ROOT}"
