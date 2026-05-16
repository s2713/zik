# Target 1 — demo

Runs zik's four userland processes on a developer Linux box, with no image
build, no PAM, no setuid privhelp, and in a namespaced XDG tree
(`~/.local/share/zik-demo`, `~/.config/zik-demo`) so it cannot collide with a
real installation.

## Quick start

```bash
# Install build-time dependencies (one-off)
./install-build-deps.sh --yes demo

# Build Python wheel and frontend
make setup

# Start all four processes in one terminal
make dev-demo
```

`make dev-demo` starts:

- the system backend on `127.0.0.1:8173`,
- the per-user helper on `$XDG_RUNTIME_DIR/zik.sock`,
- the MPRIS bridge (idle stub),
- Vite dev server on `127.0.0.1:5173`, proxying `/api` to the backend.

Open `http://localhost:5173` in a browser.  Ctrl-C tears all four processes down.

## Running tests

```bash
# Python unit + integration tests
make test

# Lint (ruff + mypy)
make lint

# End-to-end (Playwright) — downloads browsers on first run
make e2e
```

## Building a production bundle

```bash
make build
```

This builds the Python wheel and the frontend static bundle into `dist/`.
The output is what gets packaged into a Chromebook image or an OTA release
artifact.

## Testing the OTA update flow locally

`make dev-release` builds a release artifact, starts a local HTTP server, and
prints the `tee` command to run on the target device to point it at your
build machine:

```bash
make dev-release VERSION=1.0.0
# Follow the printed instructions on the Chromebook to trigger an update.
```

## Uninstall

```bash
bash targets/demo/uninstall.sh          # wipes demo state + caches
bash targets/demo/uninstall.sh --deep   # also wipes ~/.cache/ms-playwright
```

`install-build-deps.sh --uninstall demo` will revert apt/pip/cargo/pnpm/rustup
installs once implemented (currently prints a TODO).
