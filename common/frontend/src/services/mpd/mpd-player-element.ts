import { css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { getCsrfHeaders } from "../../csrf.js";
import { t } from "../../i18n/i18n.js";
import { VolumeNormalizer } from "../../audio/normalizer.js";
import { type PlayerBusCmd, playerBus } from "../../player-bus.js";
import { PlayerBase } from "../../player-base.js";

type SortKey = "title" | "artist" | "album";
const SORT_KEYS: SortKey[] = ["artist", "album", "title"];

interface MpdTrack {
  file: string;
  title?: string;
  artist?: string;
  album?: string;
  date?: string;
  time?: string;  // duration in seconds as string
}

interface MpdStatus {
  state?: string;   // "play" | "pause" | "stop"
  songid?: string;
  elapsed?: string;
  duration?: string;
  volume?: string;
}

interface ConnForm {
  host: string;
  port: string;
  password: string;
  stream_url: string;
}

/**
 * MPD service player element.
 * Controls a remote MPD server via the protocol; audio plays locally via an
 * <audio> element pointed at the server's HTTP stream output (httpd plugin).
 * Polls /api/mpd/status every 2 s when connected.
 */
@customElement("mpd-player")
export class MpdPlayerElement extends PlayerBase {
  static styles = css`
    :host { display: block; font-family: sans-serif; padding: 1rem; max-width: 700px; }
    h3 { margin: 0 0 0.5rem; }

    /* connection strip */
    .conn-strip { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;
                  padding: 0.5rem; background: #f8f8f8; border-radius: 4px;
                  margin-bottom: 0.4rem; font-size: 0.88em; }
    .badge { font-size: 0.75em; padding: 0.1em 0.4em; border-radius: 3px; }
    .badge.on  { background: #d4edda; color: #155724; }
    .badge.off { background: #f8d7da; color: #721c24; }

    /* connection form */
    .conn-form { background: #f0f8ff; border: 1px solid #b8d4f0; border-radius: 4px;
                 padding: 0.75rem; margin-bottom: 0.75rem; }
    .conn-form h4 { margin: 0 0 0.5rem; font-size: 0.9em; }
    .conn-form .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem 0.75rem; }
    .conn-form label { display: flex; flex-direction: column; font-size: 0.82em; gap: 0.15rem; }
    .conn-form input { font-size: 0.9em; padding: 0.2em 0.3em;
                       border: 1px solid #bbb; border-radius: 3px; }
    .conn-form small { font-size: 0.78em; color: #666; margin-top: 0.1rem; }
    .conn-form .form-actions { margin-top: 0.5rem; display: flex; gap: 0.4rem; }

    /* toolbar */
    .toolbar { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;
               margin-bottom: 0.5rem; }
    .toolbar input[type="search"] { font-size: 0.88em; padding: 0.2em 0.4em;
                                    border: 1px solid #bbb; border-radius: 3px; width: 160px; }
    .sort-label { font-size: 0.85em; color: #555; }
    .count { font-size: 0.82em; color: #666; margin: 0 0 0.4rem; }

    /* track table */
    table { width: 100%; border-collapse: collapse; font-size: 0.9em; margin-bottom: 1rem; }
    th { text-align: left; border-bottom: 2px solid #ccc; padding: 0.25rem 0.4rem; }
    td { padding: 0.2rem 0.4rem; border-bottom: 1px solid #eee; }
    tr.playing td { background: #e8f4ff; font-weight: bold; }
    tr:hover td { background: #f5f5f5; cursor: pointer; }
    .empty { color: #888; font-size: 0.9em; margin: 1rem 0; }
    .time { font-size: 0.8em; color: #555; font-variant-numeric: tabular-nums; }

    /* audio error banner */
    .audio-error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb;
                   border-radius: 4px; padding: 0.4rem 0.6rem; font-size: 0.85em;
                   margin-bottom: 0.5rem; }

    /* now-playing panel */
    .now-playing { border-top: 2px solid #ccc; padding-top: 0.75rem; }
    .np-title { font-weight: bold; margin-bottom: 0.2rem; }
    .np-sub { font-size: 0.85em; color: #555; margin-bottom: 0.4rem; }
    .seek { width: 100%; margin-bottom: 0.5rem; }
    .ctrls { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
    .vol { display: flex; align-items: center; gap: 0.5rem; }
    .vol input { width: 120px; }
  `;

  @state() private _connected = false;
  @state() private _showForm = false;
  @state() private _form: ConnForm = {
    host: "localhost", port: "6600", password: "", stream_url: "",
  };
  @state() private _streamUrl = "";
  @state() private _status: MpdStatus = {};
  @state() private _currentsong: MpdTrack = { file: "" };
  @state() private _library: MpdTrack[] = [];
  @state() private _sort: SortKey = "artist";
  @state() private _filter = "";
  @state() private _volume           = 1.0;  // local audio volume 0..1
  @state() private _audioError       = "";   // non-empty when the audio element reports an error
  @state() private _normalizeOn      = false;
  @state() private _normalizeBlocked = false;

  // Hidden <audio> element; plays the MPD server's HTTP stream output.
  private readonly _audio      = new Audio();
  private readonly _normalizer = new VolumeNormalizer();

  private _pollTimer:        ReturnType<typeof setInterval> | null = null;
  private _lastNotifyKey = "";  // "state:file" — avoids redundant MPRIS events

  private readonly _onBusCmd = (e: Event): void => {
    const cmd = (e as CustomEvent<PlayerBusCmd>).detail;
    if (cmd.serviceId !== "mpd") return;
    switch (cmd.type) {
      case "Play":      void this._resume(); break;
      case "Pause":     void this._pause();  break;
      case "Stop":      void this._stop();   break;
      case "Next":      void this._next();   break;
      case "Previous":  void this._prev();   break;
      case "SetVolume": this._volume = cmd.volume; this._audio.volume = cmd.volume; break;
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this._audio.addEventListener("error", () => {
      const err = this._audio.error;
      this._audioError = err ? `Audio error ${err.code}: ${err.message}` : "Unknown audio error";
    });
    playerBus.addEventListener("cmd", this._onBusCmd);
    void this._fetchStatus();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    playerBus.removeEventListener("cmd", this._onBusCmd);
    this._stopPolling();
    this._stopAudio();
    this._normalizer.disconnect();
  }

  private _connectNormalizer(): void {
    if (!VolumeNormalizer.isSameOrigin(this._audio.src)) {
      this._normalizeBlocked = true; this._normalizer.disable(); return;
    }
    if (this._normalizer.blocked) { this._normalizeBlocked = true; return; }
    const ok = this._normalizer.connect(this._audio);
    this._normalizeBlocked = !ok;
    if (ok && this._normalizeOn) this._normalizer.enable();
  }

  private _toggleNormalize(): void {
    if (this._normalizeBlocked) return;
    this._normalizeOn = !this._normalizeOn;
    if (this._normalizeOn) {
      this._connectNormalizer();
      this._normalizer.enable();
    } else {
      this._normalizer.disable();
    }
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
      const r = await fetch("/api/mpd/status");
      const data = await r.json() as {
        connected: boolean;
        host?: string;
        port?: number;
        password?: string;
        stream_url: string;
        status: MpdStatus;
        currentsong: MpdTrack;
      };
      this._connected   = data.connected;
      this._streamUrl   = data.stream_url ?? "";
      this._status      = data.status ?? {};
      this._currentsong = data.currentsong ?? { file: "" };
      if (this._connected) {
        void this._notifyPlayer();
        // Keep form in sync with actual connection so Edit is always pre-filled.
        // Skip if the form is open — the user may be mid-edit.
        if (!this._showForm) {
          this._form = {
            host:       data.host       ?? this._form.host,
            port:       String(data.port ?? this._form.port),
            password:   data.password   ?? this._form.password,
            stream_url: data.stream_url ?? this._form.stream_url,
          };
        }
        this._startPolling();
      } else {
        this._stopPolling();
        this._stopAudio();
      }
    } catch { /* backend unavailable */ }
  }

  // ---- connection ----

  private async _connect(): Promise<void> {
    const streamUrl = this._form.stream_url.trim();
    if (!streamUrl) return;  // form button is disabled, but guard anyway
    try {
      const r = await fetch("/api/mpd/connect", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({
          host: this._form.host,
          port: parseInt(this._form.port, 10),
          password: this._form.password,
          stream_url: streamUrl,
        }),
      });
      const data = await r.json() as {
        connected: boolean;
        stream_url: string;
        status: MpdStatus;
        currentsong: MpdTrack;
      };
      if (data.connected) {
        this._connected = true;
        this._streamUrl = data.stream_url ?? "";
        this._status = data.status ?? {};
        this._currentsong = data.currentsong ?? { file: "" };
        this._showForm = false;
        this._startPolling();
        await this._fetchLibrary();
      }
    } catch { /* backend unavailable */ }
  }

  private async _disconnect(): Promise<void> {
    try {
      await fetch("/api/mpd/disconnect", {
        method: "POST",
        headers: { ...getCsrfHeaders() },
      });
      this._connected = false;
      this._streamUrl = "";
      this._status = {};
      this._currentsong = { file: "" };
      this._library = [];
      this._stopPolling();
      this._stopAudio();
    } catch { /* backend unavailable */ }
  }

  // ---- audio control ----

  /** Start streaming from the MPD httpd output URL. */
  private _startAudio(): void {
    if (!this._streamUrl) return;
    this._audioError = "";
    // Reassigning src forces a fresh connection, picking up from MPD's current position.
    this._audio.src = this._streamUrl;
    this._audio.volume = this._volume;
    void this._audio.play();
  }

  /** Pause local audio without touching MPD server state. */
  private _pauseAudio(): void {
    this._audio.pause();
  }

  /** Stop and detach the stream so no data is fetched while idle. */
  private _stopAudio(): void {
    this._audio.pause();
    this._audio.src = "";
  }

  // ---- library ----

  private async _fetchLibrary(): Promise<void> {
    try {
      const r = await fetch("/api/mpd/library");
      if (r.ok) this._library = await r.json() as MpdTrack[];
    } catch (err) {
      console.error("mpd: library fetch failed", err);
    }
  }

  /** Filter by query across title/artist/album, sort, cap at 200 for DOM safety. */
  private _displayLibrary(): { tracks: MpdTrack[]; matched: number } {
    const q = this._filter.trim().toLowerCase();
    // String() guards against list-valued tags (e.g. multi-artist: ["A", "B"])
    const base = q
      ? this._library.filter((tr) =>
          String(tr.title  ?? tr.file ?? "").toLowerCase().includes(q) ||
          String(tr.artist ?? "").toLowerCase().includes(q) ||
          String(tr.album  ?? "").toLowerCase().includes(q))
      : this._library;
    const matched = base.length;
    const sorted = [...base].sort((a, b) => {
      const va = String(a[this._sort] ?? a.file ?? "").toLowerCase();
      const vb = String(b[this._sort] ?? b.file ?? "").toLowerCase();
      return va < vb ? -1 : va > vb ? 1 : 0;
    });
    return { tracks: sorted.slice(0, 200), matched };
  }

  // ---- playback commands ----

  private async _playTrack(track: MpdTrack): Promise<void> {
    // Tell MPD to start playing; then reconnect the audio stream so it follows.
    await this._post({ type: "PlayUri", uri: track.file });
    this._startAudio();
  }

  private async _pause(): Promise<void> {
    await this._post({ type: "Pause" });
    this._pauseAudio();
  }

  private async _resume(): Promise<void> {
    await this._post({ type: "Resume" });
    this._startAudio();
  }

  private async _stop(): Promise<void> {
    await this._post({ type: "Stop" });
    this._stopAudio();
  }

  private async _next(): Promise<void> {
    await this._post({ type: "Next" });
    // Reconnect stream so audio follows MPD to the next track.
    this._startAudio();
  }

  private async _prev(): Promise<void> {
    await this._post({ type: "Previous" });
    this._startAudio();
  }

  private async _onSeek(e: Event): Promise<void> {
    const songid = this._status.songid ?? "0";
    const time = (e.target as HTMLInputElement).value;
    await this._post({ type: "Seek", songid, time: parseFloat(time) });
    // HTTP streams are not seekable; reconnect so audio restarts from MPD's new position.
    this._startAudio();
  }

  private _onVolume(e: Event): void {
    // Volume is local only — does not affect the MPD server's output level.
    this._volume = parseInt((e.target as HTMLInputElement).value, 10) / 100;
    this._audio.volume = this._volume;
  }

  private async _notifyPlayer(): Promise<void> {
    // Send current MPD state to the MPRIS event bus; deduplicated by key.
    const s    = this._status;
    const tr   = this._currentsong;
    const key  = `${s.state ?? ""}:${tr.file}`;
    if (key === this._lastNotifyKey) return;
    this._lastNotifyKey = key;
    const mprisType = s.state === "play" ? "Play" : s.state === "pause" ? "Pause" : "Stop";
    try {
      await fetch("/api/player/command", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({
          type:     mprisType,
          service:  "mpd",
          track_id: tr.file,
          title:    tr.title   ?? tr.file,
          artist:   tr.artist  ?? "",
          album:    tr.album   ?? "",
          duration: parseFloat(tr.time ?? "0"),
          position: parseFloat(s.elapsed ?? "0"),
          volume:   this._volume,
        }),
      });
    } catch { /* backend unavailable */ }
  }

  private async _post(body: object): Promise<void> {
    try {
      await fetch("/api/mpd/command", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify(body),
      });
      await this._fetchStatus();
    } catch { /* backend unavailable */ }
  }

  private _setFormField(field: keyof ConnForm, value: string): void {
    this._form = { ...this._form, [field]: value };
  }

  // ---- helpers ----

  private _fmt(seconds: number): string {
    const m = String(Math.floor(seconds / 60)).padStart(2, "0");
    const s = String(Math.floor(seconds % 60)).padStart(2, "0");
    return `${m}:${s}`;
  }

  // ---- rendering ----

  override render() {
    const playing = this._status.state === "play";
    const active  = this._status.state === "play" || this._status.state === "pause";
    const elapsed  = parseFloat(this._status.elapsed  ?? "0");
    const duration = parseFloat(this._status.duration ?? this._currentsong.time ?? "0");
    const volumePct = Math.round(this._volume * 100);
    const canConnect = this._form.host.trim().length > 0;

    return html`
      <h3>${t("service.mpd")}</h3>

      <!-- connection strip -->
      <div class="conn-strip">
        <span class="badge ${this._connected ? "on" : "off"}">
          ${this._connected ? t("mpd.connected") : t("mpd.disconnected")}
        </span>
        ${this._connected ? html`
          <button @click=${() => { this._showForm = !this._showForm; }}>${t("mpd.edit")}</button>
          <button @click=${() => void this._disconnect()}>${t("mpd.disconnect")}</button>
        ` : html`
          <button @click=${() => { this._showForm = !this._showForm; }}>${t("mpd.connect")}</button>
        `}
      </div>

      <!-- connection form -->
      ${this._showForm ? html`
        <div class="conn-form">
          <h4>${t("mpd.connect")}</h4>
          <div class="fields">
            <label>
              ${t("mpd.host")}
              <input type="text" .value=${this._form.host}
                     @input=${(e: Event) => this._setFormField("host", (e.target as HTMLInputElement).value)} />
            </label>
            <label>
              ${t("mpd.port")}
              <input type="number" min="1" max="65535" .value=${this._form.port}
                     @input=${(e: Event) => this._setFormField("port", (e.target as HTMLInputElement).value)} />
            </label>
            <label style="grid-column: 1 / -1">
              ${t("mpd.password")}
              <input type="password" autocomplete="current-password" .value=${this._form.password}
                     @input=${(e: Event) => this._setFormField("password", (e.target as HTMLInputElement).value)} />
            </label>
            <label style="grid-column: 1 / -1">
              ${t("mpd.stream-url")}
              <input type="url" placeholder="http://server:8000/stream.mp3"
                     .value=${this._form.stream_url}
                     @input=${(e: Event) => this._setFormField("stream_url", (e.target as HTMLInputElement).value)} />
              <small>${t("mpd.stream-url-hint")}</small>
            </label>
          </div>
          <div class="form-actions">
            <button ?disabled=${!canConnect} @click=${() => void this._connect()}>
              ${this._connected ? t("mpd.reconnect") : t("mpd.connect")}
            </button>
            <button @click=${() => { this._showForm = false; }}>${t("mpd.cancel")}</button>
          </div>
        </div>
      ` : nothing}

      <!-- library toolbar (only when connected) -->
      ${this._connected ? html`
        <div class="toolbar">
          <button @click=${() => void this._fetchLibrary()}>${t("mpd.refresh")}</button>
          <input type="search" placeholder=${t("mpd.filter-placeholder")}
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
        ${(() => {
          if (this._library.length === 0) return html`<p class="empty">${t("mpd.no-tracks")}</p>`;
          const { tracks, matched } = this._displayLibrary();
          if (matched === 0) return html`<p class="empty">${t("mpd.no-match")}</p>`;
          return html`
            <p class="count">${matched} / ${this._library.length}
              ${tracks.length < matched ? html` — showing first ${tracks.length}` : nothing}
            </p>
            <table>
              <thead>
                <tr>
                  <th>${t("files.sort.title")}</th>
                  <th>${t("files.sort.artist")}</th>
                  <th>${t("files.sort.album")}</th>
                  <th class="time">—</th>
                </tr>
              </thead>
              <tbody>
                ${tracks.map((tr) => {
                  const isCurrent = tr.file === this._currentsong.file;
                  return html`
                    <tr class=${isCurrent && active ? "playing" : ""}
                        @click=${() => void this._playTrack(tr)}>
                      <td>${String(tr.title ?? tr.file)}</td>
                      <td>${String(tr.artist ?? "")}</td>
                      <td>${String(tr.album ?? "")}</td>
                      <td class="time">${tr.time ? this._fmt(parseFloat(String(tr.time))) : ""}</td>
                    </tr>
                  `;
                })}
              </tbody>
            </table>
          `;
        })()}

        <!-- audio stream error (only when a stream URL is set) -->
        ${this._audioError ? html`
          <div class="audio-error">${this._audioError}</div>
        ` : nothing}

        <!-- now-playing panel -->
        ${active ? html`
          <div class="now-playing">
            <div class="np-title">${t("files.now-playing")}: ${this._currentsong.title ?? this._currentsong.file}</div>
            <div class="np-sub">${this._currentsong.artist ?? ""} — ${this._currentsong.album ?? ""}</div>
            <input class="seek" type="range" min="0" max="${duration}"
                   .value=${live(elapsed)} @change=${this._onSeek} />
            <div class="ctrls">
              <button @click=${() => void this._prev()}>${t("player.prev")}</button>
              <button @click=${playing ? () => void this._pause() : () => void this._resume()}>
                ${playing ? t("player.pause") : t("player.play")}
              </button>
              <button @click=${() => void this._stop()}>${t("player.stop")}</button>
              <button @click=${() => void this._next()}>${t("player.next")}</button>
            </div>
            <div class="vol">
              <span>${t("player.volume")}</span>
              <input type="range" min="0" max="100"
                     .value=${live(volumePct)} @input=${this._onVolume} />
              <button @click=${this._toggleNormalize}
                      title=${this._normalizeBlocked ? t("player.normalize-blocked") : ""}
                      ?disabled=${this._normalizeBlocked}>
                ${this._normalizeBlocked
                  ? t("player.normalize-blocked")
                  : this._normalizeOn ? t("player.normalizing") : t("player.normalize")}
              </button>
            </div>
          </div>
        ` : nothing}
      ` : nothing}
    `;
  }
}
