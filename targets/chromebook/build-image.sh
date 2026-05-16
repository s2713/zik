#!/usr/bin/env bash
# targets/chromebook/build-image.sh — build a zik Chromebook disk image.
#
# Usage:
#   ./build-image.sh [OPTIONS]
#
# Options:
#   --version <tag>     Release tag baked into the image (default: git describe)
#   --output <file>     Output path for the final .img.zst (default: work/zik-chromebook-<version>.img.zst)
#   --work-dir <dir>    Scratch directory (default: targets/chromebook/work)
#   --no-build          Skip building the app from source (requires pre-built artifacts)
#   --no-clean          Keep the work directory on success (useful for inspection)
#   --mirror <url>      Debian mirror for debootstrap (default: https://deb.debian.org/debian)
#   -h, --help          Show this help
#
# Requires: debootstrap, parted, mkfs.vfat, mkfs.ext4, mkfs.f2fs, grub-efi-amd64-bin,
#           mtools, zstd, python3, pnpm, cargo, meson, ninja, losetup (root for image ops).
#
# The script must be run as root (image formatting requires losetup + mount).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMMON_SCRIPTS="${REPO_ROOT}/common/scripts"
PARTITIONS_JSON="${SCRIPT_DIR}/partitions.json"
OVERRIDES_DIR="${SCRIPT_DIR}/overrides"

# ---- defaults ----------------------------------------------------------------

VERSION=""
OUTPUT=""
WORK_DIR="${SCRIPT_DIR}/work"
NO_BUILD=0
NO_CLEAN=0
MIRROR="https://deb.debian.org/debian"

# ---- helpers -----------------------------------------------------------------

die()     { echo "build-image: error: $*" >&2; exit 1; }
info()    { echo "==> $*"; }
section() { echo; echo "==== $* ===="; echo; }

cleanup() {
    # Unmount anything still mounted from our work directory.
    if [[ -n "${LOOP_DEV:-}" ]]; then
        info "detaching loop device ${LOOP_DEV}"
        for mp in "${MOUNT_ROOT}/boot/efi" "${MOUNT_ROOT}/proc" \
                  "${MOUNT_ROOT}/sys" "${MOUNT_ROOT}/dev/pts" \
                  "${MOUNT_ROOT}/dev" "${MOUNT_DATA}" "${MOUNT_ROOT}"; do
            if mountpoint -q "$mp" 2>/dev/null; then umount -l "$mp"; fi
        done
        losetup -d "${LOOP_DEV}" 2>/dev/null || true
        unset LOOP_DEV
    fi
}
trap cleanup EXIT INT TERM

require_root() {
    [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "this script must be run as root (image formatting requires losetup + mount)"
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1 (install build-deps first)"
}

# ---- argument parsing --------------------------------------------------------

while (($#)); do
    case "$1" in
        --version)  VERSION="$2";  shift 2 ;;
        --output)   OUTPUT="$2";   shift 2 ;;
        --work-dir) WORK_DIR="$2"; shift 2 ;;
        --mirror)   MIRROR="$2";   shift 2 ;;
        --no-build) NO_BUILD=1;    shift ;;
        --no-clean) NO_CLEAN=1;    shift ;;
        -h|--help)
            sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) die "unknown argument: $1 (see --help)" ;;
    esac
done

require_root

# Resolve version from git if not supplied.
if [[ -z "$VERSION" ]]; then
    VERSION="$(git -C "${REPO_ROOT}" describe --tags --always --dirty 2>/dev/null || echo "dev")"
fi
[[ -n "$OUTPUT" ]] || OUTPUT="${WORK_DIR}/zik-chromebook-${VERSION}.img.zst"

# ---- dependency check --------------------------------------------------------

for cmd in debootstrap parted mkfs.vfat mkfs.ext4 mkfs.f2fs \
           grub-install mtools zstd python3 losetup; do
    require_cmd "$cmd"
done

# ---- partition sizes (read from partitions.json) ----------------------------

