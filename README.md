# zik

Turn a device — a Chromebook, a phone, a laptop — into a music-player
appliance that can play local files, serve as an MPD client, and act as
a controlled front-end to popular streaming services.

**Status: pre-alpha.** Specifications are being finalised; no code yet.

## Goals

- A kiosk-locked music appliance with separate **admin** and **user** accounts.
- Admin configures the device, the services, users, quotas, network.
  Admin cannot play music.
- Users can only play music or configure their own account. No shell, no
  browsing, no messaging, no other apps.
- Multi-user aware: only one user plays audio at a time; another user
  logging in takes over and pauses the previous session.

## Planned music sources (v1)

- Local files (internal storage, removable drives, SMB, WebDAV, NFS, SFTP, rclone-mounted remotes)
- MPD (a running Music Player Daemon on the LAN or localhost)
- Subsonic-compatible servers (Navidrome, Funkwhale, Airsonic-advanced)
- Spotify (via the Web Playback SDK, or via librespot)
- Podcasts (Podcast Index + arbitrary RSS feeds)
- Bandcamp (embedded web UI)
- Internet radio (radio-browser.info directory)

Deezer, Apple Music, Amazon Music, SoundCloud, YouTube Music, Tidal,
Qobuz and others are planned for later versions.

## Target platforms (v1)

- **Target 1 — developer demo**: runs on any modern Debian/Ubuntu desktop
  without installation, for development and UI iteration.
- **Target 2 — Chromebook**: bootable USB image; tested on HP Chromebook
  x360 12b-ca0010nf. The image is expected to boot and run on most
  Intel 64-bit laptops with Linux-compatible hardware as a byproduct.

Raspberry Pi, smartphones, and generic desktop installs are noted for
future versions but not built in v1.

## Using the MPD service

Zik can connect to any running [Music Player Daemon](https://www.musicpd.org/)
instance on the local network or on the device itself.  Two modes are
supported and can be combined on the same server.

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

## Privacy

No telemetry of any kind. All analytics are opt-out-by-default because
they are not collected in the first place.

## Security

### Subsonic library size limit

The library fetcher pages through `search3` results (500 tracks per request) and stops
at a safety cap of **100 000 tracks** (`_MAX_SONGS` in `services/subsonic/client.py`).
Libraries beyond that size will be silently truncated. Tracks added after the initial
fetch appear via the quick-refresh path (checks the 500 most recently added albums via
`getAlbumList2?type=newest`). If your library exceeds 100k tracks, raise the constant
or implement a smarter pagination strategy.

### Subsonic stream URL credentials

Subsonic authentication uses a token+salt pair (token = MD5(password+salt)) that is
embedded as query parameters in each track's stream URL
(`/rest/stream?u=…&t=…&s=…`). These URLs are built in the browser from auth data
returned by the backend, and are only ever passed as `<audio src>` — the browser does
not expose them to JavaScript after assignment. They are held in memory as part of the
play queue (`QueueItem.audioUrl`) for the lifetime of the session and are never written
to disk or localStorage. An attacker with access to the browser process memory or
DevTools on the device could extract them. On a locked-down kiosk this is an acceptable
risk; on a shared or multi-user desktop it should be noted.

## License

GPL v3. See [LICENSE](LICENSE).

## Contributions

Fork the repository, make your change on a branch, open a pull request.
Contribution guidelines will be published before the first tagged release.