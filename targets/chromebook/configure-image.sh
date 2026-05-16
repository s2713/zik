#!/usr/bin/env bash
# targets/chromebook/configure-image.sh — apply per-device configuration to a zik image.
#
# Usage:
#   ./configure-image.sh --image <path.img.zst> [OPTIONS]
#
# Options:
#   --image <file>      Input .img.zst produced by build-image.sh (required)
#   --config <file>     YAML config file (default: config.yaml in same dir as --image)
#   --output <file>     Output .img.zst (default: overwrite input)
#   --no-compress       Leave output as raw .img (skip zstd)
#   -h, --help          Show this help
#
# Config YAML keys (all optional):
#   admin_password: "secret"          — hashed and stored in /etc/shadow for the admin user
#   users:                            — list of {name, password} pairs
#     - name: alice
#       password: "hunter2"
#   language: "en"                    — default UI language (en / fr)
#   timezone: "Europe/Paris"          — TZ identifier
#   wifi:                             — list of {ssid, psk} pairs pre-configured via NM
#     - ssid: "MyHome"
#       psk:  "wpa-passphrase"
#   ssh_authorized_keys: |            — public keys for admin SSH access (P6.3)
#     ssh-ed25519 AAAA... user@host
#
# Must be run as root.

set -euo pipefail

IMAGE=""
CONFIG=""
OUTPUT=""
NO_COMPRESS=0

die()  { echo "configure-image: error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

# ---- argument parsing --------------------------------------------------------

while (($#)); do
    case "$1" in
        --image)       IMAGE="$2";    shift 2 ;;
        --config)      CONFIG="$2";   shift 2 ;;
        --output)      OUTPUT="$2";   shift 2 ;;
        --no-compress) NO_COMPRESS=1; shift ;;
        -h|--help)
            sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) die "unknown argument: $1 (see --help)" ;;
    esac
done

