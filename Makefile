.PHONY: help setup dev-demo lint test clean

help:
	@echo "zik — top-level Makefile"
	@echo
	@echo "Targets:"
	@echo "  setup     — install Python deps (poetry) + JS deps (pnpm) + build Rust (cargo)"
	@echo "  dev-demo  — run the demo target (target 1): backend + user-helper + mpris + vite"
	@echo "  lint      — run ruff, cargo fmt --check, eslint"
	@echo "  test      — run pytest + vitest (--passWithNoTests) + cargo test"
	@echo "  clean     — wipe build artefacts (delegates to targets/demo/uninstall.sh)"
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

lint:
	cd common/backend && poetry run ruff check .
	cd common/user_helper && poetry run ruff check .
	cd common/mpris_bridge && poetry run ruff check .
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets -- -D warnings
	cd common/frontend && pnpm run lint

test:
	cd common/backend && poetry run pytest
	cd common/user_helper && poetry run pytest
	cd common/mpris_bridge && poetry run pytest
	cargo test --workspace
	cd common/frontend && pnpm run test -- --passWithNoTests

clean:
	bash targets/demo/uninstall.sh
