#!/usr/bin/env bash
# install-build-deps.sh — install build dependencies declared in per-target manifests.
#
# Usage:
#   ./install-build-deps.sh [--yes] [--uninstall] <target> [<target> ...]
#
# Without --yes, prints what would be done (dry run).
# Each <target> must be a directory under ./targets/ with a `build-deps` file.
# The file has section headers:
#   # apt:      — system packages (Debian/Ubuntu: installed via sudo apt-get; other distros: listed as a manual-install hint)
#   # pipx:     — Python tools installed via pipx (e.g. poetry); requires python3-pipx in apt:
#   # pip:      — reserved; packages for pip install --user inside a pre-existing venv
#   # npm:      — global JS packages installed via pnpm add -g (pnpm itself is bootstrapped automatically)
#   # cargo:    — crates for cargo install
#   # rustup:   — rustup subcommands (one per line, e.g. "toolchain install stable")
# Lines beginning with '#' (other than section headers) and blank lines are ignored.
# A leading '!' on a line marks it optional/skipped (manual review required).
#
# State is written to ./.state-install-build-deps.json so --uninstall can reverse.

set -euo pipefail

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    echo "error: do not run this script as root or with sudo." >&2
    echo "       System packages are installed via sudo internally." >&2
    echo "       All other sections install into your user account." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="${SCRIPT_DIR}/.state-install-build-deps.json"

YES=0
UNINSTALL=0
TARGETS=()

die()  { echo "error: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }
info() { echo "[install-build-deps] $*"; }

detect_pm() {
    if   command -v apt-get >/dev/null 2>&1; then echo "apt"
    elif command -v dnf     >/dev/null 2>&1; then echo "dnf"
    elif command -v pacman  >/dev/null 2>&1; then echo "pacman"
    elif command -v zypper  >/dev/null 2>&1; then echo "zypper"
    elif command -v brew    >/dev/null 2>&1; then echo "brew"
    else                                          echo "unknown"
    fi
}

usage() {
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

while (($#)); do
    case "$1" in
        --yes) YES=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        -h|--help) usage 0 ;;
        --) shift; break ;;
        -*) die "unknown flag: $1" ;;
        *) TARGETS+=("$1"); shift ;;
    esac
done

((${#TARGETS[@]})) || die "no target specified (see --help)"

PM="$(detect_pm)"

declare -A APT=() PIPX=() PIP=() NPM=() CARGO=()
RUSTUP_CMDS=()

parse_manifest() {
    local target="$1"
    local file="${SCRIPT_DIR}/targets/${target}/build-deps"
    [[ -f "$file" ]] || die "manifest not found: $file"

    local section=""
    while IFS= read -r line || [[ -n "$line" ]]; do
        # Strip CR (in case of CRLF).
        line="${line%$'\r'}"
        # Section header: "# apt:" etc.
        if [[ "$line" =~ ^#[[:space:]]*(apt|pipx|pip|npm|cargo|rustup):[[:space:]]*$ ]]; then
            section="${BASH_REMATCH[1]}"
            continue
        fi
        # Skip blank lines.
        [[ -z "${line// }" ]] && continue
        # Skip comments (lines starting with # but not section headers).
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        # Skip optional items marked with leading '!'.
        [[ "$line" =~ ^[[:space:]]*! ]] && continue

        # Trim whitespace.
        line="${line#"${line%%[![:space:]]*}"}"
        line="${line%"${line##*[![:space:]]}"}"

        case "$section" in
            apt)   APT["$line"]=1 ;;
            pipx)  PIPX["$line"]=1 ;;
            pip)   PIP["$line"]=1 ;;
            npm)   NPM["$line"]=1 ;;
            cargo) CARGO["$line"]=1 ;;
            rustup) RUSTUP_CMDS+=("$line") ;;
            "") die "item outside any section in $file: $line" ;;
            *) die "unknown section '$section' in $file" ;;
        esac
    done < "$file"
}

for t in "${TARGETS[@]}"; do
    info "parsing manifest for target: $t"
    parse_manifest "$t"
done

if ((UNINSTALL)); then
    info "uninstall not yet implemented — planned for M0.2"
    info "TODO(M0.2): read $STATE_FILE, reverse pipx/cargo/pnpm/rustup installs (apt left aside)"
    exit 0
fi