# Parse the JSON with python (no jq dependency required on the build host).
read_part() {
    # read_part <role> <field>  → prints the value
    python3 - "${PARTITIONS_JSON}" "$1" "$2" << 'PYEOF'
import sys, json
data = json.load(open(sys.argv[1]))
role, field = sys.argv[2], sys.argv[3]
part = next(p for p in data["partitions"] if p["role"] == role)
print(part[field])
PYEOF
}

ESP_MIB="$(read_part esp size_mib)"
ROOT_MIB="$(read_part root size_mib)"
MAINT_MIB="$(read_part maintenance size_mib)"
SWAP_MIB="$(read_part swap size_mib)"
# data: size_mib=0 → fill remaining space (handled by parted mkpart).

TOTAL_FIXED_MIB=$(( ESP_MIB + ROOT_MIB + MAINT_MIB + SWAP_MIB ))
# Add 64 MiB overhead for GPT headers and alignment slack.
IMAGE_MIB=$(( TOTAL_FIXED_MIB + 64 ))
# Data partition fills remaining space; the final image size is set large
# enough to be useful on a real disk but compact for QEMU testing.
# For a real Chromebook install we flash the raw image; the installer or
# configure-image.sh can resize the data partition to fill the actual disk.
DATA_MIB=2048
IMAGE_MIB=$(( IMAGE_MIB + DATA_MIB ))

# ---- work directory ----------------------------------------------------------

CHROOT="${WORK_DIR}/chroot"
MOUNT_ROOT="${WORK_DIR}/mnt/root"
MOUNT_DATA="${WORK_DIR}/mnt/data"
IMAGE_RAW="${WORK_DIR}/zik-chromebook-${VERSION}.img"

mkdir -p "${WORK_DIR}" "${MOUNT_ROOT}" "${MOUNT_DATA}"

# ---- step 1: build the app ---------------------------------------------------

if (( ! NO_BUILD )); then
    section "Building application"

    info "building backend wheel"
    (cd "${REPO_ROOT}/common/backend" && poetry build --format wheel -q)

    info "building frontend"
    (cd "${REPO_ROOT}/common/frontend" && pnpm build --silent)

    info "building privhelp (release)"
    (cd "${REPO_ROOT}" && cargo build --release \
        --manifest-path common/privhelp/Cargo.toml \
        --quiet)

    info "building PAM admin-lock module"
    PAM_BUILD_DIR="${WORK_DIR}/pam-build"
    meson setup "${PAM_BUILD_DIR}" \
        "${REPO_ROOT}/common/pam_adminlock" \
        --buildtype=release -q
    ninja -C "${PAM_BUILD_DIR}" -j"$(nproc)" 2>/dev/null
else
    info "skipping build (--no-build)"
fi

PRIVHELP_BIN="${REPO_ROOT}/target/release/zik-privhelp"
PAM_SO="${WORK_DIR}/pam-build/src/pam_zik_adminlock.so"

[[ -f "${PRIVHELP_BIN}" ]] || \
    die "privhelp binary not found: ${PRIVHELP_BIN} — run without --no-build or build manually"

# ---- step 2: debootstrap -----------------------------------------------------

section "Bootstrapping Debian trixie"

if [[ -d "${CHROOT}/usr" ]]; then
    info "chroot already exists — skipping debootstrap (delete ${CHROOT} to force rebuild)"
else
    info "running debootstrap (this takes a few minutes)"
    debootstrap \
        --arch=amd64 \
        --variant=minbase \
        --include=ca-certificates,locales,systemd,systemd-sysv,dbus \
        trixie \
        "${CHROOT}" \
        "${MIRROR}"
fi

# ---- step 3: APT configuration -----------------------------------------------

section "Configuring APT"

install -m 0644 "${OVERRIDES_DIR}/apt/sources.list" \
    "${CHROOT}/etc/apt/sources.list"
install -d -m 0755 "${CHROOT}/etc/apt/preferences.d"
install -m 0644 "${OVERRIDES_DIR}/apt/10-zik.pref" \
    "${CHROOT}/etc/apt/preferences.d/10-zik.pref"

# ---- chroot helper -----------------------------------------------------------

run_chroot() {
    # Run a command inside the chroot with proc/sys/dev mounted.
    chroot "${CHROOT}" env \
        DEBIAN_FRONTEND=noninteractive \
        PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        "$@"
}

