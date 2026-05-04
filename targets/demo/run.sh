#!/usr/bin/env bash
# targets/demo/run.sh — start the four userland processes locally.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

# Pin poetry's cache to its real location before we override XDG_CACHE_HOME below;
# otherwise poetry looks for venvs in the demo-namespaced cache and finds nothing.
export POETRY_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/pypoetry"

# Namespace XDG so demo state cannot collide with a real install.
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/zik-demo"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/zik-demo"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}/zik-demo"
export XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}/zik-demo"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"

if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
    export XDG_RUNTIME_DIR="/tmp/zik-demo-runtime-$UID"
    mkdir -p "$XDG_RUNTIME_DIR"
    chmod 700 "$XDG_RUNTIME_DIR"
fi

PIDS=()

cleanup() {
    echo
    echo "[demo] shutting down…"
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done
    # Give them a moment, then force.
    sleep 1
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -KILL "$pid" 2>/dev/null || true
        fi
    done
}
trap cleanup EXIT INT TERM

start() {
    local name="$1"; shift
    echo "[demo] starting $name: $*"
    ( "$@" ) &
    PIDS+=($!)
}

# Tell the backend where to find the i18n messages file.
export ZIK_MESSAGES_JSON="$REPO/common/frontend/src/i18n/messages.json"

# Root directory scanned for audio files by the files service.
# Override with e.g. ZIK_FILES_ROOT=/path/to/music ./targets/demo/run.sh
export ZIK_FILES_ROOT="${ZIK_FILES_ROOT:-$HOME/Music}"

# SQLite library index (persisted across demo restarts).
export ZIK_LIBRARY_DB="$XDG_DATA_HOME/library.db"

# Optional removable-drive simulation: point to any directory to test mount/unmount.
# Example: ZIK_REMOVABLE_ROOT=~/usb-music ./targets/demo/run.sh
export ZIK_REMOVABLE_ROOT="${ZIK_REMOVABLE_ROOT:-}"

# Spotify OAuth client ID (from the Spotify Developer Dashboard).
# Example: ZIK_SPOTIFY_CLIENT_ID=abc123 ./targets/demo/run.sh
export ZIK_SPOTIFY_CLIENT_ID="${ZIK_SPOTIFY_CLIENT_ID:-}"

# Unix socket shared between backend (P1) and per-user helper (P2).
export ZIK_HELPER_SOCKET="$XDG_RUNTIME_DIR/zik.sock"

# WebSocket URL for the MPRIS bridge (P3) to reach the backend (P1).
export ZIK_BACKEND_URL="ws://127.0.0.1:8173"

# Backend.
cd "$REPO/common/backend"
start backend poetry run zik-backend

# Per-user helper.
cd "$REPO/common/user_helper"
start user-helper poetry run zik-user-helper

# MPRIS bridge — connects to backend WS and logs playback events.
cd "$REPO/common/mpris_bridge"
start mpris-bridge poetry run zik-mpris-bridge

# Frontend.
cd "$REPO/common/frontend"
start vite pnpm run dev

echo
echo "[demo] frontend: http://127.0.0.1:5173"
echo "[demo] backend:  http://127.0.0.1:8173/api/health"
echo "[demo] Ctrl-C to stop."
wait
