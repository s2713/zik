# MAINTAINERS

Active maintainers:
- Sylvain Raybaud <contact@poppitech.fr>

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

Two-of-N co-signing (cosign or equivalent) is planned for v2.

## Adding a maintainer

1. The new maintainer opens a PR that:
   - adds their public key to `.maintainers/keys/<handle>.asc`,
   - adds their name and key fingerprint to this file.
2. The PR must be reviewed and merged by at least one existing maintainer.
3. When bootstrapping (no existing maintainer), the first key is added by the
   project owner with an out-of-band announcement.

## GPG key setup (one-time per maintainer)

Maintainer keys are used for both **signed git tags** and **release artifact
signatures**.  The same key may be used for both, or a dedicated artifact-signing
subkey may be created.

```bash
# 1. Generate a dedicated key (ED25519, 2-year expiry recommended).
gpg --full-generate-key
#    Kind   : (1) RSA or (9) ECC → choose (9) ED25519
#    Expiry : 2y
#    Name   : Your Name
#    Email  : your@email.example

# 2. Note the key fingerprint.
gpg --list-secret-keys --keyid-format long your@email.example

# 3. Export the public key into the maintainer key store.
gpg --export --armor <fingerprint> > .maintainers/keys/<handle>.asc
# Example: .maintainers/keys/sylvain.asc

# 4. Commit and PR (see "Adding a maintainer" above).
```

Store the private key securely; a hardware token (YubiKey, Nitrokey) is
strongly recommended.  Export an encrypted backup:

```bash
gpg --export-secret-keys --armor <fingerprint> > <handle>-privkey.asc.gpg
# (gpg prompts for a passphrase to encrypt the export)
```

### Key rotation

1. Generate a new key following the steps above.
2. Sign the new key with the old key: `gpg --sign-key <new-fingerprint>`.
3. Open a PR adding the new `.asc` and removing (or marking expired) the old one.
4. Cut the next release signed with the new key.
5. Revoke the old key once the new one is in production.

---

## Cutting a release

### 1. Build artifacts

```bash
# Backend wheel
cd common/backend
poetry build --format wheel
# → dist/zik_backend-<version>-py3-none-any.whl

# Frontend tarball
cd common/frontend
pnpm build
tar -czf "zik-frontend-<version>.tar.gz" -C dist .
```

Replace `<version>` with the release tag (e.g. `1.1`).

### 2. Sign artifacts

```bash
# Detached ASCII-armoured signatures, one per artifact.
gpg --detach-sign --armor --local-user <fingerprint> \
    zik_backend-<version>-py3-none-any.whl

gpg --detach-sign --armor --local-user <fingerprint> \
    zik-frontend-<version>.tar.gz

# Verify before uploading.
gpg --verify zik_backend-<version>-py3-none-any.whl.asc \
             zik_backend-<version>-py3-none-any.whl
gpg --verify zik-frontend-<version>.tar.gz.asc \
             zik-frontend-<version>.tar.gz
```

### 3. Create a signed git tag

```bash
git tag -s "v<version>" -m "Release v<version>"
git push origin "v<version>"
```

### 4. Create the GitHub Release

On GitHub → Releases → "Draft a new release":

1. Select the signed tag `v<version>`.
2. Upload the four files:
   - `zik_backend-<version>-py3-none-any.whl`
   - `zik_backend-<version>-py3-none-any.whl.asc`
   - `zik-frontend-<version>.tar.gz`
   - `zik-frontend-<version>.tar.gz.asc`
3. Publish the release.

### 5. Update the version manifest

Edit `releases/latest.json` in the repo (or wherever the manifest URL points)
and commit to `main`.  The manifest format is:

```json
{
  "latest": "<version>",
  "min_version": "<oldest-version-devices-may-upgrade-from>",
  "artifacts": {
    "backend": {
      "url": "https://github.com/<owner>/zik/releases/download/v<version>/zik_backend-<version>-py3-none-any.whl",
      "sha256": "<sha256sum of .whl>"
    },
    "frontend": {
      "url": "https://github.com/<owner>/zik/releases/download/v<version>/zik-frontend-<version>.tar.gz",
      "sha256": "<sha256sum of .tar.gz>"
    }
  }
}
```

The manifest itself is fetched over HTTPS; individual artifacts are verified
against their detached GPG signatures.  SHA-256 checksums in the manifest
provide a second layer of integrity.

Compute checksums:

```bash
sha256sum zik_backend-<version>-py3-none-any.whl
sha256sum zik-frontend-<version>.tar.gz
```

---

## Release image policy

The base image built by `build-image.sh` must not contain any SSH
`authorized_keys` files.  SSH access is a per-deployment concern: operators
add their public keys via `config.yaml` → `configure-image.sh`, which is run
after the base image is built and never distributed.

`build-image.sh` enforces this with a hard failure at step 17 if any
`authorized_keys` file is found in the chroot.  Do not bypass this check.

---

## Dependency allowlist

All runtime-critical dependency pins (Python, Rust, npm) live in
`.dependency-allowlist.yml`. Any change to that file requires a maintainer
review of the upstream release notes and signatures where available.

---

## IDE / editor hygiene

The following directories are machine-generated or constantly churning; exclude
them from file-watching and indexed search to keep your IDE responsive.

**VS Code** — add to `.vscode/settings.json`:

```json
{
  "files.watcherExclude": {
    "**/.venv/**": true,
    "**/__pycache__/**": true,
    "**/.pytest_cache/**": true,
    "**/.mypy_cache/**": true,
    "**/.ruff_cache/**": true,
    "**/node_modules/**": true,
    "**/.vite/**": true,
    "**/dist/**": true,
    "**/target/**": true,
    "**/work/**": true
  },
  "search.exclude": {
    "**/.venv": true,
    "**/node_modules": true,
    "**/dist": true,
    "**/target": true,
    "**/work": true
  }
}
```

**JetBrains IDEs** — right-click each of `.venv/`, `node_modules/`, `dist/`,
`target/`, `work/` and choose *Mark Directory as → Excluded*.

**Neovim / EditorConfig** — add the generated directories to `.gitignore`
(already done) and configure your LSP or file-picker to respect it.

---

## License

GPL v3. See [LICENSE](LICENSE).

---

## Contributions

Fork the repository, make your change on a branch, open a pull request.
Contribution guidelines will be published before the first tagged release.
