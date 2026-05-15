import Hls from "hls.js";
import { css, html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";

import { getCsrfHeaders } from "../../csrf.js";
import { t } from "../../i18n/i18n.js";
import {
  type PlayerBusCmd,
  playerBus,
  type PlaylistStateEvent,
} from "../../player-bus.js";
import { PlayerBase } from "../../player-base.js";

// ---- types -------------------------------------------------------------------

type StreamFormat = "icy" | "hls" | "plain" | null;
type View = "somafm" | "search" | "favorites";

interface RadioStation {
  uuid?:        string;
  id?:          string;   // SomaFM id
  name:         string;
  url:          string;
  favicon?:     string;
  image?:       string;
  tags?:        string;
  genre?:       string;
  country?:     string;
  codec?:       string;
  bitrate?:     number;
  votes?:       number;
  listeners?:   number;
  source:       "radiobrowser" | "somafm";
  description?: string;
}

interface Tag {
  name:  string;
  count: number;
}

// ---- genre color palette -----------------------------------------------------
// Each entry is [keyword, background-color]; text is always white.

const _GENRE_COLORS: [string, string][] = [
  ["jazz",       "#1a4a6b"],
  ["blues",      "#0d3b5e"],
  ["rock",       "#6b1a1a"],
  ["metal",      "#3d0d0d"],
  ["electronic", "#1a1a6b"],
  ["techno",     "#12125e"],
  ["house",      "#2a0d5e"],
  ["classical",  "#2a4a2a"],
  ["ambient",    "#1a4a3a"],
  ["pop",        "#4a1a6b"],
  ["hip-hop",    "#1a3a6b"],
  ["r&b",        "#3a1a5e"],
  ["soul",       "#5e3a1a"],
  ["reggae",     "#1a5e1a"],
  ["world",      "#5e4a1a"],
  ["latin",      "#5e1a3a"],
  ["country",    "#5e4a0d"],
  ["folk",       "#3a4a0d"],
  ["punk",       "#5e1a0d"],
  ["indie",      "#2a3a5e"],
];
const _DEFAULT_GENRE_COLOR = "#2a3a3a";

function _genreColor(tag: string): string {
  const lc = tag.toLowerCase();
  const pair = _GENRE_COLORS.find(([k]) => lc.includes(k));
  return pair ? pair[1] : _DEFAULT_GENRE_COLOR;
}

// ---- helper ------------------------------------------------------------------

function _stationKey(s: RadioStation): string {
  return s.uuid ?? s.id ?? s.url;
}

/**
 * Radio player element.
 * Left panel: tabs (SomaFM / Search / Favorites) with search-as-you-type.
 * Right panel: currently-playing station info with LIVE badge and StreamTitle.
 * ICY streams are proxied through the backend; StreamTitle is polled every 5 s.
 * HLS streams are handled by hls.js (with native HLS as fallback).
 */
@customElement("radio-player")
export class RadioPlayerElement extends PlayerBase {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 56px - 76px);
      font-family: sans-serif;
      overflow: hidden;
      background: #0f172a;
      color: #f1f5f9;
    }

    /* ---- two-panel layout: equal halves ---- */
    .panels {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    .list-panel {
      flex: 1 1 50%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border-right: 1px solid #334155;
      min-width: 0;
    }
    .info-panel {
      flex: 1 1 50%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: #1e293b;
      min-width: 0;
    }
    /* Image wrapper: shrinks to 0 when no image, expands up to half the panel. */
    .info-img-wrap {
      flex: 0 1 50%;
      min-height: 0;
      overflow: hidden;
      padding: 1rem 1rem 0;
    }
    /* Text below the image: takes remaining space, scrolls if needed. */
    .info-text {
      flex: 1 1 0;
      min-height: 0;
      overflow-y: auto;
      padding: 0.75rem 1rem 1rem;
    }

    /* ---- tabs ---- */
    .tabs {
      display: flex;
      border-bottom: 1px solid #334155;
      flex-shrink: 0;
      background: #1e293b;
    }
    .tabs button {
      padding: 0.5rem 1rem;
      border: none;
      border-bottom: 2px solid transparent;
      background: none;
      cursor: pointer;
      font-size: 0.88em;
      color: #94a3b8;
    }
    .tabs button.active {
      border-bottom-color: #60a5fa;
      color: #f1f5f9;
      font-weight: 600;
    }
    .tabs button:hover:not(.active) { color: #cbd5e1; }

    /* ---- search / filter bar ---- */
    .search-bar {
      display: flex;
      gap: 0.4rem;
      padding: 0.5rem 0.6rem;
      flex-shrink: 0;
      border-bottom: 1px solid #334155;
      background: #1e293b;
      flex-wrap: wrap;
    }
    .search-bar input {
      font-size: 0.85em;
      padding: 0.25em 0.5em;
      border: 1px solid #475569;
      border-radius: 3px;
      background: #0f172a;
      color: #f1f5f9;
      flex: 1;
      min-width: 120px;
    }
    .search-bar input::placeholder { color: #64748b; }
    .search-bar button {
      font-size: 0.82em;
      padding: 0.25em 0.7em;
      border: 1px solid #475569;
      border-radius: 3px;
      background: #334155;
      color: #f1f5f9;
      cursor: pointer;
    }
    .search-bar button:hover:not(:disabled) { background: #475569; }
    .search-bar button:disabled { opacity: 0.45; cursor: default; }

    /* ---- genre tag cloud ---- */
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
      padding: 0.4rem 0.6rem;
      flex-shrink: 0;
      border-bottom: 1px solid #334155;
      background: #1e293b;
    }
    .tag {
      font-size: 0.78em;
      font-weight: 700;
      padding: 0.15em 0.6em;
      border-radius: 10px;
      cursor: pointer;
      color: #fff;
      border: none;
      background: var(--tag-bg, #334155);
    }
    .tag:hover { filter: brightness(1.3); }

    /* ---- station list ---- */
    .station-list {
      flex: 1;
      overflow-y: auto;
      background: #0f172a;
    }
    .station-row {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      padding: 0.4rem 0.6rem;
      border-bottom: 1px solid #1e293b;
      cursor: pointer;
      user-select: none;
    }
    .station-row:hover   { background: rgba(255,255,255,0.05); }
    .station-row.playing { background: rgba(96,165,250,0.12); }
    .favicon {
      width: 22px; height: 22px; margin-top: 0.1em;
      border-radius: 3px; object-fit: contain; flex-shrink: 0;
    }
    .favicon-ph {
      width: 22px; height: 22px; margin-top: 0.1em;
      background: #334155; border-radius: 3px; flex-shrink: 0;
    }
    .somafm-art {
      width: 40px; height: 40px;
      border-radius: 4px; object-fit: cover; flex-shrink: 0;
    }
    .sname { font-size: 0.88em; color: #f1f5f9; line-height: 1.3; }
    .smeta { font-size: 0.74em; color: #64748b; line-height: 1.3; margin-top: 0.1em; }
    .fav-btn {
      font-size: 1.1em; background: none; border: none;
      cursor: pointer; padding: 0 0.2em; color: #475569; flex-shrink: 0;
      margin-top: 0.05em;
    }
    .fav-btn:hover  { color: #94a3b8; }
    .fav-btn.active { color: #f5a623; }

    /* ---- info panel ---- */
    .info-art {
      width: 100%; height: 100%;
      border-radius: 6px; display: block;
      object-fit: contain; object-position: top center;
    }
    .info-name {
      font-size: 1rem; font-weight: 700; color: #f1f5f9; margin-bottom: 0.25rem;
      line-height: 1.3;
    }
    .live-badge {
      display: inline-block; font-size: 0.7em; background: #c00;
      color: #fff; padding: 0.1em 0.4em; border-radius: 3px;
      vertical-align: middle; margin-left: 0.4em;
    }
    .stream-title {
      font-size: 0.88em; font-style: italic; color: #cbd5e1;
      margin-bottom: 0.5rem; min-height: 1.2em; line-height: 1.4;
    }
    .info-desc {
      font-size: 0.82em; color: #94a3b8; margin-bottom: 0.5rem; line-height: 1.45;
    }
    .info-meta { font-size: 0.78em; color: #64748b; margin-bottom: 0.25rem; }
    .info-empty { color: #475569; font-size: 0.88em; margin-top: 2rem; text-align: center; }

    /* ---- misc ---- */
    .error {
      background: #450a0a; color: #fca5a5;
      border: 1px solid #7f1d1d; border-radius: 4px;
      padding: 0.4rem 0.6rem; font-size: 0.83em; margin: 0.5rem 0.6rem;
    }
    .loading { color: #64748b; font-size: 0.88em; padding: 0.5rem 0.6rem; }
    .empty   { color: #475569; font-size: 0.88em; padding: 0.5rem 0.6rem; }
  `;

  // ---- view state ----
  @state() private _view: View = "somafm";

  // ---- data ----
  @state() private _somafm:    RadioStation[] = [];
  @state() private _tags:      Tag[]          = [];
  @state() private _results:   RadioStation[] = [];
  @state() private _favorites: RadioStation[] = [];

  // ---- loading / error ----
  @state() private _loadingSoma = false;
  @state() private _searching   = false;
  @state() private _audioError  = "";

  // ---- search-as-you-type filters ----
  @state() private _filterSoma  = "";
  @state() private _filterFav   = "";
  @state() private _querySearch = "";

  // ---- playback ----
  @state() private _current:    RadioStation | null = null;
  @state() private _playing     = false;
  @state() private _format:     StreamFormat = null;
  @state() private _streamTitle = "";

  // Non-reactive internal state.
  private _metaTimer: ReturnType<typeof setInterval> | null = null;
  private _hlsInstance: Hls | null = null;

  private readonly _audio = new Audio();

  // ---- bus handler ----

  private readonly _onBusCmd = (e: Event): void => {
    const cmd = (e as CustomEvent<PlayerBusCmd>).detail;
    if (cmd.type === "PauseAll") { this._audio.pause(); return; }
    if (!("serviceId" in cmd) || cmd.serviceId !== "radio") return;
    switch (cmd.type) {
      case "Play":  void this._audio.play(); break;
      case "Pause": this._audio.pause();     break;
      case "Stop":  this._stopAudio();       break;
      default: break;
    }
  };

  // ---- lifecycle ----

  override connectedCallback(): void {
    super.connectedCallback();
    playerBus.addEventListener("cmd", this._onBusCmd);
    this._audio.addEventListener("play",  () => {
      this._playing = true;
      this._emitPlaylistState();
      void this._notifyPlayer("Play");
    });
    this._audio.addEventListener("pause", () => {
      this._playing = false;
      this._emitPlaylistState();
      void this._notifyPlayer("Pause");
    });
    this._audio.addEventListener("error", () => {
      const err = this._audio.error;
      this._audioError = err ? `Audio error ${err.code}` : "Unknown audio error";
      this._playing = false;
      this._emitPlaylistState();
    });
    void this._fetchSomafm();
    void this._fetchFavorites();
    void this._fetchTags();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    playerBus.removeEventListener("cmd", this._onBusCmd);
    this._stopAudio();
  }

  // ---- playlist-state emission ----

  private _emitPlaylistState(): void {
    // Lets the footer transport know radio is active without waiting for backend poll.
    const status: PlaylistStateEvent["status"] =
      this._playing ? "playing" : this._current ? "paused" : "stopped";
    playerBus.dispatchEvent(new CustomEvent<PlaylistStateEvent>("playlist-state", {
      detail: {
        serviceId:     "radio",
        status,
        index:         -1,
        total:         0,
        totalDuration: 0,
        position:      0,
        duration:      0,
      },
    }));
  }

  // ---- data fetching ----

  private async _fetchSomafm(): Promise<void> {
    this._loadingSoma = true;
    try {
      const r = await fetch("/api/radio/somafm");
      if (r.ok) this._somafm = await r.json() as RadioStation[];
    } catch { /* backend unavailable */ }
    finally { this._loadingSoma = false; }
  }

  private async _fetchTags(): Promise<void> {
    try {
      const r = await fetch("/api/radio/tags");
      if (r.ok) this._tags = await r.json() as Tag[];
    } catch { /* backend unavailable */ }
  }

  private async _fetchFavorites(): Promise<void> {
    try {
      const r = await fetch("/api/radio/favorites");
      if (r.ok) this._favorites = await r.json() as RadioStation[];
    } catch { /* backend unavailable */ }
  }

  private async _search(q?: string, tag?: string): Promise<void> {
    const params = new URLSearchParams();
    if (q)   params.set("q",   q);
    if (tag) params.set("tag", tag);
    this._searching = true;
    this._results   = [];
    this._view      = "search";
    try {
      const r = await fetch(`/api/radio/search?${params.toString()}`);
      if (r.ok) this._results = await r.json() as RadioStation[];
    } catch { /* backend unavailable */ }
    finally { this._searching = false; }
  }

  private async _loadPopular(): Promise<void> {
    this._searching = true;
    this._results   = [];
    this._view      = "search";
    try {
      const r = await fetch("/api/radio/popular");
      if (r.ok) this._results = await r.json() as RadioStation[];
    } catch { /* backend unavailable */ }
    finally { this._searching = false; }
  }

  // ---- playback ----

  private async _probe(url: string): Promise<StreamFormat> {
    try {
      const r = await fetch(`/api/radio/probe?url=${encodeURIComponent(url)}`);
      if (r.ok) {
        const d = await r.json() as { format: string };
        if (d.format === "icy" || d.format === "hls") return d.format as StreamFormat;
      }
    } catch { /* fallback */ }
    return "plain";
  }

  private _stopMeta(): void {
    if (this._metaTimer !== null) {
      clearInterval(this._metaTimer);
      this._metaTimer = null;
    }
    if (this._hlsInstance) {
      this._hlsInstance.destroy();
      this._hlsInstance = null;
    }
  }

  private _startMetaPoll(rawUrl: string): void {
    // Poll backend every 5 s for the latest ICY StreamTitle.
    const encoded = encodeURIComponent(rawUrl);
    this._metaTimer = setInterval(async () => {
      try {
        const r = await fetch(`/api/radio/metadata?url=${encoded}`);
        if (r.ok) {
          const d = await r.json() as { title: string };
          if (d.title && d.title !== this._streamTitle) {
            this._streamTitle = d.title;
            void this._notifyPlayer("Play");
          }
        }
      } catch { /* ignore */ }
    }, 5000);
  }

  private _stopAudio(): void {
    this._stopMeta();
    this._audio.pause();
    this._audio.src   = "";
    this._streamTitle  = "";
    this._current      = null;
    this._playing      = false;
    this._format       = null;
    this._emitPlaylistState();
  }

  private async _playStation(station: RadioStation): Promise<void> {
    this._audioError = "";
    this._stopMeta();

    let url = station.url;
    // Register radio-browser click and get the resolved stream URL.
    if (station.source === "radiobrowser" && station.uuid) {
      try {
        const r = await fetch(`/api/radio/resolve/${station.uuid}`);
        if (r.ok) {
          const d = await r.json() as { url: string };
          if (d.url) url = d.url;
        }
      } catch { /* use url as-is */ }
    }

    this._current     = { ...station, url };
    this._streamTitle = "";
    this._format      = await this._probe(url);

    this._audio.pause();
    this._audio.src = "";

    if (this._format === "hls") {
      if (Hls.isSupported()) {
        this._hlsInstance = new Hls();
        this._hlsInstance.loadSource(url);
        this._hlsInstance.attachMedia(this._audio);
        this._hlsInstance.once(Hls.Events.MANIFEST_PARSED, () => { void this._audio.play(); });
      } else {
        // Safari has native HLS support via MSE.
        this._audio.src = url;
        void this._audio.play();
      }
    } else if (this._format === "icy") {
      // Backend proxy strips ICY metadata blocks; poll for StreamTitle separately.
      this._audio.src = `/api/radio/stream?url=${encodeURIComponent(url)}`;
      void this._audio.play();
      this._startMetaPoll(url);
    } else {
      this._audio.src = url;
      void this._audio.play();
    }
  }

  private async _notifyPlayer(type: string): Promise<void> {
    const st = this._current;
    if (!st) return;
    // Include StreamTitle in the title so it appears in the footer.
    const title = this._streamTitle ? `${st.name} — ${this._streamTitle}` : st.name;
    try {
      await fetch("/api/player/command", {
        method:  "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({
          type,
          service:  "radio",
          track_id: st.uuid ?? st.id ?? st.url,
          title,
          artist:   "",
          album:    "",
          art_url:  st.image ?? st.favicon ?? "",
          duration: 0,
          position: 0,
          volume:   1.0,
        }),
      });
    } catch { /* backend unavailable */ }
  }

  // ---- favorites ----

  private _isFavorite(station: RadioStation): boolean {
    const key = _stationKey(station);
    return this._favorites.some((f) => _stationKey(f) === key);
  }

  private async _toggleFavorite(station: RadioStation, e: Event): Promise<void> {
    e.stopPropagation();
    if (this._isFavorite(station)) {
      await fetch("/api/radio/favorites/remove", {
        method:  "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({ uuid: station.uuid, url: station.url }),
      });
    } else {
      await fetch("/api/radio/favorites", {
        method:  "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({ station }),
      });
    }
    await this._fetchFavorites();
  }

  // ---- station row rendering ----

  private _stationRow(station: RadioStation, showArt = false): TemplateResult {
    const isPlaying = this._current?.url === station.url && this._playing;
    const isFav     = this._isFavorite(station);
    const artUrl    = showArt ? (station.image ?? station.favicon) : station.favicon;
    const meta = [
      station.country,
      station.genre ?? station.tags?.split(",")[0],
      station.codec  ? station.codec          : "",
      station.bitrate ? `${station.bitrate} kbps` : "",
      station.listeners != null ? `${station.listeners} listeners` : "",
    ].filter(Boolean).join(" · ");

    return html`
      <div class="station-row ${isPlaying ? "playing" : ""}"
           @click=${() => void this._playStation(station)}>
        ${artUrl
          ? html`<img class="${showArt ? "somafm-art" : "favicon"}" src=${artUrl} alt="" loading="lazy" />`
          : html`<div class="${showArt ? "somafm-art" : "favicon-ph"}"></div>`}
        <div style="flex:1;min-width:0">
          <div class="sname">${station.name}</div>
          ${meta ? html`<div class="smeta">${meta}</div>` : nothing}
        </div>
        <button class="fav-btn ${isFav ? "active" : ""}"
                title=${isFav ? t("radio.unfavorite") : t("radio.favorite")}
                @click=${(e: Event) => void this._toggleFavorite(station, e)}>★</button>
      </div>
    `;
  }

  // ---- info panel ----

  private _renderInfoPanel(): TemplateResult {
    if (!this._current) {
      return html`<div class="info-text info-empty">${t("radio.select-station")}</div>`;
    }
    const st     = this._current;
    const artUrl = st.image ?? st.favicon;
    const genre  = st.genre ?? st.tags?.split(",")[0] ?? "";
    const meta   = [
      st.country,
      st.codec,
      st.bitrate ? `${st.bitrate} kbps` : "",
    ].filter(Boolean).join(" · ");

    // Image in its own flex wrapper (flex: 0 1 50%) so it never exceeds half the panel.
    // Text in a separate scrollable section below.
    return html`
      ${artUrl
        ? html`<div class="info-img-wrap"><img class="info-art" src=${artUrl} alt="" /></div>`
        : nothing}
      <div class="info-text">
        <div class="info-name">
          ${st.name}
          ${this._playing ? html`<span class="live-badge">LIVE</span>` : nothing}
        </div>
        ${this._streamTitle
          ? html`<div class="stream-title">${this._streamTitle}</div>`
          : nothing}
        ${st.description ? html`<div class="info-desc">${st.description}</div>` : nothing}
        ${genre ? html`<div class="info-meta">${genre}</div>` : nothing}
        ${meta  ? html`<div class="info-meta">${meta}</div>`  : nothing}
        ${this._format
          ? html`<div class="info-meta" style="opacity:.55">${this._format.toUpperCase()}</div>`
          : nothing}
        ${this._audioError ? html`<div class="error">${this._audioError}</div>` : nothing}
      </div>
    `;
  }

  // ---- filtered list helpers ----

  private _filteredSomafm(): RadioStation[] {
    const q = this._filterSoma.toLowerCase();
    if (!q) return this._somafm;
    return this._somafm.filter(
      (s) => s.name.toLowerCase().includes(q) ||
             (s.genre ?? "").toLowerCase().includes(q) ||
             (s.description ?? "").toLowerCase().includes(q),
    );
  }

  private _filteredFavorites(): RadioStation[] {
    const q = this._filterFav.toLowerCase();
    if (!q) return this._favorites;
    return this._favorites.filter(
      (s) => s.name.toLowerCase().includes(q) ||
             (s.genre ?? s.tags ?? "").toLowerCase().includes(q),
    );
  }

  // ---- render ----

  override render(): TemplateResult {
    return html`
      <div class="panels">

        <!-- left: station list with tabs -->
        <div class="list-panel">

          <div class="tabs">
            <button class=${this._view === "somafm"    ? "active" : ""}
                    @click=${() => { this._view = "somafm"; }}>SomaFM</button>
            <button class=${this._view === "search"    ? "active" : ""}
                    @click=${() => { this._view = "search"; }}>${t("radio.search")}</button>
            <button class=${this._view === "favorites" ? "active" : ""}
                    @click=${() => { this._view = "favorites"; }}>★ ${t("radio.favorites")}</button>
          </div>

          ${this._view === "somafm" ? html`
            <div class="search-bar">
              <input type="search"
                     placeholder=${t("radio.filter-placeholder")}
                     .value=${this._filterSoma}
                     @input=${(e: Event) => { this._filterSoma = (e.target as HTMLInputElement).value; }} />
            </div>
            ${this._loadingSoma
              ? html`<p class="loading">${t("radio.loading")}</p>`
              : html`
                <div class="station-list">
                  ${this._filteredSomafm().length === 0
                    ? html`<p class="empty">${t("radio.no-results")}</p>`
                    : this._filteredSomafm().map((ch) => this._stationRow(ch, true))}
                </div>
              `}
          ` : nothing}

          ${this._view === "search" ? html`
            <div class="search-bar">
              <input type="search"
                     placeholder=${t("radio.search-placeholder")}
                     .value=${this._querySearch}
                     @input=${(e: Event) => { this._querySearch = (e.target as HTMLInputElement).value; }}
                     @keydown=${(e: KeyboardEvent) => {
                       if (e.key === "Enter") void this._search(this._querySearch);
                     }} />
              <button ?disabled=${!this._querySearch.trim() || this._searching}
                      @click=${() => void this._search(this._querySearch)}>
                ${t("radio.search")}
              </button>
              <button @click=${() => void this._loadPopular()}>
                ${t("radio.popular")}
              </button>
            </div>
            ${this._tags.length > 0 ? html`
              <div class="tags">
                ${this._tags.slice(0, 24).map((tag) => html`
                  <button class="tag"
                          style="--tag-bg:${_genreColor(tag.name)}"
                          @click=${() => void this._search("", tag.name)}>
                    ${tag.name}
                  </button>
                `)}
              </div>
            ` : nothing}
            ${this._searching ? html`<p class="loading">${t("radio.loading")}</p>` : nothing}
            <div class="station-list">
              ${!this._searching && this._results.length === 0
                ? html`<p class="empty">${this._querySearch ? t("radio.no-results") : ""}</p>`
                : this._results.map((s) => this._stationRow(s))}
            </div>
          ` : nothing}

          ${this._view === "favorites" ? html`
            <div class="search-bar">
              <input type="search"
                     placeholder=${t("radio.filter-placeholder")}
                     .value=${this._filterFav}
                     @input=${(e: Event) => { this._filterFav = (e.target as HTMLInputElement).value; }} />
            </div>
            <div class="station-list">
              ${this._filteredFavorites().length === 0
                ? html`<p class="empty">${t("radio.no-favorites")}</p>`
                : this._filteredFavorites().map((s) => this._stationRow(s, s.source === "somafm"))}
            </div>
          ` : nothing}

        </div>

        <!-- right: station info -->
        <div class="info-panel">
          ${this._renderInfoPanel()}
        </div>

      </div>
    `;
  }
}
