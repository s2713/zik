# MAINTAINERS

Active maintainers: *None yet.*

This file records the humans authorised to:

- merge into `main`,
- cut signed release tags,
- approve changes to the runtime-dependency allowlist (`.dependency-allowlist.yml`).

The signing keys used for release tags live under `.maintainers/keys/` as
ASCII-armoured OpenPGP public keys, one file per maintainer.

## Release-signing procedure (v1)

v1 ships with single-maintainer key signing. Tags are signed with
`git tag -s <tag> -m <message>`. The installer verifies the signature against
the keys in `.maintainers/keys/`. A monotonic tag-order check guards against
downgrade (see threat-model T-SW-15).

Two-of-N co-signing (cosign or equivalent) is planned for v2 — see
`claude.roadmap.md` in the `zik-meta` repo.

## Adding a maintainer

1. The new maintainer opens a PR that:
   - adds their public key to `.maintainers/keys/<handle>.asc`,
   - adds their name and key fingerprint to this file.
2. The PR must be reviewed and merged by at least one existing maintainer.
3. When bootstrapping (no existing maintainer), the first key is added by the
   project owner with an out-of-band announcement.

## Dependency allowlist

All runtime-critical dependency pins (Python, Rust, npm) live in
`.dependency-allowlist.yml`. Any change to that file requires a maintainer
review of the upstream release notes and signatures where available.