print_plan() {
    echo "==== plan ===="
    if ((${#APT[@]})); then
        if [[ "$PM" == "apt" ]]; then
            echo "system packages (apt-get): ${!APT[*]}"
        else
            echo "system packages (MANUAL — $PM detected; package names are Debian-style): ${!APT[*]}"
        fi
    fi
    if ((${#PIPX[@]})); then
        echo "pipx tools: ${!PIPX[*]}"
    fi
    if ((${#PIP[@]})); then
        echo "pip packages (user, inside venv): ${!PIP[*]}"
    fi
    if ((${#NPM[@]})); then
        echo "npm/pnpm globals: ${!NPM[*]}"
    fi
    if ((${#CARGO[@]})); then
        echo "cargo installs: ${!CARGO[*]}"
    fi
    if ((${#RUSTUP_CMDS[@]})); then
        echo "rustup commands:"
        for c in "${RUSTUP_CMDS[@]}"; do echo "    rustup $c"; done
    fi
    echo "=============="
}

print_plan

if ! ((YES)); then
    info "dry-run (pass --yes to actually install)"
    exit 0
fi

# Record state before we start (best-effort; failures below leave state ahead of reality).
{
    echo "{"
    echo "  \"generated_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
    echo "  \"targets\": [$(printf '"%s",' "${TARGETS[@]}" | sed 's/,$//')] ,"
    echo "  \"apt\": [$(printf '"%s",' "${!APT[@]}" | sed 's/,$//')] ,"
    echo "  \"pipx\": [$(printf '"%s",' "${!PIPX[@]}" | sed 's/,$//')] ,"
    echo "  \"pip\": [$(printf '"%s",' "${!PIP[@]}" | sed 's/,$//')] ,"
    echo "  \"npm\": [$(printf '"%s",' "${!NPM[@]}" | sed 's/,$//')] ,"
    echo "  \"cargo\": [$(printf '"%s",' "${!CARGO[@]}" | sed 's/,$//')]"
    echo "}"
} > "$STATE_FILE"

if ((${#APT[@]})); then
    case "$PM" in
        apt)
            info "installing system packages (sudo apt-get)"
            sudo apt-get update
            sudo apt-get install -y "${!APT[@]}"
            ;;
        dnf|pacman|zypper|brew)
            warn "apt: section skipped — $PM detected; package names are Debian-style, translate as needed:"
            printf '    %s\n' "${!APT[@]}" >&2
            ;;
        *)
            warn "apt: section skipped — no recognised package manager; install these packages manually:"
            printf '    %s\n' "${!APT[@]}" >&2
            ;;
    esac
fi

if ((${#PIPX[@]})); then
    if ! command -v pipx >/dev/null 2>&1; then
        die "pipx not found; add 'pipx' to the apt: section of your build-deps manifest and re-run"
    fi
    info "pipx install"
    for pkg in "${!PIPX[@]}"; do
        pipx install "$pkg"
    done
fi

if ((${#PIP[@]})); then
    if [[ -z "${VIRTUAL_ENV:-}" ]]; then
        die "pip: section requires an active virtual environment; activate one first or use pipx: for tools"
    fi
    info "pip install (inside venv: $VIRTUAL_ENV)"
    pip install "${!PIP[@]}"
fi

if ((${#RUSTUP_CMDS[@]})); then
    if ! command -v rustup >/dev/null 2>&1; then
        info "rustup not found; installing via rustup.rs bootstrap"
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none
        # shellcheck source=/dev/null
        source "$HOME/.cargo/env"
    fi
    for cmd in "${RUSTUP_CMDS[@]}"; do
        info "rustup $cmd"
        # shellcheck disable=SC2086
        rustup $cmd
    done
fi

if ((${#CARGO[@]})); then
    info "cargo install"
    for crate in "${!CARGO[@]}"; do
        cargo install "$crate"
    done
fi

if ((${#NPM[@]})); then
    if ! command -v pnpm >/dev/null 2>&1; then
        info "pnpm not found; installing via standalone installer"
        curl -fsSL https://get.pnpm.io/install.sh | sh -
        export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
        export PATH="$PNPM_HOME:$PATH"
    fi
    info "pnpm add -g"
    pnpm add -g "${!NPM[@]}"
fi

info "done. state written to $STATE_FILE"
