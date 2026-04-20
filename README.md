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

## Privacy

No telemetry of any kind. All analytics are opt-out-by-default because
they are not collected in the first place.

## License

GPL v3. See [LICENSE](LICENSE).

## Contributions

Fork the repository, make your change on a branch, open a pull request.
Contribution guidelines will be published before the first tagged release.