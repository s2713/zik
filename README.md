# zik

Turn a device — a Chromebook, a phone, a laptop — into a dedicated music-player
appliance with separate **admin** and **user** accounts, kiosk-locked so that users
can only play music or configure their own profile.

**Status: pre-release demo.** The user and admin interfaces are functional; the
Chromebook image builder and OTA update flow are implemented.  A first tagged
release will follow a period of real-device testing.

---

## Goals

- A kiosk-locked music appliance with separate **admin** and **user** accounts.
- Admin configures the device, services, users, quotas, and network.
  Admin cannot play music.
- Users can only play music or configure their own account.  No shell, no
  browsing, no messaging, no other apps.
- Multi-user aware: only one user plays audio at a time; another user logging in
  takes over and pauses the previous session.
- No telemetry. See [Privacy](#privacy).

---

## Music sources

### Implemented

| Service | Notes |
|---|---|
| **MPD** | Remote-control or stream-to-device modes; see [MPD service](#mpd-service) |
| **Subsonic** | Navidrome, Funkwhale, Airsonic-Advanced; library cached locally |
| **Internet radio** | radio-browser.info directory (~30 k stations) + SomaFM |
| **Podcasts** | Arbitrary RSS/Atom feeds |
| **Spotify** | Web Playback SDK (Premium required; Widevine DRM — see [Privacy](#privacy)) |
| **Local files** | Files stored on the device |

### Planned (later versions)

Local files via removable drives, SMB, WebDAV, NFS, SFTP, and rclone-mounted
remotes; Deezer, Apple Music, Amazon Music, SoundCloud, YouTube Music, Tidal,
Qobuz, Bandcamp, and Podcast Index integration.

---

## Target platforms

| Target | Status | README |
|---|---|---|
| **Demo** — any Debian/Ubuntu desktop | Functional; runs without installation | [targets/demo/README.md](targets/demo/README.md) |
| **Chromebook** — HP x360 12b-ca0010nf | Image builder + OTA update implemented | [targets/chromebook/README.md](targets/chromebook/README.md) |

Raspberry Pi, smartphones, and generic desktop installs are planned for future
versions.

---

## Quick start — demo target

The demo target runs on any modern Debian/Ubuntu desktop without installation.
It cannot replace the production Chromebook image, but it is the primary
development and UI-testing vehicle.

```bash
git clone https://github.com/your-org/zik.git
cd zik
./install-build-deps.sh --yes demo
make setup
make dev-demo
```

Open `http://localhost:5173` in a browser.  Ctrl-C stops all processes.

See [targets/demo/README.md](targets/demo/README.md) for the full dev-loop,
uninstall instructions, and how to run tests.

---

## Quick start — Chromebook target

See [targets/chromebook/README.md](targets/chromebook/README.md) for the full
procedure: ChromeOS recovery backup, firmware flash, image build, and SSD
install.  The short version:

```bash
# On the build host
cd targets/chromebook
sudo ./build-image.sh --version 1.0
sudo ./configure-image.sh --image work/zik-chromebook-1.0.img.zst --config config.yaml
# Flash to a USB key, boot the Chromebook from it, optionally write to the SSD.
```

---

## MPD service

Zik can connect to any running [Music Player Daemon](https://www.musicpd.org/)
instance on the local network or on the device itself.  Two modes are supported
and can be combined on the same server.

### Mode 1 — audio plays on the MPD server

This is the classic MPD setup.  The MPD server is connected to a sound system
(speakers, amplifier, DAC…) and plays audio through its own audio output.
Zik acts as a remote control: it browses the library and sends
play/pause/stop/seek/volume commands via the MPD protocol.  No stream URL is
needed.

**MPD server configuration** (`mpd.conf`):

```
# Any standard audio output will do — for example PipeWire:
audio_output {
    type  "pipewire"
    name  "PipeWire output"
}
```

To prevent clients from controlling playback (e.g. if you want the server
to be browseable but not playable by remote clients), restrict the password
to the `read` command group only:

```
password "readonly_password@read"
password "full_password@read,add,control,admin"
```

**Connecting from the zik appliance:**

Fill in *Host*, *Port* (default 6600), and optionally *Password*.  Leave
*Stream URL* empty.  When you click a track, the MPD server begins playing
through its own audio output.

---

### Mode 2 — audio plays on the zik device

The MPD server is configured with an `httpd` output plugin, which broadcasts
the current audio as an HTTP stream.  Zik fetches that stream and plays it
locally through the browser's audio engine.  This lets you control an MPD
library while hearing the music on the zik device itself.

**MPD server configuration** (`mpd.conf`):

```
audio_output {
    type    "httpd"
    name    "HTTP stream"
    encoder "lame"          # or "opus", "flac", "vorbis"
    port    "8000"
    bitrate "192"
    format  "44100:16:2"
    always_on "yes"         # keep the port open even when not playing
}
```

You can have both an `httpd` output and a local audio output active at the
same time; MPD will feed all active outputs simultaneously.

**Connecting from the zik appliance:**

Fill in *Host*, *Port*, *Password* (if any), and set *Stream URL* to the
address of the `httpd` output — for example `http://192.168.1.10:8000/`.
When you click a track, MPD starts playing and Zik opens that URL in its
audio engine.

**Known limitation:** HTTP audio streams are not seekable in the traditional
sense.  When you use the seek bar, Zik sends the seek command to MPD (which
changes its playback position) and then reconnects the stream, so audio
resumes from the new position after a brief gap.

---

## Subsonic service

Zik connects to any Subsonic-compatible server (Navidrome, Funkwhale,
Airsonic-Advanced).  Auth uses the token+salt method (token = MD5(password+salt)
per Subsonic API ≥ 1.13).

The library is fetched once and cached to disk; subsequent sessions load the
cache instantly.  Two refresh modes are available on the source strip:

- **Quick refresh (↺)** — fetches the 500 most recently added albums and merges
  new tracks into the cache.  Fast, but cannot detect deletions or metadata
  changes.
- **Full refresh (⟳)** — re-fetches the entire library via paginated `search3`.
  Detects deletions and metadata changes; takes longer for large libraries.

---

## Privacy

Zik collects **no telemetry** of any kind.  The following services may receive
network requests from the device; all are triggered by user actions or
configured feeds, not by background analytics.

| Service | When contacted | Data sent |
|---|---|---|
| **radio-browser.info** | Searching for stations; playing a station (click registration) | Search query; station UUID |
| **SomaFM** | Loading the internet radio page | None beyond your IP address |
| **Podcast RSS feeds** | Subscribing to or refreshing a feed | Your IP address (to the feed server) |
| **Spotify** | Using the Spotify service | Full Spotify session (account data, playback); Widevine DRM requires a licence request to Google |

Services **not yet implemented** that may contact external servers in future
versions: Last.fm (optional scrobbling), LRCLIB (lyrics), Podcast Index
(podcast search).

Zik does not install browser extensions, modify the system hosts file, or
inject tracking scripts.  Streams and metadata are fetched by the backend and
forwarded to the frontend; vendor APIs are never called directly from the
browser, except for the Spotify Web Playback SDK which runs in the browser by
design.

---

## Security

### Subsonic library size limit

The library fetcher pages through `search3` results (500 tracks per request) and
stops at a safety cap of **100 000 tracks** (`_MAX_SONGS` in
[`common/backend/zik_backend/services/subsonic/client.py`](common/backend/zik_backend/services/subsonic/client.py)).
Libraries beyond that size will be silently truncated.  Tracks added after the
initial fetch appear via the quick-refresh path (checks the 500 most recently
added albums via `getAlbumList2?type=newest`).  If your library exceeds 100k
tracks, raise the constant or implement a smarter pagination strategy.

### Subsonic stream URL credentials

Subsonic authentication uses a token+salt pair (token = MD5(password+salt)) that
is embedded as query parameters in each track's stream URL
(`/rest/stream?u=…&t=…&s=…`).  These URLs are built in the browser from auth
data returned by the backend, and are only ever passed as `<audio src>` — the
browser does not expose them to JavaScript after assignment.  They are held in
memory as part of the play queue (`QueueItem.audioUrl`) for the lifetime of the
session and are never written to disk or localStorage.  An attacker with access
to the browser process memory or DevTools on the device could extract them.  On
a locked-down kiosk this is an acceptable risk; on a shared or multi-user
desktop it should be noted.

### GRUB boot password

On the Chromebook target, the GRUB boot menu is password-protected with a
PBKDF2-hashed admin password.  The maintenance shell (recovery partition) is
gated behind the same password.

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