mount_chroot_fs() {
    mountpoint -q "${CHROOT}/proc" || mount -t proc  proc  "${CHROOT}/proc"
    mountpoint -q "${CHROOT}/sys"  || mount -t sysfs sysfs "${CHROOT}/sys"
    mountpoint -q "${CHROOT}/dev"  || mount --bind /dev    "${CHROOT}/dev"
    mountpoint -q "${CHROOT}/dev/pts" || mount --bind /dev/pts "${CHROOT}/dev/pts"
}

umount_chroot_fs() {
    for mp in "${CHROOT}/dev/pts" "${CHROOT}/dev" "${CHROOT}/sys" "${CHROOT}/proc"; do
        if mountpoint -q "$mp"; then umount -l "$mp"; fi
    done
}

mount_chroot_fs

# ---- step 4: install packages ------------------------------------------------

section "Installing packages"

run_chroot apt-get update -qq
run_chroot apt-get install -y --no-install-recommends \
    linux-image-amd64 \
    grub-efi-amd64 \
    grub-efi-amd64-bin \
    efibootmgr \
    systemd-boot-efi \
    greetd \
    cage \
    chromium \
    chromium-sandbox \
    pipewire \
    pipewire-pulse \
    wireplumber \
    bluez \
    networkmanager \
    network-manager-gnome \
    systemd-timesyncd \
    alsa-ucm-conf \
    sof-firmware \
    linux-firmware \
    firmware-iwlwifi \
    libpam-modules \
    libpam-runtime \
    python3 \
    python3-dbus \
    python3-gi \
    python3-venv \
    python3-pip \
    git \
    e2fsprogs \
    f2fs-tools \
    dosfstools \
    powertop \
    curl \
    gnupg \
    openssh-server \
    sudo \
    less \
    zsh \
    zsh-antidote \
    vim-tiny \
    iproute2 \
    iputils-ping \
    dnsutils \
    acpid \
    udev

# ---- step 5: system configuration --------------------------------------------

section "Configuring system"

# Hostname
echo "zik" > "${CHROOT}/etc/hostname"
cat > "${CHROOT}/etc/hosts" << 'EOF'
127.0.0.1   localhost
127.0.1.1   zik
::1         localhost ip6-localhost ip6-loopback
EOF

# Locale: en_GB.UTF-8 default; fr_FR.UTF-8 also generated (i18n requirement).
sed -i 's/# \(en_GB.UTF-8\)/\1/' "${CHROOT}/etc/locale.gen"
sed -i 's/# \(fr_FR.UTF-8\)/\1/' "${CHROOT}/etc/locale.gen"
run_chroot locale-gen
echo 'LANG=en_GB.UTF-8' > "${CHROOT}/etc/locale.conf"

# Timezone (placeholder; configure-image.sh overrides from config.yaml).
ln -sf "/usr/share/zoneinfo/UTC" "${CHROOT}/etc/localtime"
echo "UTC" > "${CHROOT}/etc/timezone"

# ---- step 6: create system users --------------------------------------------

section "Creating users"

# zik-kiosk: the unprivileged user that greetd auto-logs in to run cage+Chromium.
run_chroot useradd \
    --system \
    --shell /usr/sbin/nologin \
    --home-dir /nonexistent \
    --no-create-home \
    --comment "zik kiosk session" \
    zik-kiosk || true

# zik: service account for the backend process.
run_chroot useradd \
    --system \
    --shell /usr/sbin/nologin \
    --home-dir /var/lib/zik \
    --no-create-home \
    --groups audio,video,bluetooth \
    --comment "zik backend" \
    zik || true

# The admin user is created by configure-image.sh (or first-boot wizard).

# Allow zik-kiosk to run cage on the virtual terminal without extra privileges.
run_chroot usermod -aG video,audio,input zik-kiosk || true

# ---- step 7: install the app -------------------------------------------------

section "Installing application"

INSTALL_ARGS=(
    --root         "${CHROOT}"
    --src          "${REPO_ROOT}"
    --version      "${VERSION}"
    --privhelp-bin "${PRIVHELP_BIN}"
)
[[ -f "${PAM_SO}" ]] && INSTALL_ARGS+=(--pam-so "${PAM_SO}")
"${COMMON_SCRIPTS}/install-app.sh" "${INSTALL_ARGS[@]}"

