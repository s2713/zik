#!/usr/bin/env bash
# install-build-deps.sh — install build dependencies declared in per-target manifests.
#
# Usage:
#   ./install-build-deps.sh [--yes] [--uninstall] <target> [<target> ...]
#
# Without --yes, prints what would be done (dry run).
# Each <target> must be a directory under ./targets/ with a `build-deps` file.
# The file has section headers:
#   # apt:      — packages for apt-get install
#   # pip:      — packages for pip install --user
#   # npm:      — packages for pnpm add -g / npm install -g
#   # cargo:    — crates for cargo install
#   # rustup:   — rustup subcommands (one per line, e.g. "toolchain install stable")
# Lines beginning with '#' (other than section headers) and blank lines are ignored.
# A leading '!' on a line marks it optional/skipped (manual review required).
#
# State is written to ./.state-install-build-deps.json so --uninstall can reverse.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="${SCRIPT_DIR}/.state-install-build-deps.json"

YES=0
UNINSTALL=0
TARGETS=()

die() { echo "error: $*" >&2; exit 1; }
info() { echo "[install-build-deps] $*"; }

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

declare -A APT=() PIP=() NPM=() CARGO=()
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
        if [[ "$line" =~ ^#[[:space:]]*(apt|pip|npm|cargo|rustup):[[:space:]]*$ ]]; then
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
            apt) APT["$line"]=1 ;;
            pip) PIP["$line"]=1 ;;
            npm) NPM["$line"]=1 ;;
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
    info "uninstall is not yet implemented in M0.1"
    info "TODO(M0.x): read $STATE_FILE, undo apt/pip/cargo/pnpm installs and rustup component adds"
    exit 0
fi

print_plan() {
    echo "==== plan ===="
    if ((${#APT[@]})); then
        echo "apt packages: ${!APT[*]}"
    fi
    if ((${#PIP[@]})); then
        echo "pip packages (user): ${!PIP[*]}"
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
    echo "  \"pip\": [$(printf '"%s",' "${!PIP[@]}" | sed 's/,$//')] ,"
    echo "  \"npm\": [$(printf '"%s",' "${!NPM[@]}" | sed 's/,$//')] ,"
    echo "  \"cargo\": [$(printf '"%s",' "${!CARGO[@]}" | sed 's/,$//')]"
    echo "}"
} > "$STATE_FILE"

if ((${#APT[@]})); then
    info "installing apt packages (requires sudo)"
    sudo apt-get update
    sudo apt-get install -y "${!APT[@]}"
fi

if ((${#PIP[@]})); then
    info "installing pip packages (--user)"
    pip install --user "${!PIP[@]}"
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
        info "pnpm not found; enabling via corepack"
        corepack enable || npm install -g pnpm
    fi
    info "pnpm add -g"
    pnpm add -g "${!NPM[@]}"
fi

info "done. state written to $STATE_FILE"
