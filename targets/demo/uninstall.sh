#!/usr/bin/env bash
# targets/demo/uninstall.sh — wipe demo build artefacts and XDG state.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

DEEP=0
for arg in "$@"; do
    case "$arg" in
        --deep) DEEP=1 ;;
        -h|--help)
            echo "Usage: $0 [--deep]"
            echo "  --deep  also remove ~/.cache/ms-playwright"
            exit 0
            ;;
        *) echo "unknown flag: $arg" >&2; exit 2 ;;
    esac
done

info() { echo "[uninstall] $*"; }

info "removing Python caches under common/"
find "$REPO/common" \
    \( -name "__pycache__" -o -name ".pytest_cache" \
       -o -name ".ruff_cache" -o -name ".mypy_cache" \
       -o -name ".venv" \) \
    -prune -exec rm -rf {} + 2>/dev/null || true

info "removing frontend artefacts"
rm -rf "$REPO/common/frontend/node_modules" \
       "$REPO/common/frontend/.vite" \
       "$REPO/common/frontend/dist"

info "removing Rust target/"
rm -rf "$REPO/target"

info "removing PAM module build dir"
rm -rf "$REPO/common/pam_adminlock/build"

info "removing demo XDG state"
rm -rf "$HOME/.local/share/zik-demo" \
       "$HOME/.config/zik-demo" \
       "$HOME/.cache/zik-demo" \
       "$HOME/.local/state/zik-demo" \
       "/tmp/zik-demo-runtime-$UID"

if ((DEEP)); then
    info "removing ~/.cache/ms-playwright (--deep)"
    rm -rf "$HOME/.cache/ms-playwright"
fi

info "done"
