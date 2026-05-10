import { css, html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { getCsrfHeaders } from "../../csrf.js";
import { playerBus, type PlayerBusCmd, type SelectionStateEvent } from "../../player-bus.js";
import { PlayerBase } from "../../player-base.js";
import { queue } from "../../queue/queue-controller.js";
import type { QueueItem } from "../../queue/queue-item.js";
import "../../queue/queue-panel-element.js";

// ---- types ----

type SortCol = "title" | "artist" | "album" | "year";

interface SpotifyTrack {
  id:          string;
  uri:         string;
  title:       string;
  artist:      string;
  album:       string;
  duration_ms: number;
  year:        number;
  art_url?:    string;
}

interface SpotifyDevice {
  id:   string;
  name: string;
}

// ---- helper ----

/** Format milliseconds as m:ss. */
function fmtMs(ms: number): string {
  if (!ms || !isFinite(ms)) return "--:--";
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Spotify service player — two-panel layout matching Subsonic/Files.
 * Library is shown in the left search panel; the shared queue panel is on the right.
 * Playback is delegated to the backend + librespot; queue controller coordinates
 * cross-service sequencing via the playerBus "PlaySpotifyTrack" / "spotify-track-ended" protocol.
 */
@customElement("spotify-player")
export class SpotifyPlayerElement extends PlayerBase {
  static styles = css`
    :host {
      display: flex; flex-direction: column;
      height: calc(100vh - 56px - 76px);
      font-family: sans-serif; color: #f1f5f9; background: #0f172a;
      overflow: hidden;
    }

    /* ---- status bar ---- */
    .status-bar {
      flex-shrink: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem;
      padding: 0.4rem 1rem; background: #1e293b; border-bottom: 1px solid #334155;
      font-size: 0.85em;
    }
    .badge { font-size: 0.78em; padding: 0.15em 0.5em; border-radius: 3px; }
    .badge.on  { background: #14532d; color: #86efac; }
    .badge.off { background: #7f1d1d; color: #fca5a5; }
    .btn {
      padding: 0.3em 0.8em; border-radius: 4px; font-size: 0.88em; cursor: pointer;
      border: 1px solid #475569; background: #334155; color: #f1f5f9;
    }
    .btn:hover  { background: #475569; }
    .btn.primary { background: #1d4ed8; border-color: #3b82f6; }
    .btn.primary:hover { background: #2563eb; }

    /* ---- two-panel layout ---- */
    .panels { display: grid; grid-template-columns: 1fr 1fr; flex: 1; overflow: hidden; }
    @media (orientation: portrait) {
      .panels { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
    }
    queue-panel { display: flex; flex-direction: column; overflow: hidden; }

    /* ---- search panel (left) ---- */
    .search-panel {
      display: flex; flex-direction: column; overflow: hidden;
      border-right: 1px solid #334155;
    }

    .lib-header { flex-shrink: 0; background: #0f172a; border-bottom: 1px solid #334155; }
    /* title | artist | album | year | duration | actions */
    .lib-cols, .lib-search {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr 4em 4em 5.5em;
    }
    .lib-cols { border-bottom: 1px solid #1e293b; }
    .col-hd {
      padding: 0.3rem 0.4rem; font-size: 0.8em; font-weight: 600;
      color: #94a3b8; text-align: left;
      display: flex; align-items: center; gap: 0.25em;
      cursor: pointer; user-select: none;
    }
    .col-hd:hover { color: #f1f5f9; }
    .col-hd.sorted { color: #60a5fa; }
    .col-hd-dur { cursor: default; }
    .lib-search { padding: 0.25rem 0; gap: 0 0.25rem; align-items: center; }
    .lib-search input {
      font-size: 0.8em; padding: 0.2em 0.35em; margin: 0 0.25rem;
      border: 1px solid #334155; border-radius: 3px;
      background: #1e293b; color: #f1f5f9; width: calc(100% - 0.5rem);
    }
    .lib-search input::placeholder { color: #475569; }

    .lib-rows { flex: 1; overflow-y: auto; }
    .lib-row {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr 4em 4em 5.5em;
      border-bottom: 1px solid #1e293b; font-size: 0.85em;
    }
    .lib-row:hover    { background: #1e293b; }
    .lib-row.selected { background: rgba(96,165,250,0.12); }
    .lib-row.delegated { background: rgba(29,185,84,0.12); }  /* currently playing via queue */
    .lib-cell {
      padding: 0.25rem 0.4rem; overflow: hidden;
      white-space: nowrap; text-overflow: ellipsis;
    }
    .lib-cell.dur { color: #64748b; font-variant-numeric: tabular-nums; font-size: 0.9em; }
    .empty { padding: 1.5rem 1rem; color: #475569; font-size: 0.9em; }
    .lib-count { padding: 0.25rem 0.5rem; font-size: 0.75em; color: #475569; }

    /* action buttons on each library row */
    .lib-actions { display: flex; gap: 2px; align-items: center; padding: 0 0.2rem; flex-shrink: 0; }
    .act-btn {
      font-size: 0.82em; padding: 0.35em 0.55em;
      background: #334155; border: none; color: #f1f5f9;
      border-radius: 3px; cursor: pointer; line-height: 1;
    }
    .act-btn:hover { background: #475569; }
    .act-btn.play-now { background: #1d4ed8; }
    .act-btn.play-now:hover { background: #2563eb; }

    /* selection info in count bar */
    .sel-info { color: #7dd3fc; }
    .sel-clear {
      margin-left: 0.3em; font-size: 0.85em;
      background: none; border: none; color: #94a3b8; cursor: pointer; padding: 0;
    }
    .sel-clear:hover { color: #f1f5f9; }
  `;

  // ---- auth / status state ----
  @state() private _authed             = false;
  @state() private _librespotAvailable = false;
  @state() private _librespotRunning   = false;
  @state() private _librespotDevice    = "";
  @state() private _librespotError     = "";
  @state() private _deviceId           = "";
  @state() private _devices: SpotifyDevice[] = [];

  // ---- library state ----
  @state() private _library: SpotifyTrack[] = [];
  @state() private _sortCol: SortCol = "artist";
  @state() private _sortDir: 1 | -1  = 1;
  @state() private _fTitle  = "";
  @state() private _fArtist = "";
  @state() private _fAlbum  = "";
  @state() private _fYear   = "";

  // ---- library selection ----
  @state() private _selected: Set<string> = new Set();
  private _anchor: string | null = null;

  // ---- delegation tracking ----
  /** Spotify URI currently playing via queue delegation; drives the green row highlight. */
  @state() private _delegatedUri = "";
  /** True once Spotify confirmed playback of _delegatedUri has actually started. */
  private _delegatedStarted = false;

  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  // ---- bus handler ----

  private readonly _onBusCmd = (e: Event): void => {
    const cmd = (e as CustomEvent<PlayerBusCmd>).detail;
    switch (cmd.type) {
      case "PlaySpotifyTrack":
        void this._playDelegated(cmd.uri);
        break;
      case "Play":
        if ("serviceId" in cmd && cmd.serviceId === "spotify")
          void this._command("Play");  // resume without URIs — continue from paused position
        break;
      case "Pause":
      case "Stop":
        if ("serviceId" in cmd && cmd.serviceId === "spotify")
          void this._command("Pause");
        break;
      case "SetVolume":
        if ("serviceId" in cmd && cmd.serviceId === "spotify")
          void this._command("Volume", { percent: Math.round(cmd.volume * 100) });
        break;
    }
  };

  private readonly _onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this._selected.size > 0) {
      this._selected = new Set(); this._anchor = null;
      this._emitSelectionState();
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    playerBus.addEventListener("cmd", this._onBusCmd);
    document.addEventListener("keydown", this._onKeyDown);
    void this._fetchStatus();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    playerBus.removeEventListener("cmd", this._onBusCmd);
    document.removeEventListener("keydown", this._onKeyDown);
    this._stopPolling();
    playerBus.dispatchEvent(new CustomEvent<SelectionStateEvent>("selection-state", {
      detail: { items: [], source: "spotify" },
    }));
  }

  // ---- polling ----

  private _startPolling(): void {
    if (this._pollTimer !== null) return;
    this._pollTimer = setInterval(() => { void this._fetchStatus(); }, 2000);
  }

  private _stopPolling(): void {
    if (this._pollTimer !== null) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  private async _fetchStatus(): Promise<void> {
    try {
      const r = await fetch("/api/spotify/status");
      const data = await r.json() as {
        authed:               boolean;
        librespot_available:  boolean;
        librespot_running:    boolean;
        librespot_device?:    string;
        librespot_error?:     string;
        playing?:             boolean;
        device_id?:           string;
        track?:               { uri?: string } | null;
      };
      this._authed             = data.authed;
      this._librespotAvailable = data.librespot_available;
      this._librespotRunning   = data.librespot_running;
      this._librespotDevice    = data.librespot_device ?? "";
      this._librespotError     = data.librespot_error  ?? "";
      if (data.authed) {
        this._deviceId = data.device_id ?? "";
        this._checkDelegatedEnd(data.track?.uri ?? "", data.playing ?? false);
        this._startPolling();
      } else {
        this._stopPolling();
      }
    } catch { /* backend unavailable */ }
  }

  /**
   * Delegation end detection: wait until Spotify confirms the URI has started
   * playing, then watch for it to stop or change — that signals "track ended".
   */
  private _checkDelegatedEnd(currentUri: string, playing: boolean): void {
    if (!this._delegatedUri) return;
    if (!this._delegatedStarted) {
      if (playing && currentUri === this._delegatedUri) this._delegatedStarted = true;
      return;
    }
    if (!playing || currentUri !== this._delegatedUri) {
      playerBus.dispatchEvent(new CustomEvent("spotify-track-ended"));
      this._delegatedUri     = "";
      this._delegatedStarted = false;
    }
  }

  // ---- library ----

  private async _fetchLibrary(): Promise<void> {
    try {
      const r = await fetch("/api/spotify/library");
      if (r.ok) this._library = await r.json() as SpotifyTrack[];
    } catch (err) { console.error("spotify: library fetch failed", err); }
  }

  // ---- device resolution ----

  private async _fetchDevices(): Promise<void> {
    try {
      const r = await fetch("/api/spotify/devices");
      if (r.ok) this._devices = await r.json() as SpotifyDevice[];
    } catch { /* backend unavailable */ }
  }

  /** Fetch device list and return the librespot device ID (or "" if not found). */
  private async _resolveLibrespotDeviceId(): Promise<string> {
    await this._fetchDevices();
    return this._devices.find(d => d.name === this._librespotDevice)?.id ?? "";
  }

  // ---- commands ----

  private async _command(type: string, extra: Record<string, unknown> = {}): Promise<void> {
    try {
      await fetch("/api/spotify/command", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({ type, device_id: this._deviceId, ...extra }),
      });
      setTimeout(() => { void this._fetchStatus(); }, 300);
    } catch { /* backend unavailable */ }
  }

  /** Play a specific URI delegated by the queue controller. */
  private async _playDelegated(uri: string): Promise<void> {
    this._delegatedUri     = uri;
    this._delegatedStarted = false;
    // Librespot gets a new device ID on each restart — resolve fresh before playing.
    if (this._librespotRunning) {
      const id = await this._resolveLibrespotDeviceId();
      if (id) this._deviceId = id;
    }
    await this._command("Play", { uris: [uri] });
  }

  private async _disconnect(): Promise<void> {
    try {
      await fetch("/api/spotify/disconnect", { method: "POST", headers: { ...getCsrfHeaders() } });
      this._authed          = false;
      this._library         = [];
      this._devices         = [];
      this._delegatedUri    = "";
      this._delegatedStarted = false;
      this._stopPolling();
    } catch { /* backend unavailable */ }
  }

  private async _restartLibrespot(): Promise<void> {
    try {
      await fetch("/api/spotify/librespot/restart", { method: "POST", headers: { ...getCsrfHeaders() } });
    } catch { /* backend unavailable */ }
  }

  // ---- queue helpers ----

  /** audioUrl = Spotify URI — the queue controller never loads this as an HTTP stream. */
  private _toQueueItem(track: SpotifyTrack): QueueItem {
    return {
      serviceId: "spotify",
      trackId:   track.uri,
      audioUrl:  track.uri,
      title:     track.title,
      artist:    track.artist,
      album:     track.album,
      duration:  Math.round(track.duration_ms / 1000),
      artUrl:    track.art_url ?? "",
    };
  }

  private _emitSelectionState(): void {
    const items: QueueItem[] = this._library
      .filter(t => this._selected.has(t.uri))
      .map(t => this._toQueueItem(t));
    playerBus.dispatchEvent(new CustomEvent<SelectionStateEvent>("selection-state", {
      detail: { items, source: "spotify" },
    }));
  }

  // ---- filter / sort ----

  private _buildDisplay(): { tracks: SpotifyTrack[]; matched: number } {
    const q  = (v: string) => v.trim().toLowerCase();
    const ft = q(this._fTitle);
    const fa = q(this._fArtist);
    const fl = q(this._fAlbum);
    const fy = q(this._fYear);

    const base = this._library.filter((tr) => {
      if (ft && !tr.title.toLowerCase().includes(ft))  return false;
      if (fa && !tr.artist.toLowerCase().includes(fa)) return false;
      if (fl && !tr.album.toLowerCase().includes(fl))  return false;
      if (fy && !String(tr.year).includes(fy))         return false;
      return true;
    });

    const matched = base.length;
    const col = this._sortCol;
    const dir = this._sortDir;
    const sorted = [...base].sort((a, b) => {
      const va: string | number = col === "year" ? a.year : a[col].toLowerCase();
      const vb: string | number = col === "year" ? b.year : b[col].toLowerCase();
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
    return { tracks: sorted.slice(0, 500), matched };
  }

  private _setSort(col: SortCol): void {
    if (this._sortCol === col) this._sortDir = (this._sortDir === 1 ? -1 : 1) as 1 | -1;
    else { this._sortCol = col; this._sortDir = 1; }
  }

  // ---- selection / drag ----

  private _onTrackClick(e: MouseEvent, uri: string, orderedUris: string[]): void {
    if (e.shiftKey && this._anchor !== null) {
      const ai = orderedUris.indexOf(this._anchor);
      const ki = orderedUris.indexOf(uri);
      if (ai >= 0 && ki >= 0) {
        const lo = Math.min(ai, ki); const hi = Math.max(ai, ki);
        const s = new Set(this._selected);
        for (let i = lo; i <= hi; i++) s.add(orderedUris[i]);
        this._selected = s;
      }
    } else if (e.ctrlKey || e.metaKey) {
      const s = new Set(this._selected);
      if (s.has(uri)) s.delete(uri); else s.add(uri);
      this._selected = s;
      this._anchor = uri;
    } else {
      this._selected = new Set([uri]);
      this._anchor = uri;
    }
    this._emitSelectionState();
  }

  private _onSearchDragStart(e: DragEvent, track: SpotifyTrack): void {
    const isSel  = this._selected.has(track.uri);
    const tracks = isSel && this._selected.size > 0
      ? this._library.filter(t => this._selected.has(t.uri))
      : [track];
    e.dataTransfer!.effectAllowed = "copy";
    e.dataTransfer!.setData("queue-items-json", JSON.stringify(tracks.map(t => this._toQueueItem(t))));
  }

  // ---- rendering ----

  private _renderColHeader(col: SortCol, label: string): TemplateResult {
    const sorted = this._sortCol === col;
    const arrow  = sorted ? (this._sortDir === 1 ? " ↑" : " ↓") : "";
    return html`
      <div class="col-hd ${sorted ? "sorted" : ""}" @click=${() => this._setSort(col)}>
        ${label}${arrow}
      </div>
    `;
  }

  private _renderLibrary(): TemplateResult {
    if (!this._authed) {
      return html`<div class="empty">Connect your Spotify account to browse your library.</div>`;
    }
    if (this._library.length === 0) {
      return html`<div class="empty">Library is empty — click ↺ Refresh library.</div>`;
    }
    const { tracks, matched } = this._buildDisplay();
    const allUris = tracks.map(t => t.uri);
    const selInfo = this._selected.size > 0
      ? html` · <span class="sel-info">${this._selected.size} selected</span
          ><button class="sel-clear" @click=${() => { this._selected = new Set(); this._anchor = null; }}>✕</button>`
      : nothing;
    return html`
      ${matched < this._library.length
        ? html`<div class="lib-count">${matched} / ${this._library.length} tracks${tracks.length < matched ? ` — showing first ${tracks.length}` : ""}${selInfo}</div>`
        : html`<div class="lib-count">${matched} track${matched !== 1 ? "s" : ""}${selInfo}</div>`}
      ${tracks.map((tr) => {
        const isSel     = this._selected.has(tr.uri);
        const isDel     = tr.uri === this._delegatedUri;
        const effective = isSel && this._selected.size > 0
          ? this._library.filter(t => this._selected.has(t.uri))
          : [tr];
        return html`
          <div class="lib-row ${isSel ? "selected" : ""} ${isDel ? "delegated" : ""}"
               draggable="true"
               @click=${(e: MouseEvent) => this._onTrackClick(e, tr.uri, allUris)}
               @dragstart=${(e: DragEvent) => this._onSearchDragStart(e, tr)}>
            <div class="lib-cell">${tr.title}</div>
            <div class="lib-cell">${tr.artist}</div>
            <div class="lib-cell">${tr.album}</div>
            <div class="lib-cell">${tr.year || ""}</div>
            <div class="lib-cell dur">${fmtMs(tr.duration_ms)}</div>
            <div class="lib-actions">
              <button class="act-btn" title="Append to queue"
                      @click=${(e: Event) => { e.stopPropagation(); queue.add(effective.map(t => this._toQueueItem(t))); }}>+</button>
              <button class="act-btn" title="Play after current"
                      @click=${(e: Event) => { e.stopPropagation(); queue.insertNext(effective.map(t => this._toQueueItem(t))); }}>⏭</button>
              <button class="act-btn play-now" title="Play now"
                      @click=${(e: Event) => { e.stopPropagation(); queue.playNow(effective.map(t => this._toQueueItem(t))); }}>▶</button>
            </div>
          </div>
        `;
      })}
    `;
  }

  private _renderStatusBar(): TemplateResult {
    return html`
      <div class="status-bar">
        <span class="badge ${this._authed ? "on" : "off"}">
          ${this._authed ? "Spotify connected" : "Spotify not connected"}
        </span>
        ${this._authed ? html`
          ${this._librespotAvailable
            ? (this._librespotRunning
                ? html`<span class="badge on">librespot: ${this._librespotDevice}</span>`
                : html`<span class="badge off">librespot stopped</span>
                       <button class="btn" @click=${() => void this._restartLibrespot()}>Restart</button>`)
            : nothing}
          ${this._librespotError
            ? html`<span style="color:#f87171;font-size:0.82em">${this._librespotError}</span>`
            : nothing}
          <button class="btn" @click=${() => void this._fetchLibrary()}>↺ Refresh library</button>
          <button class="btn" @click=${() => void this._disconnect()}>Disconnect</button>
        ` : html`
          <button class="btn primary"
                  @click=${() => { window.location.href = "/api/spotify/auth/start"; }}>
            Connect Spotify
          </button>
        `}
      </div>
    `;
  }

  override render() {
    return html`
      ${this._renderStatusBar()}

      <div class="panels">
        <!-- left: library search -->
        <div class="search-panel">
          <div class="lib-header">
            <div class="lib-cols">
              ${this._renderColHeader("title",  "Title")}
              ${this._renderColHeader("artist", "Artist")}
              ${this._renderColHeader("album",  "Album")}
              ${this._renderColHeader("year",   "Year")}
              <div class="col-hd col-hd-dur">Duration</div>
              <div></div>
            </div>
            <div class="lib-search">
              <input placeholder="Title…"  .value=${live(this._fTitle)}
                     @input=${(e: Event) => { this._fTitle  = (e.target as HTMLInputElement).value; }} />
              <input placeholder="Artist…" .value=${live(this._fArtist)}
                     @input=${(e: Event) => { this._fArtist = (e.target as HTMLInputElement).value; }} />
              <input placeholder="Album…"  .value=${live(this._fAlbum)}
                     @input=${(e: Event) => { this._fAlbum  = (e.target as HTMLInputElement).value; }} />
              <input placeholder="Year…"   .value=${live(this._fYear)}
                     @input=${(e: Event) => { this._fYear   = (e.target as HTMLInputElement).value; }} />
              <div></div>
              <div></div>
            </div>
          </div>
          <div class="lib-rows">
            ${this._renderLibrary()}
          </div>
        </div>

        <!-- right: shared queue panel -->
        <queue-panel></queue-panel>
      </div>
    `;
  }
}