# setuid root on privhelp (must run as root inside the chroot environment).
PRIVHELP_DEST="${CHROOT}/usr/libexec/zik/zik-privhelp"
if [[ -f "${PRIVHELP_DEST}" ]]; then
    chown root:root "${PRIVHELP_DEST}"
    chmod u+s,0755  "${PRIVHELP_DEST}"
    info "setuid applied to zik-privhelp"
fi

# ---- step 8: WirePlumber arbiter policy -------------------------------------
#
# Install the zik-arbiter Lua script and its WirePlumber conf drop-in so the
# system audio arbiter enforces single-active-user routing at the PipeWire
# level.  The backend signals the active user via pw-metadata; the Lua policy
# reacts and mutes streams from non-active users.

section "Installing WirePlumber arbiter policy"

AUDIO_SRC="${REPO_ROOT}/common/audio"
WP_SCRIPTS_DEST="${CHROOT}/usr/share/wireplumber/scripts/zik"
WP_CONF_DEST="${CHROOT}/etc/wireplumber/wireplumber.conf.d"

install -d -m 0755 "${WP_SCRIPTS_DEST}"
install -m 0644 "${AUDIO_SRC}/zik-arbiter.lua" "${WP_SCRIPTS_DEST}/zik-arbiter.lua"

install -d -m 0755 "${WP_CONF_DEST}"
install -m 0644 "${AUDIO_SRC}/wireplumber.conf.d/50-zik-arbiter.conf" \
    "${WP_CONF_DEST}/50-zik-arbiter.conf"

info "WirePlumber arbiter policy installed"

# ---- step 9: maintainer GPG keys --------------------------------------------
#
# Import all keys from .maintainers/keys/ into a dedicated keyring used by the
# OTA updater to verify release artifact signatures.  If no keys are present
# yet (bootstrapping), the keyring is created empty and GPG verification is
# effectively skipped at update time.

section "Importing maintainer GPG keys"

KEYS_DIR="${REPO_ROOT}/.maintainers/keys"
ZIK_KEYS_DIR="${CHROOT}/usr/share/zik"
ZIK_KEYRING="${ZIK_KEYS_DIR}/trustedkeys.gpg"

install -d -m 0755 "${ZIK_KEYS_DIR}"