[[ -n "$IMAGE" ]] || die "--image is required"
[[ -f "$IMAGE" ]] || die "image not found: $IMAGE"
[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "must be run as root"

# Resolve config file.
if [[ -z "$CONFIG" ]]; then
    CONFIG="$(dirname "${IMAGE}")/config.yaml"
fi
[[ -f "$CONFIG" ]] || die "config file not found: $CONFIG (create one or pass --config)"

# Resolve output path.
[[ -n "$OUTPUT" ]] || OUTPUT="${IMAGE}"

# ---- decompress image --------------------------------------------------------

WORK_DIR="$(mktemp -d /tmp/zik-configure.XXXXXX)"
trap 'umount_all; rm -rf "${WORK_DIR}"' EXIT INT TERM

LOOP_DEV=""
MOUNT_ROOT="${WORK_DIR}/root"
mkdir -p "${MOUNT_ROOT}"

umount_all() {
    if [[ -n "${LOOP_DEV:-}" ]]; then
        for mp in "${MOUNT_ROOT}/boot/efi" "${MOUNT_ROOT}"; do
            if mountpoint -q "$mp" 2>/dev/null; then umount -l "$mp"; fi
        done
        losetup -d "${LOOP_DEV}" 2>/dev/null || true
        unset LOOP_DEV
    fi
}

info "decompressing image"
RAW_IMAGE="${WORK_DIR}/image.img"
if [[ "$IMAGE" == *.zst ]]; then
    zstd -d --quiet "${IMAGE}" -o "${RAW_IMAGE}"
else
    cp "${IMAGE}" "${RAW_IMAGE}"
fi

LOOP_DEV="$(losetup --find --show --partscan "${RAW_IMAGE}")"
info "loop device: ${LOOP_DEV}"
udevadm settle || partprobe "${LOOP_DEV}" || true
sleep 1

P_ROOT="${LOOP_DEV}p2"
P_ESP="${LOOP_DEV}p1"

# Remount root rw for configuration.
mount -o rw "${P_ROOT}" "${MOUNT_ROOT}"
mkdir -p "${MOUNT_ROOT}/boot/efi"
mount "${P_ESP}" "${MOUNT_ROOT}/boot/efi"

# ---- parse config.yaml with python ------------------------------------------

info "parsing config: $CONFIG"

parse_config() {
    python3 - "${CONFIG}" << 'PYEOF'
import sys, json
try:
    import yaml
    cfg = yaml.safe_load(open(sys.argv[1])) or {}
except ImportError:
    # Fallback: very basic YAML parser for simple key: value lines.
    # Handles top-level scalar keys and the wifi/users list blocks.
    import re
    cfg = {}
    key = None
    list_key = None
    item = {}
    with open(sys.argv[1]) as f:
        for line in f:
            line = line.rstrip('\n')
            # Top-level key: value
            m = re.match(r'^(\w+):\s*(.*)', line)
            if m and not line.startswith(' '):
                if list_key and item:
                    cfg.setdefault(list_key, []).append(item)
                    item = {}
                key = m.group(1)
                val = m.group(2).strip().strip('"\'')
                if val:
                    cfg[key] = val
                    list_key = None
                else:
                    list_key = key
            elif list_key and re.match(r'^\s+-\s+\w+:', line):
                if item:
                    cfg.setdefault(list_key, []).append(item)
                item = {}
            elif list_key and re.match(r'^\s+\w+:', line):
                m2 = re.match(r'^\s+(\w+):\s*(.*)', line)
                if m2:
                    item[m2.group(1)] = m2.group(2).strip().strip('"\'')
    if list_key and item:
        cfg.setdefault(list_key, []).append(item)

print(json.dumps(cfg))
PYEOF
}

CFG_JSON="$(parse_config)"

get_cfg() {
    # get_cfg <key> [default]
    python3 -c "import sys,json; d=json.loads(sys.argv[1]); print(d.get(sys.argv[2], sys.argv[3] if len(sys.argv)>3 else ''))" \
        "${CFG_JSON}" "$1" "${2:-}"
}

ADMIN_PW="$(get_cfg admin_password)"
LANGUAGE="$(get_cfg language "en")"
TIMEZONE="$(get_cfg timezone "UTC")"
SSH_KEYS="$(get_cfg ssh_authorized_keys)"

# ---- timezone ----------------------------------------------------------------

info "setting timezone: ${TIMEZONE}"
if [[ -f "${MOUNT_ROOT}/usr/share/zoneinfo/${TIMEZONE}" ]]; then
    ln -sf "/usr/share/zoneinfo/${TIMEZONE}" "${MOUNT_ROOT}/etc/localtime"
    echo "${TIMEZONE}" > "${MOUNT_ROOT}/etc/timezone"
else
    echo "configure-image: warning: unknown timezone '${TIMEZONE}', keeping UTC" >&2
fi

# ---- default language --------------------------------------------------------

info "setting default language: ${LANGUAGE}"
LANG_MAP='{"en":"en_GB.UTF-8","fr":"fr_FR.UTF-8"}'
LOCALE="$(python3 -c "import sys,json; m=json.loads(sys.argv[1]); print(m.get(sys.argv[2],'en_GB.UTF-8'))" \
    "${LANG_MAP}" "${LANGUAGE}")"
echo "LANG=${LOCALE}" > "${MOUNT_ROOT}/etc/locale.conf"

# Write the zik default-language config so the backend reads it at startup.
mkdir -p "${MOUNT_ROOT}/etc/zik"
echo "${LANGUAGE}" > "${MOUNT_ROOT}/etc/zik/default-language"

# ---- admin user --------------------------------------------------------------

run_in_mount() { chroot "${MOUNT_ROOT}" "$@"; }

if [[ -n "${ADMIN_PW}" ]]; then
    info "creating admin user"
    # Create admin user if absent; add to sudo.
    run_in_mount useradd \
        --create-home \
        --shell /usr/bin/zsh \
        --groups sudo \
        --comment "zik administrator" \
        zik-admin 2>/dev/null || true
    # Set password via chpasswd (accepts plaintext, hashes internally).
    echo "zik-admin:${ADMIN_PW}" | run_in_mount chpasswd
    # Mark first-boot as done — no wizard needed.
    touch "${MOUNT_ROOT}/var/lib/zik/first-boot-done"
    info "first-boot gate written — wizard will be skipped"

    # ---- GRUB maintenance-entry password (C.21) --------------------------------
    # Replace @GRUB_PW_HASH@ with a real PBKDF2 hash so the maintenance GRUB
    # entry is protected by the admin password.  We patch both the grub.d script
    # (for future update-grub runs on the device) and the pre-generated grub.cfg.
    if command -v grub-mkpasswd-pbkdf2 >/dev/null 2>&1; then
        info "generating GRUB PBKDF2 password hash"
        GRUB_HASH="$(printf '%s\n%s\n' "${ADMIN_PW}" "${ADMIN_PW}" | \
            grub-mkpasswd-pbkdf2 2>/dev/null | \
            awk '/hash of/ {print $NF}')"
        if [[ -z "${GRUB_HASH}" ]]; then
            warn "grub-mkpasswd-pbkdf2 produced no output; maintenance entry remains locked"
        else
            GRUB_D="${MOUNT_ROOT}/etc/grub.d/01_zik_password"
            GRUB_CFG="${MOUNT_ROOT}/boot/grub/grub.cfg"
            [[ -f "${GRUB_D}" ]]   && sed -i "s|@GRUB_PW_HASH@|${GRUB_HASH}|g" "${GRUB_D}"
            [[ -f "${GRUB_CFG}" ]] && sed -i "s|@GRUB_PW_HASH@|${GRUB_HASH}|g" "${GRUB_CFG}"
            info "GRUB maintenance entry protected with admin password"
        fi
    else
        warn "grub-mkpasswd-pbkdf2 not found on build host; maintenance GRUB entry will be inaccessible"
    fi
else
    info "no admin_password in config — first-boot wizard will run"
    info "GRUB maintenance entry will use placeholder hash (inaccessible until password is set)"
    rm -f "${MOUNT_ROOT}/var/lib/zik/first-boot-done"
fi

# ---- regular users -----------------------------------------------------------

USER_COUNT="$(python3 -c "import sys,json; d=json.loads(sys.argv[1]); print(len(d.get('users',[])))" "${CFG_JSON}")"
for i in $(seq 0 $(( USER_COUNT - 1 ))); do
    UNAME="$(python3 -c "import sys,json; d=json.loads(sys.argv[1]); print(d['users'][int(sys.argv[2])]['name'])" "${CFG_JSON}" "${i}")"
    UPW="$(python3   -c "import sys,json; d=json.loads(sys.argv[1]); print(d['users'][int(sys.argv[2])].get('password',''))" "${CFG_JSON}" "${i}")"
    info "creating user: ${UNAME}"
    run_in_mount useradd \
        --create-home \
        --shell /usr/sbin/nologin \
        --comment "zik user" \
        "${UNAME}" 2>/dev/null || true
    if [[ -n "${UPW}" ]]; then
        echo "${UNAME}:${UPW}" | run_in_mount chpasswd
    fi
done

# ---- Wi-Fi pre-configuration via NetworkManager ------------------------------

WIFI_COUNT="$(python3 -c "import sys,json; d=json.loads(sys.argv[1]); print(len(d.get('wifi',[])))" "${CFG_JSON}")"
if (( WIFI_COUNT > 0 )); then
    info "pre-configuring ${WIFI_COUNT} Wi-Fi network(s)"
    NM_CONNS="${MOUNT_ROOT}/etc/NetworkManager/system-connections"
    mkdir -p "${NM_CONNS}"

    for i in $(seq 0 $(( WIFI_COUNT - 1 ))); do
        SSID="$(python3 -c "import sys,json; d=json.loads(sys.argv[1]); print(d['wifi'][int(sys.argv[2])]['ssid'])" "${CFG_JSON}" "${i}")"
        PSK="$(python3  -c "import sys,json; d=json.loads(sys.argv[1]); print(d['wifi'][int(sys.argv[2])].get('psk',''))" "${CFG_JSON}" "${i}")"
        SAFE_SSID="${SSID// /_}"
        CONN_FILE="${NM_CONNS}/${SAFE_SSID}.nmconnection"

        cat > "${CONN_FILE}" << NM_EOF
[connection]
id=${SSID}
type=wifi
autoconnect=true

[wifi]
ssid=${SSID}
mode=infrastructure

[wifi-security]
key-mgmt=wpa-psk
psk=${PSK}

[ipv4]
method=auto

[ipv6]
method=auto
NM_EOF
        chmod 0600 "${CONN_FILE}"
        info "  Wi-Fi: ${SSID}"
    done
fi

# ---- SSH authorized keys (admin remote access, P6.3) -------------------------

if [[ -n "${SSH_KEYS}" ]]; then
    info "installing SSH authorized keys for zik-admin"
    ADMIN_SSH_DIR="${MOUNT_ROOT}/home/zik-admin/.ssh"
    mkdir -p "${ADMIN_SSH_DIR}"
    echo "${SSH_KEYS}" > "${ADMIN_SSH_DIR}/authorized_keys"
    chmod 0700 "${ADMIN_SSH_DIR}"
    chmod 0600 "${ADMIN_SSH_DIR}/authorized_keys"
    chroot "${MOUNT_ROOT}" chown -R zik-admin:zik-admin /home/zik-admin/.ssh
fi

# ---- unmount and compress ----------------------------------------------------

umount "${MOUNT_ROOT}/boot/efi"
umount "${MOUNT_ROOT}"
losetup -d "${LOOP_DEV}"
unset LOOP_DEV

if (( NO_COMPRESS )); then
    cp "${RAW_IMAGE}" "${OUTPUT%.zst}"
    info "raw image written: ${OUTPUT%.zst}"
else
    info "compressing to ${OUTPUT}"
    zstd --rm -q -T0 -o "${OUTPUT}" "${RAW_IMAGE}"
    info "configured image written: ${OUTPUT}"
fi
