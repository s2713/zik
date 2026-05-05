import { css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { getCsrfHeaders } from "../../csrf.js";
import { t } from "../../i18n/i18n.js";
import { VolumeNormalizer } from "../../audio/normalizer.js";
import { PlayerBase } from "../../player-base.js";

type SortKey = "title" | "artist" | "album" | "year";
const SORT_KEYS: SortKey[] = ["artist", "album", "title", "year"];

interface SubsonicTrack {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;  // seconds
  track?: number;
  year?: number;
}

interface ConnForm {
  server: string;
  user: string;
  password: string;
}

interface AuthInfo {
  server: string;
  user:   string;
  token:  string;
  salt:   string;
}

/**
 * Subsonic service player element.
 * Fetches library metadata from the backend; streams audio directly from the
 * Subsonic server using token+salt auth embedded in the <audio> src URL.
 * Supports proper seek, auto-advance, and local volume control.
 */
@customElement("subsonic-player")
export class SubsonicPlayerElement extends PlayerBase {
  static styles = css`
    :host { display: block; font-family: sans-serif; padding: 1rem; max-width: 700px; }
    h3 { margin: 0 0 0.5rem; }

    .conn-strip { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;
                  padding: 0.5rem; background: #f8f8f8; border-radius: 4px;
                  margin-bottom: 0.4rem; font-size: 0.88em; }
    .badge { font-size: 0.75em; padding: 0.1em 0.4em; border-radius: 3px; }
    .badge.on  { background: #d4edda; color: #155724; }
    .badge.off { background: #f8d7da; color: #721c24; }

    .conn-form { background: #f0f8ff; border: 1px solid #b8d4f0; border-radius: 4px;
                 padding: 0.75rem; margin-bottom: 0.75rem; }
    .conn-form h4 { margin: 0 0 0.5rem; font-size: 0.9em; }
    .conn-form .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem 0.75rem; }
    .conn-form label { display: flex; flex-direction: column; font-size: 0.82em; gap: 0.15rem; }
    .conn-form input { font-size: 0.9em; padding: 0.2em 0.3em;
                       border: 1px solid #bbb; border-radius: 3px; }
    .conn-form .form-actions { margin-top: 0.5rem; display: flex; gap: 0.4rem; }

    .toolbar { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;
               margin-bottom: 0.5rem; }
    .toolbar input[type="search"] { font-size: 0.88em; padding: 0.2em 0.4em;
                                    border: 1px solid #bbb; border-radius: 3px; width: 160px; }
    .sort-label { font-size: 0.85em; color: #555; }
    .count { font-size: 0.82em; color: #666; margin: 0 0 0.4rem; }

    table { width: 100%; border-collapse: collapse; font-size: 0.9em; margin-bottom: 1rem; }
    th { text-align: left; border-bottom: 2px solid #ccc; padding: 0.25rem 0.4rem;
         cursor: pointer; user-select: none; }
    th.active { color: #0057b8; }
    td { padding: 0.2rem 0.4rem; border-bottom: 1px solid #eee; }
    tr.playing td { background: #e8f4ff; font-weight: bold; }
    tr:hover td { background: #f5f5f5; cursor: pointer; }
    .empty { color: #888; font-size: 0.9em; margin: 1rem 0; }
    .time { font-size: 0.8em; color: #555; font-variant-numeric: tabular-nums; }

    .audio-error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb;
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

  @state() private _connected = false;
  @state() private _showForm  = false;
  @state() private _form: ConnForm = { server: "", user: "", password: "" };
  @state() private _auth: AuthInfo = { server: "", user: "", token: "", salt: "" };
  @state() private _library:  SubsonicTrack[] = [];
  @state() private _sort: SortKey = "artist";
  @state() private _filter = "";
  @state() private _playlist: SubsonicTrack[] = [];  // current display order
  @state() private _currentIndex = -1;
  @state() private _playing = false;
  @state() private _elapsed  = 0;
  @state() private _duration = 0;
  @state() private _volume           = 1.0;
  @state() private _audioError       = "";
  @state() private _normalizeOn      = false;
  @state() private _normalizeBlocked = false;

  // Hidden <audio> element; src is set to a Subsonic stream URL per track.
  private readonly _audio      = new Audio();
  private readonly _normalizer = new VolumeNormalizer();

  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();

    // Update seek bar and duration from audio events.
    this._audio.addEventListener("timeupdate", () => {
      this._elapsed  = this._audio.currentTime;
      this._duration = isFinite(this._audio.duration) ? this._audio.duration : 0;
    });
    this._audio.addEventListener("play",  () => { this._playing = true; });
    this._audio.addEventListener("pause", () => { this._playing = false; });

    // Auto-advance to the next track in the playlist when a track ends.
    this._audio.addEventListener("ended", () => { void this._playNext(); });

    this._audio.addEventListener("error", () => {
      const err = this._audio.error;
      this._audioError = err
        ? `Audio error ${err.code}: ${err.message}`
        : "Unknown audio error";
      this._playing = false;
    });

    void this._fetchStatus();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._stopPolling();
    this._audio.pause();
    this._audio.src = "";
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
      const r = await fetch("/api/subsonic/status");
      const data = await r.json() as {
        connected: boolean;
        server: string; user: string; token: string; salt: string;
      };
      this._connected = data.connected;
      if (data.connected) {
        // Keep auth and form in sync; skip form update while the user is editing.
        this._auth = { server: data.server, user: data.user, token: data.token, salt: data.salt };
        if (!this._showForm) {
          this._form = { server: data.server, user: data.user, password: this._form.password };
        }
        this._startPolling();
      } else {
        this._stopPolling();
      }
    } catch { /* backend unavailable */ }
  }

  // ---- connection ----

  private async _connect(): Promise<void> {
    if (!this._form.server || !this._form.user) return;
    try {
      const r = await fetch("/api/subsonic/connect", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify(this._form),
      });
      const data = await r.json() as { connected: boolean; server: string; user: string; token: string; salt: string };
      if (data.connected) {
        this._connected = true;
        this._auth = { server: data.server, user: data.user, token: data.token, salt: data.salt };
        this._showForm = false;
        this._startPolling();
        await this._fetchLibrary();
      }
    } catch { /* backend unavailable */ }
  }

  private async _disconnect(): Promise<void> {
    try {
      await fetch("/api/subsonic/disconnect", {
        method: "POST",
        headers: { ...getCsrfHeaders() },
      });
      this._connected = false;
      this._auth = { server: "", user: "", token: "", salt: "" };
      this._library = [];
      this._playlist = [];
      this._currentIndex = -1;
      this._stopPolling();
      this._audio.pause();
      this._audio.src = "";
    } catch { /* backend unavailable */ }
  }

  // ---- library ----

  private async _fetchLibrary(): Promise<void> {
    try {
      const r = await fetch("/api/subsonic/library");
      if (r.ok) this._library = await r.json() as SubsonicTrack[];
    } catch (err) {
      console.error("subsonic: library fetch failed", err);
    }
  }

  /** Build the display list (filtered + sorted, capped at 200). */
  private _buildDisplay(): { tracks: SubsonicTrack[]; matched: number } {
    const q = this._filter.trim().toLowerCase();
    const base = q
      ? this._library.filter((tr) =>
          String(tr.title  ?? "").toLowerCase().includes(q) ||
          String(tr.artist ?? "").toLowerCase().includes(q) ||
          String(tr.album  ?? "").toLowerCase().includes(q))
      : this._library;
    const matched = base.length;
    const sorted = [...base].sort((a, b) => {
      let va: string | number = String(a[this._sort] ?? "").toLowerCase();
      let vb: string | number = String(b[this._sort] ?? "").toLowerCase();
      if (this._sort === "year") { va = a.year ?? 0; vb = b.year ?? 0; }
      return va < vb ? -1 : va > vb ? 1 : 0;
    });
    return { tracks: sorted.slice(0, 200), matched };
  }

  // ---- stream URL ----

  private _streamUrl(songId: string): string {
    // Auth via token+salt: token = md5(password+salt), computed server-side.
    // The password never leaves the backend.
    const p = new URLSearchParams({
      id: songId,
      u: this._auth.user,
      t: this._auth.token,
      s: this._auth.salt,
      v: "1.16.1",
      c: "zik",
    });
    return `${this._auth.server}/rest/stream?${p.toString()}`;
  }

  // ---- playback ----

  private _playAt(index: number): void {
    if (index < 0 || index >= this._playlist.length) return;
    this._currentIndex = index;
    this._audioError = "";
    const track = this._playlist[index];
    this._audio.src = this._streamUrl(track.id);
    this._audio.volume = this._volume;
    void this._audio.play();
  }

  /** Called when user clicks a row; updates the playlist to the current display order. */
  private _playTrack(track: SubsonicTrack, playlist: SubsonicTrack[]): void {
    this._playlist = playlist;
    const idx = playlist.findIndex((t) => t.id === track.id);
    this._playAt(idx);
  }

  private _pause():  void { this._audio.pause(); }
  private _resume(): void { void this._audio.play(); }
  private _stop():   void { this._audio.pause(); this._audio.currentTime = 0; }

  private async _playNext(): Promise<void> {
    this._playAt(this._currentIndex + 1);
  }

  private _playPrev(): void {
    // If more than 3 s in, restart the current track; otherwise go back.
    if (this._audio.currentTime > 3) {
      this._audio.currentTime = 0;
    } else {
      this._playAt(this._currentIndex - 1);
    }
  }

  private _onSeek(e: Event): void {
    // Unlike MPD HTTP streams, Subsonic serves real files — seek works natively.
    this._audio.currentTime = parseFloat((e.target as HTMLInputElement).value);
  }

  private _onVolume(e: Event): void {
    this._volume = parseInt((e.target as HTMLInputElement).value, 10) / 100;
    this._audio.volume = this._volume;
  }

  private _setFormField(field: keyof ConnForm, value: string): void {
    this._form = { ...this._form, [field]: value };
  }

  // ---- helpers ----

  private _fmt(seconds: number): string {
    if (!seconds || !isFinite(seconds)) return "--:--";
    const m = String(Math.floor(seconds / 60)).padStart(2, "0");
    const s = String(Math.floor(seconds % 60)).padStart(2, "0");
    return `${m}:${s}`;
  }

  // ---- rendering ----

  override render() {
    const { tracks, matched } = this._buildDisplay();
    const canConnect = this._form.server.trim().length > 0 && this._form.user.trim().length > 0;
    const current    = this._currentIndex >= 0 ? this._playlist[this._currentIndex] : null;
    const volumePct  = Math.round(this._volume * 100);

    return html`
      <h3>${t("service.subsonic")}</h3>

      <!-- connection strip -->
      <div class="conn-strip">
        <span class="badge ${this._connected ? "on" : "off"}">
          ${this._connected ? t("subsonic.connected") : t("subsonic.disconnected")}
        </span>
        ${this._connected ? html`
          <button @click=${() => { this._showForm = !this._showForm; }}>${t("subsonic.edit")}</button>
          <button @click=${() => void this._disconnect()}>${t("subsonic.disconnect")}</button>
        ` : html`
          <button @click=${() => { this._showForm = !this._showForm; }}>${t("subsonic.connect")}</button>
        `}
      </div>

      <!-- connection form -->
      ${this._showForm ? html`
        <div class="conn-form">
          <h4>${this._connected ? t("subsonic.edit") : t("subsonic.connect")}</h4>
          <div class="fields">
            <label style="grid-column: 1 / -1">
              ${t("subsonic.server")}
              <input type="url" placeholder="http://navidrome.local:4533"
                     .value=${this._form.server}
                     @input=${(e: Event) => this._setFormField("server", (e.target as HTMLInputElement).value)} />
            </label>
            <label>
              ${t("subsonic.user")}
              <input type="text" autocomplete="username"
                     .value=${this._form.user}
                     @input=${(e: Event) => this._setFormField("user", (e.target as HTMLInputElement).value)} />
            </label>
            <label>
              ${t("subsonic.password")}
              <input type="password" autocomplete="current-password"
                     .value=${this._form.password}
                     @input=${(e: Event) => this._setFormField("password", (e.target as HTMLInputElement).value)} />
            </label>
          </div>
          <div class="form-actions">
            <button ?disabled=${!canConnect} @click=${() => void this._connect()}>
              ${this._connected ? t("subsonic.reconnect") : t("subsonic.connect")}
            </button>
            <button @click=${() => { this._showForm = false; }}>${t("subsonic.cancel")}</button>
          </div>
        </div>
      ` : nothing}

      <!-- library toolbar -->
      ${this._connected ? html`
        <div class="toolbar">
          <button @click=${() => void this._fetchLibrary()}>${t("subsonic.refresh")}</button>
          <input type="search" placeholder=${t("subsonic.filter-placeholder")}
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
          ? html`<p class="empty">${t("subsonic.no-tracks")}</p>`
          : matched === 0
            ? html`<p class="empty">${t("subsonic.no-match")}</p>`
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
                  ${tracks.map((tr) => {
                    const isCurrent = current?.id === tr.id;
                    return html`
                      <tr class=${isCurrent && this._playing ? "playing" : ""}
                          @click=${() => this._playTrack(tr, tracks)}>
                        <td>${String(tr.title ?? "")}</td>
                        <td>${String(tr.artist ?? "")}</td>
                        <td>${String(tr.album ?? "")}</td>
                        <td>${tr.year ?? ""}</td>
                        <td class="time">${this._fmt(tr.duration ?? 0)}</td>
                      </tr>
                    `;
                  })}
                </tbody>
              </table>
            `
        }

        <!-- audio error -->
        ${this._audioError ? html`
          <div class="audio-error">${this._audioError}</div>
        ` : nothing}

        <!-- now-playing panel -->
        ${current ? html`
          <div class="now-playing">
            <div class="np-title">${t("files.now-playing")}: ${current.title ?? current.id}</div>
            <div class="np-sub">${current.artist ?? ""} — ${current.album ?? ""}</div>
            <input class="seek" type="range" min="0" max=${this._duration || 1}
                   .value=${live(this._elapsed)}
                   @change=${this._onSeek} />
            <div class="np-sub time">${this._fmt(this._elapsed)} / ${this._fmt(this._duration)}</div>
            <div class="ctrls">
              <button @click=${() => this._playPrev()}>${t("player.prev")}</button>
              <button @click=${this._playing ? () => this._pause() : () => this._resume()}>
                ${this._playing ? t("player.pause") : t("player.play")}
              </button>
              <button @click=${() => this._stop()}>${t("player.stop")}</button>
              <button @click=${() => void this._playNext()}>${t("player.next")}</button>
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
