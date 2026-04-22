# Target 1 — demo

Runs zik's four userland processes on a developer Linux box, with no image
build, no PAM, no setuid privhelp, and in a namespaced XDG tree
(`~/.local/share/zik-demo`, `~/.config/zik-demo`) so it cannot collide with a
real installation.

## Quick start

```
./install-build-deps.sh --yes demo
make setup
make dev-demo
```

`make dev-demo` starts:

- the system backend on `127.0.0.1:8173`,
- the per-user helper on `$XDG_RUNTIME_DIR/zik.sock`,
- the MPRIS bridge (idle stub),
- Vite dev server on `127.0.0.1:5173`, proxying `/api` to the backend.

Ctrl-C tears all four down.

## Uninstall

```
bash targets/demo/uninstall.sh          # wipes demo state + caches
bash targets/demo/uninstall.sh --deep   # also wipes ~/.cache/ms-playwright
```

`install-build-deps.sh --uninstall demo` will revert apt/pip/cargo/pnpm/rustup
installs once implemented (currently prints a TODO).
