import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { getCsrfHeaders } from "../../csrf.js";
import { t } from "../../i18n/i18n.js";

type SortKey = "title" | "artist" | "album" | "year";
const SORT_KEYS: SortKey[] = ["artist", "album", "title", "year"];

interface SpotifyTrack {
  id: string;
  uri: string;
  title: string;
  artist: string;
  album: string;
  duration_ms: number;
  year: number;
}

interface SpotifyDevice {
  id: string;
  name: string;
}

/**
 * Spotify service player element.
 * Auth is done via OAuth 2.0 PKCE redirect; playback is controlled via Spotify
 * Web API commands routed through the backend. librespot acts as local device.
 */
@customElement("spotify-player")
export class SpotifyPlayerElement extends LitElement {
  static styles = css`
    :host { display: block; font-family: sans-serif; padding: 1rem; max-width: 700px; }
    h3 { margin: 0 0 0.5rem; }

    .conn-strip { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;
                  padding: 0.5rem; background: #f8f8f8; border-radius: 4px;
                  margin-bottom: 0.4rem; font-size: 0.88em; }
    .badge { font-size: 0.75em; padding: 0.1em 0.4em; border-radius: 3px; }
    .badge.on  { background: #d4edda; color: #155724; }
    .badge.off { background: #f8d7da; color: #721c24; }

    .info-strip { font-size: 0.85em; color: #555; padding: 0.25rem 0.5rem;
                  background: #f0f8ff; border-radius: 4px; margin-bottom: 0.4rem;
                  display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }

    .devices-panel { background: #f8f8f8; border: 1px solid #ddd; border-radius: 4px;
                     padding: 0.5rem; margin-bottom: 0.5rem; }
    .devices-panel h4 { margin: 0 0 0.4rem; font-size: 0.88em; }
    .device-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85em;
                  padding: 0.15rem 0; }
    .device-row.active { font-weight: bold; }

    .toolbar { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;
               margin-bottom: 0.5rem; }
    .toolbar input[type="search"] { font-size: 0.88em; padding: 0.2em 0.4em;
                                    border: 1px solid #bbb; border-radius: 3px; width: 160px; }
    .sort-label { font-size: 0.85em; color: #555; }
    .count { font-size: 0.82em; color: #666; margin: 0 0 0.4rem; }

    table { width: 100%; border-collapse: collapse; font-size: 0.9em; margin-bottom: 1rem; }
    th { text-align: left; border-bottom: 2px solid #ccc; padding: 0.25rem 0.4rem;
         cursor: pointer; user-select: none; }
    th.active { color: #1db954; }
    td { padding: 0.2rem 0.4rem; border-bottom: 1px solid #eee; }
    tr.playing td { background: #e8fff0; font-weight: bold; }
    tr:hover td { background: #f5f5f5; cursor: pointer; }
    .empty { color: #888; font-size: 0.9em; margin: 1rem 0; }
    .time { font-size: 0.8em; color: #555; font-variant-numeric: tabular-nums; }

    .error-strip { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb;
                   border-radius: 4px; padding: 0.4rem 0.6rem; font-size: 0.85em;
                   margin-bottom: 0.5rem; }

    .now-playing { border-top: 2px solid #ccc; padding-top: 0.75rem; }
    .np-title { font-weight: bold; margin-bottom: 0.2rem; }
    .np-sub { font-size: 0.85em; color: #555; margin-bottom: 0.4rem; }
    .seek { width: 100%; margin-bottom: 0.5rem; }
    .ctrls { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
    .vol { display: flex; align-items: center; gap: 0.5rem; }
    .vol input { width: 120px; }
  `;

