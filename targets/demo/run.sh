#!/usr/bin/env bash
# targets/demo/run.sh — start the four userland processes locally.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

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

# Backend.
cd "$REPO/common/backend"
start backend poetry run zik-backend

# Per-user helper.
cd "$REPO/common/user_helper"
start user-helper poetry run zik-user-helper

# MPRIS bridge (idle stub for M0.1).
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
