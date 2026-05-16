# Prepend user-local tool dirs so Make works without a shell restart after install-build-deps.sh.
export PATH := $(HOME)/.cargo/bin:$(HOME)/.local/share/pnpm:$(PATH)

.PHONY: help setup dev-demo dev-release lint test clean

help:
	@echo "zik — top-level Makefile"
	@echo
	@echo "Targets:"
	@echo "  setup       — install Python deps (poetry) + JS deps (pnpm) + build Rust (cargo)"
	@echo "  dev-demo    — run the demo target (target 1): backend + user-helper + mpris + vite"
	@echo "  dev-release — build wheel + frontend, serve a local manifest for OTA testing"
	@echo "                usage: VERSION=1.1.0 make dev-release  (optional: PORT=8765)"
	@echo "  lint        — run ruff, cargo fmt --check, eslint"
	@echo "  test        — run pytest + vitest (--passWithNoTests) + cargo test"
	@echo "  clean       — wipe build artefacts (delegates to targets/demo/uninstall.sh)"
	@echo
	@echo "Per-package commands live in each package directory; invoke them directly"
	@echo "when iterating on one component."

setup:
	cd common/backend && poetry install
	cd common/user_helper && poetry install
	cd common/mpris_bridge && poetry install
	cd common/frontend && pnpm install
	cargo build --workspace

dev-demo:
	bash targets/demo/run.sh

dev-release:
	@[ -n "$(VERSION)" ] || (echo "error: set VERSION=<x.y.z>  e.g.  VERSION=1.1.0-dev make dev-release" >&2 && exit 1)
	bash scripts/dev-release.sh "$(VERSION)" "$(PORT)"

lint:
	cd common/backend && poetry run ruff check .
	cd common/user_helper && poetry run ruff check .
	cd common/mpris_bridge && poetry run ruff check .
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets -- -D warnings
	cd common/frontend && pnpm run lint

test:
	cd common/backend && poetry run pytest
	cd common/user_helper && { poetry run pytest || [ $$? -eq 5 ]; }
	cd common/mpris_bridge && { poetry run pytest || [ $$? -eq 5 ]; }
	cargo test --workspace
	cd common/frontend && pnpm run test

clean:
	bash targets/demo/uninstall.sh