  @state() private _authed = false;
  @state() private _librespotAvailable = false;
  @state() private _librespotRunning   = false;
  @state() private _librespotDevice    = "";
  @state() private _librespotError     = "";
  @state() private _playing     = false;
  @state() private _progressMs  = 0;
  @state() private _durationMs  = 0;
  @state() private _volumePct   = 100;
  @state() private _deviceId    = "";
  @state() private _deviceName  = "";
  @state() private _track: SpotifyTrack | null = null;
  @state() private _library:   SpotifyTrack[] = [];
  @state() private _devices:   SpotifyDevice[] = [];
  @state() private _showDevices  = false;
  @state() private _commandError = "";
  @state() private _sort: SortKey = "artist";
  @state() private _filter = "";

  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    void this._fetchStatus();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._stopPolling();
  }

  // ---- polling ----

  private _startPolling(): void {
    if (this._pollTimer !== null) return;
    this._pollTimer = setInterval(() => { void this._fetchStatus(); }, 2000);
  }

  private _stopPolling(): void {
    if (this._pollTimer !== null) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  private async _fetchStatus(): Promise<void> {
    try {
      const r = await fetch("/api/spotify/status");
      const data = await r.json() as {
        authed: boolean;
        librespot_available: boolean;
        librespot_running: boolean;
        librespot_device?: string;
        librespot_error?: string;
        playing?: boolean;
        progress_ms?: number;
        volume_pct?: number;
        device_id?: string;
        device_name?: string;
        track?: SpotifyTrack | null;
      };
      this._authed              = data.authed;
      this._librespotAvailable  = data.librespot_available;
      this._librespotRunning    = data.librespot_running;
      this._librespotDevice     = data.librespot_device ?? "";
      this._librespotError      = data.librespot_error  ?? "";
      if (data.authed) {
        this._playing    = data.playing    ?? false;
        this._progressMs = data.progress_ms ?? 0;
        this._volumePct  = data.volume_pct  ?? 100;
        this._deviceId   = data.device_id   ?? "";
        this._deviceName = data.device_name  ?? "";
        this._track      = data.track        ?? null;
        this._durationMs = data.track?.duration_ms ?? 0;
        this._startPolling();
      } else {
        this._stopPolling();
      }
    } catch { /* backend unavailable */ }
  }

  // ---- library + devices ----

  private async _fetchLibrary(): Promise<void> {
    try {
      const r = await fetch("/api/spotify/library");
      if (r.ok) this._library = await r.json() as SpotifyTrack[];
    } catch (err) {
      console.error("spotify: library fetch failed", err);
    }
  }

  private async _fetchDevices(): Promise<void> {
    try {
      const r = await fetch("/api/spotify/devices");
      if (r.ok) {
        this._devices     = await r.json() as SpotifyDevice[];
        this._showDevices = true;
      }
    } catch (err) {
      console.error("spotify: devices fetch failed", err);
    }
  }

  // ---- commands ----

  private async _command(type: string, extra: Record<string, unknown> = {}): Promise<void> {
    try {
      const r = await fetch("/api/spotify/command", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({ type, device_id: this._deviceId, ...extra }),
      });
      if (!r.ok) {
        const data = await r.json() as { error?: string };
        this._commandError = data.error ?? `HTTP ${r.status}`;
        return;
      }
      this._commandError = "";
      // Refresh status shortly after so UI reflects the change.
      setTimeout(() => { void this._fetchStatus(); }, 300);
    } catch (err) {
      this._commandError = (err as Error).message;
    }
  }

  private async _disconnect(): Promise<void> {
    try {
      await fetch("/api/spotify/disconnect", {
        method: "POST",
        headers: { ...getCsrfHeaders() },
      });
      this._authed      = false;
      this._library     = [];
      this._devices     = [];
      this._track       = null;
      this._playing     = false;
      this._showDevices = false;
      this._stopPolling();
    } catch { /* backend unavailable */ }
  }

  /** Restart librespot using stored tokens (no OAuth needed). */
  private async _restartLibrespot(): Promise<void> {
    try {
      await fetch("/api/spotify/librespot/restart", {
        method: "POST",
        headers: { ...getCsrfHeaders() },
      });
      // Status poll picks up the new running state within 2 s.
    } catch { /* backend unavailable */ }
  }

  /** Transfer playback to the librespot device (by matching its name). */
  private async _useLocalDevice(): Promise<void> {
    // Refresh device list first to get the current librespot device ID.
    await this._fetchDevices();
    const dev = this._devices.find((d) => d.name === this._librespotDevice);
    if (dev) {
      await this._command("Transfer", { device_id: dev.id, play: true });
      this._deviceId = dev.id;
      this._showDevices = false;
    }
  }

  /** Transfer to an arbitrary device from the devices panel. */
  private async _transferTo(device: SpotifyDevice): Promise<void> {
    await this._command("Transfer", { device_id: device.id, play: true });
    this._deviceId   = device.id;
    this._deviceName = device.name;
    this._showDevices = false;
  }

  /** Play a track; passes the whole filtered list so Spotify queues them. */
  private async _playTrack(track: SpotifyTrack, playlist: SpotifyTrack[]): Promise<void> {
    // Spotify API accepts up to ~250 URIs; send all displayed tracks starting at index.
    const idx  = playlist.findIndex((t) => t.uri === track.uri);
    const uris = playlist.slice(idx).map((t) => t.uri);
    // Always resolve the librespot device ID fresh: _deviceId from status comes from
    // current_playback() which returns empty when nothing is playing, and librespot
    // gets a new device ID on each restart — so the cached ID can be stale or absent.
    if (this._librespotRunning) {
      await this._fetchDevices();
      const dev = this._devices.find((d) => d.name === this._librespotDevice);
      if (dev) this._deviceId = dev.id;
    }
    await this._command("Play", { uris });
  }

  private _onSeek(e: Event): void {
    const ms = parseFloat((e.target as HTMLInputElement).value);
    void this._command("Seek", { position_ms: Math.round(ms) });
  }

  private _onVolume(e: Event): void {
    const pct = parseInt((e.target as HTMLInputElement).value, 10);
    this._volumePct = pct;
    void this._command("Volume", { percent: pct });
  }

  // ---- display list ----

  private _buildDisplay(): { tracks: SpotifyTrack[]; matched: number } {
    const q = this._filter.trim().toLowerCase();
    const base = q
      ? this._library.filter((tr) =>
          tr.title.toLowerCase().includes(q)  ||
          tr.artist.toLowerCase().includes(q) ||
          tr.album.toLowerCase().includes(q))
      : this._library;
    const matched = base.length;
    const sorted = [...base].sort((a, b) => {
      let va: string | number = String(a[this._sort]).toLowerCase();
      let vb: string | number = String(b[this._sort]).toLowerCase();
      if (this._sort === "year") { va = a.year; vb = b.year; }
      return va < vb ? -1 : va > vb ? 1 : 0;
    });
    return { tracks: sorted.slice(0, 200), matched };
  }

  private _fmt(ms: number): string {
    if (!ms || !isFinite(ms)) return "--:--";
    const totalSec = Math.floor(ms / 1000);
    const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const s = String(totalSec % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  // ---- rendering ----

  override render() {
    const { tracks, matched } = this._buildDisplay();
    const currentUri = this._track?.uri ?? "";
    const isLocalActive = this._deviceName === this._librespotDevice;

    return html`
      <h3>${t("service.spotify")}</h3>

      <!-- auth strip -->
      <div class="conn-strip">
        <span class="badge ${this._authed ? "on" : "off"}">
          ${this._authed ? t("spotify.authed") : t("spotify.not-authed")}
        </span>
        ${this._authed ? html`
          <button @click=${() => void this._fetchLibrary()}>${t("spotify.refresh-library")}</button>
          <button @click=${() => void this._fetchDevices()}>${t("spotify.list-devices")}</button>
          <button @click=${() => void this._disconnect()}>${t("spotify.disconnect")}</button>
        ` : html`
          <button @click=${() => { window.location.href = "/api/spotify/auth/start"; }}>
            ${t("spotify.connect")}
          </button>
        `}
      </div>

      <!-- librespot / active-device info -->
      ${this._authed ? html`
        <div class="info-strip">
          ${this._librespotAvailable ? html`
            ${this._librespotRunning
              ? html`<span class="badge on">${t("spotify.playing-on")} ${this._librespotDevice}</span>`
              : html`
                <span class="badge off">${t("spotify.librespot-stopped")}</span>
                <button @click=${() => void this._restartLibrespot()}>
                  ${t("spotify.restart-librespot")}
                </button>`}
          ` : nothing}
          ${this._deviceName ? html`
            <span>${t("spotify.active-device")}: <em>${this._deviceName}</em></span>
          ` : nothing}
          ${this._librespotRunning && !isLocalActive ? html`
            <button @click=${() => void this._useLocalDevice()}>${t("spotify.use-this-device")}</button>
          ` : nothing}
          ${this._librespotError ? html`
            <div class="error-strip">${this._librespotError}</div>
          ` : nothing}
        </div>
      ` : nothing}

      <!-- device picker -->
      ${this._showDevices && this._devices.length > 0 ? html`
        <div class="devices-panel">
          <h4>${t("spotify.list-devices")}</h4>
          ${this._devices.map((d) => html`
            <div class="device-row ${d.id === this._deviceId ? "active" : ""}">
              <span>${d.name}</span>
              <button ?disabled=${d.id === this._deviceId}
                      @click=${() => void this._transferTo(d)}>
                ${t("spotify.use")}
              </button>
            </div>
          `)}
          <button @click=${() => { this._showDevices = false; }}>${t("spotify.cancel")}</button>
        </div>
      ` : nothing}

      <!-- library toolbar -->
      ${this._authed ? html`
        <div class="toolbar">
          <input type="search" placeholder=${t("spotify.filter-placeholder")}
                 .value=${this._filter}
                 @input=${(e: Event) => { this._filter = (e.target as HTMLInputElement).value; }} />
          <span class="sort-label">${t("files.sort.artist")}:</span>
          ${SORT_KEYS.map((k) => html`
            <button ?disabled=${this._sort === k} @click=${() => { this._sort = k; }}>
              ${t(`files.sort.${k}`)}
            </button>
          `)}
        </div>

        <!-- track table -->
        ${this._library.length === 0
          ? html`<p class="empty">${t("spotify.no-tracks")}</p>`
          : matched === 0
            ? html`<p class="empty">${t("spotify.no-match")}</p>`
            : html`
              <p class="count">${matched} / ${this._library.length}
                ${tracks.length < matched ? html` — showing first ${tracks.length}` : nothing}
              </p>
              <table>
                <thead>
                  <tr>
                    <th class=${this._sort === "title"  ? "active" : ""} @click=${() => { this._sort = "title"; }}>
                      ${t("files.sort.title")}</th>
                    <th class=${this._sort === "artist" ? "active" : ""} @click=${() => { this._sort = "artist"; }}>
                      ${t("files.sort.artist")}</th>
                    <th class=${this._sort === "album"  ? "active" : ""} @click=${() => { this._sort = "album"; }}>
                      ${t("files.sort.album")}</th>
                    <th class=${this._sort === "year"   ? "active" : ""} @click=${() => { this._sort = "year"; }}>
                      ${t("files.sort.year")}</th>
                    <th class="time">—</th>
                  </tr>
                </thead>
                <tbody>
                  ${tracks.map((tr) => html`
                    <tr class=${tr.uri === currentUri && this._playing ? "playing" : ""}
                        @click=${() => void this._playTrack(tr, tracks)}>
                      <td>${tr.title}</td>
                      <td>${tr.artist}</td>
                      <td>${tr.album}</td>
                      <td>${tr.year || ""}</td>
                      <td class="time">${this._fmt(tr.duration_ms)}</td>
                    </tr>
                  `)}
                </tbody>
              </table>
            `
        }

        <!-- command error -->
        ${this._commandError ? html`
          <div class="error-strip">${this._commandError}</div>
        ` : nothing}

        <!-- now-playing panel -->
        ${this._track ? html`
          <div class="now-playing">
            <div class="np-title">${t("files.now-playing")}: ${this._track.title}</div>
            <div class="np-sub">${this._track.artist} — ${this._track.album}</div>
            <input class="seek" type="range" min="0" max=${this._durationMs || 1}
                   .value=${live(this._progressMs)}
                   @change=${this._onSeek} />
            <div class="np-sub time">
              ${this._fmt(this._progressMs)} / ${this._fmt(this._durationMs)}
            </div>
            <div class="ctrls">
              <button @click=${() => void this._command("Previous")}>${t("player.prev")}</button>
              <button @click=${() => void this._command(this._playing ? "Pause" : "Play")}>
                ${this._playing ? t("player.pause") : t("player.play")}
              </button>
              <button @click=${() => void this._command("Next")}>${t("player.next")}</button>
            </div>
            <div class="vol">
              <span>${t("player.volume")}</span>
              <input type="range" min="0" max="100"
                     .value=${live(this._volumePct)} @input=${this._onVolume} />
            </div>
          </div>
        ` : nothing}
      ` : nothing}
    `;
  }
}