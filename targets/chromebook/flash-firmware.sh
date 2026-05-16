#!/usr/bin/env bash
# targets/chromebook/flash-firmware.sh — download, verify, and flash MrChromebox
# coreboot/UEFI firmware for supported Chromebook models.
#
# Run this from the ChromeOS Developer Mode root shell AFTER disabling the
# firmware write-protection screw (see README.md §1.5).
#
# Usage:
#   sudo bash flash-firmware.sh [--dry-run]
#
# Options:
#   --dry-run   Download and verify but do not actually flash.
#
# What it does:
#   1. Identifies and validates the board name.
#   2. Saves a backup of the current firmware to /tmp/firmware-backup.bin.
#   3. Downloads the pinned MrChromebox Full ROM for this board.
#   4. Verifies SHA256 against firmware/SHA256SUMS (this file's directory).
#   5. Flashes the ROM with flashrom.
#
# This script is an auditable, pinned alternative to piping firmware-util.sh
# from the internet (C.21).  The pinned hash lives in firmware/SHA256SUMS
# in the Zik repository; update it when upgrading the firmware version.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUMS_FILE="${SCRIPT_DIR}/firmware/SHA256SUMS"
FIRMWARE_BASE_URL="https://mrchromebox.tech/files/firmware/full_rom"

# ---- supported boards --------------------------------------------------------
# Maps ChromeOS board name → ROM filename stem.
declare -A SUPPORTED_BOARDS=(
    [kasumi360]="coreboot_tiano-kasumi360-mrchromebox"
)

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

die()  { echo "flash-firmware: error: $*" >&2; exit 1; }
info() { echo "==> $*"; }
warn() { echo "flash-firmware: warning: $*" >&2; }

# ---- sanity checks -----------------------------------------------------------

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "must be run as root (sudo bash flash-firmware.sh)"
command -v flashrom >/dev/null 2>&1 || die "flashrom not found; install it first: apt-get install flashrom"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum not found"

# ---- identify board ----------------------------------------------------------

BOARD=""
if command -v crossystem >/dev/null 2>&1; then
    BOARD="$(crossystem board_name 2>/dev/null || true)"
fi
if [[ -z "${BOARD}" ]] && [[ -f /etc/lsb-release ]]; then
    BOARD="$(grep -i '^CHROMEOS_RELEASE_BOARD=' /etc/lsb-release | cut -d= -f2 | tr -d '"' || true)"
fi
[[ -n "${BOARD}" ]] || die "could not determine board name; are you running on a Chromebook?"

info "detected board: ${BOARD}"

[[ -v SUPPORTED_BOARDS["${BOARD}"] ]] || \
    die "board '${BOARD}' is not supported by this script. Supported: ${!SUPPORTED_BOARDS[*]}"

ROM_STEM="${SUPPORTED_BOARDS[${BOARD}]}"

# ---- read pinned hash from SHA256SUMS ----------------------------------------

[[ -f "${SUMS_FILE}" ]] || die "firmware/SHA256SUMS not found at ${SUMS_FILE}"

# Find the line for this board's ROM stem; skip comment lines.
PIN_LINE="$(grep -v '^#' "${SUMS_FILE}" | grep "${ROM_STEM}" | head -1 || true)"
[[ -n "${PIN_LINE}" ]] || die "no entry for '${ROM_STEM}' in firmware/SHA256SUMS"

# Check for unfilled placeholder.
echo "${PIN_LINE}" | grep -q '@FILL_BEFORE_RELEASE@' && \
    die "firmware/SHA256SUMS still contains a placeholder hash — update it before flashing"

PINNED_HASH="$(echo "${PIN_LINE}" | awk '{print $1}')"
ROM_FILENAME="$(echo "${PIN_LINE}" | awk '{print $2}')"
ROM_URL="${FIRMWARE_BASE_URL}/${ROM_FILENAME}"

info "pinned firmware: ${ROM_FILENAME}"
info "expected SHA256: ${PINNED_HASH}"

# ---- back up existing firmware -----------------------------------------------

BACKUP="/tmp/firmware-backup-${BOARD}-$(date +%Y%m%d_%H%M%S).bin"
info "saving firmware backup to ${BACKUP}"
flashrom --programmer internal -r "${BACKUP}" 2>&1 | sed 's/^/    /'
info "backup saved — keep this file safe in case you need to restore"

# ---- download ROM ------------------------------------------------------------

TMP_ROM="$(mktemp /tmp/zik-firmware.XXXXXX.rom)"
trap 'rm -f "${TMP_ROM}"' EXIT

info "downloading ${ROM_URL}"
curl --fail --location --progress-bar -o "${TMP_ROM}" "${ROM_URL}" || \
    die "download failed; check your internet connection and the URL in SHA256SUMS"

# ---- verify SHA256 -----------------------------------------------------------

info "verifying SHA256"
ACTUAL_HASH="$(sha256sum "${TMP_ROM}" | awk '{print $1}')"

if [[ "${ACTUAL_HASH}" != "${PINNED_HASH}" ]]; then
    die "SHA256 MISMATCH — firmware will NOT be flashed.
  expected: ${PINNED_HASH}
  got:      ${ACTUAL_HASH}
  The downloaded file differs from the version pinned in firmware/SHA256SUMS.
  Do NOT proceed manually; verify that firmware/SHA256SUMS is up to date
  and that the MrChromebox server has not been compromised."
fi

info "SHA256 verified OK"

# ---- flash -------------------------------------------------------------------

if (( DRY_RUN )); then
    info "DRY RUN — skipping flash. ROM downloaded and verified successfully."
    exit 0
fi

echo
echo "  About to flash ${ROM_FILENAME} to the internal SPI ROM."
echo "  DO NOT power off or unplug during the flash (takes ~30 s)."
echo
read -r -p "  Type YES to continue: " CONFIRM
[[ "${CONFIRM}" == "YES" ]] || { info "aborted by user"; exit 0; }

info "flashing (do not interrupt)"
flashrom --programmer internal -w "${TMP_ROM}" 2>&1 | sed 's/^/    /'

info "flash complete. Reboot now: sudo reboot"
