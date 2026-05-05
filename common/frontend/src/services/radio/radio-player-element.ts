import { css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { getCsrfHeaders } from "../../csrf.js";
import { t } from "../../i18n/i18n.js";
import { VolumeNormalizer } from "../../audio/normalizer.js";
import { PlayerBase } from "../../player-base.js";

type View = "somafm" | "search" | "favorites";

interface RadioStation {
  uuid?:    string;
  id?:      string;     // SomaFM id
  name:     string;
  url:      string;
  favicon?: string;
  image?:   string;
  tags?:    string;
  genre?:   string;
  country?: string;
  codec?:   string;
  bitrate?: number;
  votes?:   number;
  listeners?: number;
  source:   "radiobrowser" | "somafm";
  description?: string;
}

interface Tag {
  name:  string;
  count: number;
}

/**
 * Radio player element.
 * Proxies radio-browser.info (search + popular stations) and SomaFM
 * (curated channels) through the backend. Streams live audio via <audio>.
 * No seek or duration display — live streams are not seekable.
 */
@customElement("radio-player")
export class RadioPlayerElement extends PlayerBase {
  static styles = css`
    :host { display: block; font-family: sans-serif; padding: 1rem; max-width: 700px; }
    h3 { margin: 0 0 0.5rem; }

    .tabs { display: flex; gap: 0.25rem; margin-bottom: 0.75rem; }
    .tabs button { padding: 0.3rem 0.75rem; border: 1px solid #bbb; border-radius: 4px;
                   background: #f0f0f0; cursor: pointer; font-size: 0.88em; }
    .tabs button.active { background: #0057b8; color: #fff; border-color: #0057b8; }

    .search-row { display: flex; gap: 0.4rem; margin-bottom: 0.5rem; flex-wrap: wrap; }
    .search-row input { font-size: 0.88em; padding: 0.2em 0.4em; border: 1px solid #bbb;
                        border-radius: 3px; flex: 1; min-width: 150px; }

    .tags { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-bottom: 0.5rem; }
    .tag  { font-size: 0.78em; padding: 0.1em 0.5em; background: #e8e8e8;
            border-radius: 10px; cursor: pointer; border: 1px solid #ccc; }
    .tag:hover { background: #d0d8ff; border-color: #7090ff; }

    .station-list { margin-bottom: 0.5rem; }
    .station-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0.4rem;
                   border-bottom: 1px solid #eee; cursor: pointer; }
    .station-row:hover { background: #f5f5f5; }
    .station-row.playing { background: #e8f4ff; font-weight: bold; }
    .favicon { width: 20px; height: 20px; border-radius: 2px; object-fit: contain;
               flex-shrink: 0; }
    .favicon-placeholder { width: 20px; height: 20px; flex-shrink: 0;
                           background: #ddd; border-radius: 2px; }
    .somafm-art { width: 40px; height: 40px; border-radius: 3px; object-fit: cover;
                  flex-shrink: 0; }
    .station-info { flex: 1; min-width: 0; }
    .station-name { font-size: 0.9em; white-space: nowrap; overflow: hidden;
                    text-overflow: ellipsis; }
    .station-meta { font-size: 0.75em; color: #666; }
    .fav-btn { font-size: 1em; background: none; border: none; cursor: pointer;
               padding: 0.1em 0.3em; color: #aaa; }
    .fav-btn.active { color: #e8a000; }

    .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb;
             border-radius: 4px; padding: 0.4rem 0.6rem; font-size: 0.85em;
             margin-bottom: 0.5rem; }
    .empty { color: #888; font-size: 0.9em; margin: 1rem 0; }

    .now-playing { border-top: 2px solid #1db954; padding-top: 0.75rem; margin-top: 0.5rem; }
    .np-title { font-weight: bold; font-size: 0.95em; margin-bottom: 0.1rem; }
    .np-meta  { font-size: 0.8em; color: #555; margin-bottom: 0.4rem; }
    .ctrls    { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .vol      { display: flex; align-items: center; gap: 0.5rem; }
    .vol input { width: 120px; }
    .live-badge { font-size: 0.72em; background: #c00; color: #fff;
                  padding: 0.1em 0.4em; border-radius: 3px; }
  `;

  @state() private _view: View = "somafm";
  @state() private _somafm:   RadioStation[] = [];
  @state() private _tags:     Tag[] = [];
  @state() private _results:  RadioStation[] = [];
  @state() private _favorites: RadioStation[] = [];
  @state() private _query     = "";
  @state() private _searching = false;
  @state() private _loading   = false;
  @state() private _audioError       = "";
  @state() private _current: RadioStation | null = null;
  @state() private _playing          = false;
  @state() private _volume           = 1.0;
  @state() private _normalizeOn      = false;
  @state() private _normalizeBlocked = false;

  private readonly _audio      = new Audio();
  private readonly _normalizer = new VolumeNormalizer();

  override connectedCallback(): void {
    super.connectedCallback();
    this._audio.addEventListener("play",  () => { this._playing = true;  void this._notifyPlayer("Play");  });
    this._audio.addEventListener("pause", () => { this._playing = false; void this._notifyPlayer("Pause"); });
    this._audio.addEventListener("error", () => {
      const err      = this._audio.error;
      this._audioError = err ? `Audio error ${err.code}: ${err.message}` : "Unknown audio error";
      this._playing  = false;
    });
    void this._fetchSomafm();
    void this._fetchFavorites();
    void this._fetchTags();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
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

  // ---- data fetching ----

  private async _fetchSomafm(): Promise<void> {
    this._loading = true;
    try {
      const r = await fetch("/api/radio/somafm");
      if (r.ok) this._somafm = await r.json() as RadioStation[];
    } catch { /* backend unavailable */ }
    finally { this._loading = false; }
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
    try {
      const r = await fetch(`/api/radio/search?${params.toString()}`);
      if (r.ok) this._results = await r.json() as RadioStation[];
    } catch { /* backend unavailable */ }
    finally { this._searching = false; this._view = "search"; }
  }

  private async _loadPopular(): Promise<void> {
    this._searching = true;
    this._results   = [];
    try {
      const r = await fetch("/api/radio/popular");
      if (r.ok) this._results = await r.json() as RadioStation[];
    } catch { /* backend unavailable */ }
    finally { this._searching = false; this._view = "search"; }
  }

  // ---- playback ----

  private async _playStation(station: RadioStation): Promise<void> {
    this._audioError = "";
    let url = station.url;
    // For radio-browser stations, register the click and get the resolved URL.
    if (station.source === "radiobrowser" && station.uuid) {
      try {
        const r = await fetch(`/api/radio/resolve/${station.uuid}`);
        if (r.ok) {
          const data = await r.json() as { url: string };
          if (data.url) url = data.url;
        }
      } catch { /* use url as-is */ }
    }
    this._current   = { ...station, url };
    this._audio.src = url;
    this._audio.volume = this._volume;
    void this._audio.play();
  }

  private _onVolume(e: Event): void {
    this._volume = parseInt((e.target as HTMLInputElement).value, 10) / 100;
    this._audio.volume = this._volume;
  }

  private async _notifyPlayer(type: string): Promise<void> {
    // Post current playback state to backend for MPRIS bridge. Radio has no duration/position.
    const st = this._current;
    if (!st) return;
    try {
      await fetch("/api/player/command", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({
          type,
          service:  "radio",
          track_id: st.uuid ?? st.id ?? st.url,
          title:    st.name,
          artist:   "",
          album:    "",
          art_url:  st.image ?? st.favicon ?? "",
          duration: 0,
          position: 0,
          volume:   this._volume,
        }),
      });
    } catch { /* backend unavailable */ }
  }

  // ---- favorites ----

  private _isFavorite(station: RadioStation): boolean {
    const key = station.uuid || station.url;
    return this._favorites.some((f) => (f.uuid || f.url) === key);
  }

  private async _toggleFavorite(station: RadioStation, e: Event): Promise<void> {
    e.stopPropagation();
    if (this._isFavorite(station)) {
      await fetch("/api/radio/favorites/remove", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({ uuid: station.uuid, url: station.url }),
      });
    } else {
      await fetch("/api/radio/favorites", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({ station }),
      });
    }
    await this._fetchFavorites();
  }

  // ---- station row rendering ----

  private _stationRow(station: RadioStation, showArt = false) {
    const isPlaying = this._current?.url === station.url && this._playing;
    const isFav     = this._isFavorite(station);
    const artUrl    = showArt ? station.image : station.favicon;
    const meta = [
      station.country,
      station.genre || station.tags?.split(",")[0],
      station.codec  ? `${station.codec}` : "",
      station.bitrate ? `${station.bitrate} kbps` : "",
      station.listeners != null ? `${station.listeners} listeners` : "",
    ].filter(Boolean).join(" · ");

    return html`
      <div class="station-row ${isPlaying ? "playing" : ""}"
           @click=${() => void this._playStation(station)}>
        ${artUrl
          ? html`<img class="${showArt ? "somafm-art" : "favicon"}" src=${artUrl} alt="" loading="lazy" />`
          : html`<div class="${showArt ? "somafm-art" : "favicon-placeholder"}"></div>`}
        <div class="station-info">
          <div class="station-name">${station.name}</div>
          ${meta ? html`<div class="station-meta">${meta}</div>` : nothing}
        </div>
        <button class="fav-btn ${isFav ? "active" : ""}"
                title=${isFav ? t("radio.unfavorite") : t("radio.favorite")}
                @click=${(e: Event) => void this._toggleFavorite(station, e)}>★</button>
      </div>
    `;
  }

  // ---- rendering ----

  override render() {

    return html`
      <h3>${t("service.radio")}</h3>

      <!-- view tabs -->
      <div class="tabs">
        <button class=${this._view === "somafm"    ? "active" : ""}
                @click=${() => { this._view = "somafm"; }}>SomaFM</button>
        <button class=${this._view === "search"    ? "active" : ""}
                @click=${() => { this._view = "search"; }}>
          ${t("radio.search")}</button>
        <button class=${this._view === "favorites" ? "active" : ""}
                @click=${() => { this._view = "favorites"; }}>
          ★ ${t("radio.favorites")}</button>
      </div>

      <!-- SomaFM tab -->
      ${this._view === "somafm" ? html`
        ${this._loading
          ? html`<p class="empty">${t("radio.loading")}</p>`
          : this._somafm.length === 0
            ? html`<p class="empty">${t("radio.no-somafm")}</p>`
            : html`
              <div class="station-list">
                ${this._somafm.map((ch) => this._stationRow(ch, true))}
              </div>
            `}
      ` : nothing}

      <!-- Search tab -->
      ${this._view === "search" ? html`
        <div class="search-row">
          <input type="search" placeholder=${t("radio.search-placeholder")}
                 .value=${this._query}
                 @input=${(e: Event) => { this._query = (e.target as HTMLInputElement).value; }}
                 @keydown=${(e: KeyboardEvent) => {
                   if (e.key === "Enter") void this._search(this._query);
                 }} />
          <button ?disabled=${!this._query.trim() || this._searching}
                  @click=${() => void this._search(this._query)}>
            ${t("radio.search")}
          </button>
          <button @click=${() => void this._loadPopular()}>
            ${t("radio.popular")}
          </button>
        </div>
        <!-- popular genre tags -->
        ${this._tags.length > 0 ? html`
          <div class="tags">
            ${this._tags.slice(0, 20).map((tag) => html`
              <span class="tag" @click=${() => void this._search("", tag.name)}>
                ${tag.name}
              </span>
            `)}
          </div>
        ` : nothing}
        ${this._searching ? html`<p class="empty">${t("radio.loading")}</p>` : nothing}
        ${!this._searching && this._results.length === 0 && this._query
          ? html`<p class="empty">${t("radio.no-results")}</p>`
          : html`
            <div class="station-list">
              ${this._results.map((s) => this._stationRow(s))}
            </div>
          `}
      ` : nothing}

      <!-- Favorites tab -->
      ${this._view === "favorites" ? html`
        ${this._favorites.length === 0
          ? html`<p class="empty">${t("radio.no-favorites")}</p>`
          : html`
            <div class="station-list">
              ${this._favorites.map((s) => this._stationRow(s, s.source === "somafm"))}
            </div>
          `}
      ` : nothing}

      <!-- audio error -->
      ${this._audioError ? html`<div class="error">${this._audioError}</div>` : nothing}

      <!-- now-playing strip -->
      ${this._current ? html`
        <div class="now-playing">
          <div class="np-title">
            ${this._current.name}
            <span class="live-badge">${t("radio.live")}</span>
          </div>
          ${this._current.genre || this._current.tags
            ? html`<div class="np-meta">${this._current.genre || this._current.tags}</div>`
            : nothing}
          <div class="ctrls">
            <button @click=${this._playing
                ? () => this._audio.pause()
                : () => void this._audio.play()}>
              ${this._playing ? t("player.pause") : t("player.play")}
            </button>
            <button @click=${() => { this._audio.pause(); this._audio.src = ""; this._current = null; }}>
              ${t("player.stop")}
            </button>
            <div class="vol">
              <span>${t("player.volume")}</span>
              <input type="range" min="0" max="100"
                     .value=${live(Math.round(this._volume * 100))}
                     @input=${this._onVolume} />
              <button @click=${this._toggleNormalize}
                      title=${this._normalizeBlocked ? t("player.normalize-blocked") : ""}
                      ?disabled=${this._normalizeBlocked}>
                ${this._normalizeBlocked
                  ? t("player.normalize-blocked")
                  : this._normalizeOn ? t("player.normalizing") : t("player.normalize")}
              </button>
            </div>
          </div>
        </div>
      ` : nothing}
    `;
  }
}