shopt -s nullglob
KEY_COUNT=0
for key_file in "${KEYS_DIR}"/*.asc; do
    gpg --batch --no-default-keyring \
        --keyring "${ZIK_KEYRING}" \
        --import "${key_file}" 2>/dev/null || true
    KEY_COUNT=$(( KEY_COUNT + 1 ))
done
shopt -u nullglob

info "imported ${KEY_COUNT} maintainer key file(s) into ${ZIK_KEYRING}"

# ---- step 10: greetd + kiosk config ------------------------------------------

section "Configuring greetd"

install -d -m 0755 "${CHROOT}/etc/greetd"
install -m 0644 "${OVERRIDES_DIR}/greetd/config.toml" \
    "${CHROOT}/etc/greetd/config.toml"

run_chroot systemctl enable greetd

# ---- step 11: kernel cmdline + GRUB defaults ---------------------------------

section "Configuring GRUB"

# Build GRUB_CMDLINE_LINUX_DEFAULT from the overrides file.
CMDLINE=""
while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]]           && continue
    CMDLINE="${CMDLINE} ${line}"
done < "${OVERRIDES_DIR}/kernel-cmdline"
CMDLINE="${CMDLINE# }"  # strip leading space

cat > "${CHROOT}/etc/default/grub" << GRUB_EOF
GRUB_DEFAULT=0
GRUB_TIMEOUT=0
GRUB_DISTRIBUTOR="zik"
GRUB_CMDLINE_LINUX_DEFAULT="${CMDLINE}"
GRUB_CMDLINE_LINUX=""
GRUB_TERMINAL=console
GRUB_DISABLE_RECOVERY=true
GRUB_EOF

# ---- step 11b: GRUB password gate + maintenance entry -----------------------
#
# The maintenance GRUB entry lets the admin boot into a minimal recovery
# environment (systemd.unit=zik-maintenance.target) for fsck, reinstall, and
# password reset (C.32).
#
# The entry is protected by the GRUB superuser password so only someone who
# knows the admin password (set by configure-image.sh) can select it.
# Normal boot (timeout=0, auto-select entry 0) never prompts for a password.
#
# The password hash (@GRUB_PW_HASH@) is a placeholder; configure-image.sh
# replaces it with a real grub-mkpasswd-pbkdf2 hash derived from admin_password.

section "GRUB password gate + maintenance entry"

# 01_zik_password: sets superusers + PBKDF2 hash (placeholder filled by configure-image.sh).
cat > "${CHROOT}/etc/grub.d/01_zik_password" << 'GRUBPW_EOF'
#!/bin/sh
exec tail -n +4 "$0"
set superusers="admin"
password_pbkdf2 admin @GRUB_PW_HASH@
GRUBPW_EOF
chmod +x "${CHROOT}/etc/grub.d/01_zik_password"

# 41_zik_maintenance: password-gated maintenance menuentry.
# The kernel path uses the same vmlinuz/initrd as the primary entry; the only
# difference is the systemd.unit= parameter on the command line.
KERNEL_VER="$(find "${CHROOT}/boot" -maxdepth 1 -name 'vmlinuz-*' 2>/dev/null | \
              sort -V | tail -1 | xargs -r basename | sed 's/vmlinuz-//')"
if [[ -z "${KERNEL_VER}" ]]; then
    die "could not determine kernel version for maintenance GRUB entry"
fi

cat > "${CHROOT}/etc/grub.d/41_zik_maintenance" << GRUBMAINT_EOF
#!/bin/sh
exec tail -n +4 "\$0"
menuentry "Zik -- Maintenance" {
    search --no-floppy --label --set=root zik-root
    linux  /boot/vmlinuz-${KERNEL_VER} root=LABEL=zik-root ro quiet ${CMDLINE} systemd.unit=zik-maintenance.target
    initrd /boot/initrd.img-${KERNEL_VER}
}
GRUBMAINT_EOF
chmod +x "${CHROOT}/etc/grub.d/41_zik_maintenance"

info "GRUB maintenance entry written for kernel ${KERNEL_VER}"
info "NOTE: run configure-image.sh with admin_password to set the GRUB password hash"

# ---- step 12: enable systemd units ------------------------------------------

section "Enabling systemd units"

run_chroot systemctl enable \
    zik-backend.service \
    NetworkManager.service \
    systemd-timesyncd.service \
    bluetooth.service \
    pipewire.socket \
    pipewire-pulse.socket

# Maintenance units: not enabled by default (only active when booted via
# systemd.unit=zik-maintenance.target), but must be installed so systemd can find them.
cp "${REPO_ROOT}/common/systemd/zik-maintenance.target"          "${CHROOT}/lib/systemd/system/"
cp "${REPO_ROOT}/common/systemd/zik-maintenance-backend.service" "${CHROOT}/lib/systemd/system/"
cp "${REPO_ROOT}/common/systemd/zik-maintenance-kiosk.service"   "${CHROOT}/lib/systemd/system/"
info "maintenance mode units installed (not enabled in normal boot)"

# ---- step 13: first-boot gate ------------------------------------------------

# Absence of this file triggers the first-boot wizard (§6.3).
# configure-image.sh writes it if an admin password is supplied in config.yaml.
info "first-boot gate absent — wizard will run on first boot"
rm -f "${CHROOT}/var/lib/zik/first-boot-done"

# ---- step 14: SSH hardening (placeholder for P6.3) --------------------------

# Enable SSHD but lock it down: key-only, no root login.
# The admin's SSH public key is injected by configure-image.sh (P6.3).
cat > "${CHROOT}/etc/ssh/sshd_config.d/10-zik.conf" << 'SSHEOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
X11Forwarding no
PrintMotd no
AcceptEnv LANG LC_*
SSHEOF
run_chroot systemctl enable ssh

# ---- step 14b: suspend-then-hibernate + powertop setup -----------------------

section "Configuring suspend-then-hibernate"

# systemd sleep config: auto-hibernate after 2h in suspend state.
mkdir -p "${CHROOT}/etc/systemd/sleep.conf.d"
cat > "${CHROOT}/etc/systemd/sleep.conf.d/zik.conf" << 'SLEEP_EOF'
[Sleep]
HibernateDelaySec=2h
SLEEP_EOF

# Tell initramfs-tools which device to resume from; label is resolved by udev.
mkdir -p "${CHROOT}/etc/initramfs-tools/conf.d"
cat > "${CHROOT}/etc/initramfs-tools/conf.d/resume" << 'RESUME_EOF'
RESUME=LABEL=ZIK-SWAP
RESUME_EOF

# Rebuild initramfs with the resume hook included.
run_chroot update-initramfs -u
info "initramfs rebuilt with RESUME=LABEL=ZIK-SWAP"

# powertop unit: apply --auto-tune once at boot for S0ix power savings.
cp "${REPO_ROOT}/common/systemd/zik-powertop.service" "${CHROOT}/lib/systemd/system/"
run_chroot systemctl enable zik-powertop.service

umount_chroot_fs

# ---- step 15: create raw disk image -----------------------------------------

section "Creating disk image"

IMAGE_SIZE_BYTES=$(( IMAGE_MIB * 1024 * 1024 ))
info "allocating ${IMAGE_MIB} MiB raw image at ${IMAGE_RAW}"
truncate -s "${IMAGE_SIZE_BYTES}" "${IMAGE_RAW}"

# Partition with parted (MiB-aligned).
info "partitioning"
parted -s "${IMAGE_RAW}" \
    mklabel gpt \
    mkpart ZIK-EFI   fat32      1MiB \
                                $(( 1 + ESP_MIB ))MiB \
    mkpart ZIK-ROOT  ext4       $(( 1 + ESP_MIB ))MiB \
                                $(( 1 + ESP_MIB + ROOT_MIB ))MiB \
    mkpart ZIK-MAINT ext4       $(( 1 + ESP_MIB + ROOT_MIB ))MiB \
                                $(( 1 + ESP_MIB + ROOT_MIB + MAINT_MIB ))MiB \
    mkpart ZIK-SWAP  linux-swap $(( 1 + ESP_MIB + ROOT_MIB + MAINT_MIB ))MiB \
                                $(( 1 + ESP_MIB + ROOT_MIB + MAINT_MIB + SWAP_MIB ))MiB \
    mkpart ZIK-DATA  "$(read_part data fs)" \
                                $(( 1 + ESP_MIB + ROOT_MIB + MAINT_MIB + SWAP_MIB ))MiB  100% \
    set 1 esp on \
    set 1 boot on

# Attach loop device.
LOOP_DEV="$(losetup --find --show --partscan "${IMAGE_RAW}")"
info "loop device: ${LOOP_DEV}"

# Wait for kernel to create partition devices.
udevadm settle || partprobe "${LOOP_DEV}" || true
sleep 1

P_ESP="${LOOP_DEV}p1"
P_ROOT="${LOOP_DEV}p2"
P_MAINT="${LOOP_DEV}p3"
P_SWAP="${LOOP_DEV}p4"
P_DATA="${LOOP_DEV}p5"

# ---- step 16: format partitions ----------------------------------------------

info "formatting ESP (vfat)"
mkfs.vfat -F 32 -n ZIK-EFI "${P_ESP}"

info "formatting root (ext4)"
mkfs.ext4 -q -L ZIK-ROOT -F "${P_ROOT}"

info "formatting maintenance (ext4)"
mkfs.ext4 -q -L ZIK-MAINT -F "${P_MAINT}"

info "formatting swap"
mkswap -L ZIK-SWAP "${P_SWAP}"

info "formatting data (f2fs)"
mkfs.f2fs -q -l ZIK-DATA -f "${P_DATA}"

# ---- step 17: populate root partition ----------------------------------------

section "Populating root partition"

mount "${P_ROOT}" "${MOUNT_ROOT}"
mount -t proc  proc  "${MOUNT_ROOT}/proc"
mount -t sysfs sysfs "${MOUNT_ROOT}/sys"
mount --bind /dev    "${MOUNT_ROOT}/dev"
mount --bind /dev/pts "${MOUNT_ROOT}/dev/pts"

mkdir -p "${MOUNT_ROOT}/boot/efi"
mount "${P_ESP}" "${MOUNT_ROOT}/boot/efi"

info "copying chroot to root partition (this may take a moment)"
rsync -aHAX --exclude=/proc --exclude=/sys --exclude=/dev --exclude=/tmp \
    "${CHROOT}/" "${MOUNT_ROOT}/"

# Write fstab.
ROOT_UUID="$(blkid -s UUID -o value "${P_ROOT}")"
ESP_UUID="$(blkid  -s UUID -o value "${P_ESP}")"
SWAP_UUID="$(blkid -s UUID -o value "${P_SWAP}")"
DATA_UUID="$(blkid -s UUID -o value "${P_DATA}")"

cat > "${MOUNT_ROOT}/etc/fstab" << FSTAB_EOF
# <file system>                         <mount>         <type>  <options>               <dump> <pass>
UUID=${ROOT_UUID}  /               ext4    ro,relatime             0 1
UUID=${ESP_UUID}   /boot/efi       vfat    umask=0077              0 2
UUID=${SWAP_UUID}  none            swap    sw                      0 0
UUID=${DATA_UUID}  /var/lib/zik    f2fs    lazytime,discard        0 2
tmpfs                                   /tmp            tmpfs   defaults,size=256M      0 0
tmpfs                                   /var/log/zik    tmpfs   defaults,size=64M       0 0
FSTAB_EOF

# ---- step 18: install GRUB EFI -----------------------------------------------

section "Installing GRUB"

grub-install \
    --target=x86_64-efi \
    --efi-directory="${MOUNT_ROOT}/boot/efi" \
    --boot-directory="${MOUNT_ROOT}/boot" \
    --removable \
    --recheck \
    "${LOOP_DEV}"

chroot "${MOUNT_ROOT}" update-grub 2>/dev/null || \
    chroot "${MOUNT_ROOT}" grub-mkconfig -o /boot/grub/grub.cfg

# ---- step 19: release sanity checks -----------------------------------------

section "Release sanity checks"

# Fail the build if any SSH authorized_keys made it into the image.
# Per-deployment SSH keys belong in config.yaml → configure-image.sh, not here.
LEAKED_KEYS="$(find "${CHROOT}/root" "${CHROOT}/home" \
    -name "authorized_keys" -type f 2>/dev/null || true)"
if [[ -n "${LEAKED_KEYS}" ]]; then
    die "SSH authorized_keys found in image chroot — remove before releasing:
${LEAKED_KEYS}"
fi
info "no SSH authorized_keys in image — OK"

# ---- step 20: unmount --------------------------------------------------------

umount "${MOUNT_ROOT}/boot/efi"
umount "${MOUNT_ROOT}/dev/pts"
umount "${MOUNT_ROOT}/dev"
umount "${MOUNT_ROOT}/sys"
umount "${MOUNT_ROOT}/proc"
umount "${MOUNT_ROOT}"
losetup -d "${LOOP_DEV}"
unset LOOP_DEV

# ---- step 21: compress -------------------------------------------------------

section "Compressing image"

info "compressing to ${OUTPUT}"
zstd --rm -q -T0 -o "${OUTPUT}" "${IMAGE_RAW}"

info "image written: ${OUTPUT}"
info "  size: $(du -sh "${OUTPUT}" | cut -f1)"

if (( ! NO_CLEAN )); then
    info "cleaning up work directory (pass --no-clean to keep)"
    rm -rf "${CHROOT}" "${MOUNT_ROOT}" "${MOUNT_DATA}"
fi

echo
echo "Build complete: ${OUTPUT}"
echo "Flash with:  zstd -d ${OUTPUT} --stdout | dd of=/dev/sdX bs=4M status=progress conv=fsync"
echo "QEMU test:   zstd -d ${OUTPUT} && qemu-system-x86_64 -m 2G -enable-kvm \\"
echo "               -drive file=${IMAGE_RAW},format=raw \\"
echo "               -bios /usr/share/ovmf/OVMF.fd"
