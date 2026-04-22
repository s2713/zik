# Target 2 — Chromebook

> **Status: placeholder (M0.1).**
> No image build scripts yet; only the `build-deps` manifest is populated.

Primary device: HP Chromebook x360 12b-ca0010nf (Gemini Lake).
The image aims to be as model-agnostic as possible within the x86_64
MrChromebox-coreboot family.

## Installation

> TODO(P6.2): document the full flash-firmware + flash-USB-key + boot-install
> procedure, including:
> - how to back up the original ChromeOS recovery state (USB key),
> - how to back up the stock firmware (`flashrom -r`) **before** running the
>   MrChromebox firmware utility,
> - how to flash the zik image,
> - first-boot wizard walk-through.

## Bricking disclaimer

> TODO(P6.2): full-bold "unscrewing the device and flashing firmware is your
> responsibility; we accept none" disclaimer — see
> step 7 of `CLAUDE.md`'s Expected-from-Claude checklist.

## Build dependencies

See `build-deps` in this directory and the root `install-build-deps.sh`.
