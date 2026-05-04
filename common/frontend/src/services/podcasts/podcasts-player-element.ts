import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { getCsrfHeaders } from "../../csrf.js";
import { t } from "../../i18n/i18n.js";

interface PodcastFeed {
  url:    string;
  title:  string;
  image?: string;
}

interface PodcastEpisode {
  guid:        string;
  title:       string;
  pub_date:    string;
  duration:    number;   // seconds
  url:         string;
  mime:        string;
  description: string;
}

interface PodcastDetail extends PodcastFeed {
  description: string;
  episodes:    PodcastEpisode[];
}

/**
 * Podcasts player element.
 * Saves subscribed RSS feed URLs in the backend DB; fetches and parses feeds
 * on demand; streams episode audio directly from enclosure URLs via <audio>.
 */
@customElement("podcasts-player")
export class PodcastsPlayerElement extends LitElement {
  static styles = css`
    :host { display: block; font-family: sans-serif; padding: 1rem; max-width: 700px; }
    h3 { margin: 0 0 0.5rem; }

    .toolbar { display: flex; gap: 0.5rem; align-items: center;
               flex-wrap: wrap; margin-bottom: 0.5rem; }

    .add-form { background: #f0f8ff; border: 1px solid #b8d4f0; border-radius: 4px;
                padding: 0.75rem; margin-bottom: 0.75rem; }
    .add-form h4 { margin: 0 0 0.5rem; font-size: 0.9em; }
    .add-form label { display: flex; flex-direction: column; gap: 0.2rem;
                      font-size: 0.85em; margin-bottom: 0.4rem; }
    .add-form input { font-size: 0.9em; padding: 0.2em 0.4em;
                      border: 1px solid #bbb; border-radius: 3px; }
    .add-form .row { display: flex; gap: 0.4rem; }

    .feed-list { margin-bottom: 0.75rem; }
    .feed-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0.5rem;
                border: 1px solid #ddd; border-radius: 4px; margin-bottom: 0.3rem;
                background: #fafafa; cursor: pointer; }
    .feed-row:hover { background: #f0f0f0; }
    .feed-row.selected { border-color: #0057b8; background: #e8f4ff; }
    .feed-thumb { width: 36px; height: 36px; border-radius: 3px; object-fit: cover; flex-shrink: 0; }
    .feed-thumb-placeholder { width: 36px; height: 36px; border-radius: 3px;
                               background: #ccc; flex-shrink: 0; }
    .feed-title { flex: 1; font-size: 0.9em; font-weight: bold; }
    .feed-actions { display: flex; gap: 0.3rem; }

    .episode-list { margin-bottom: 0.75rem; }
    .ep-row { display: flex; gap: 0.5rem; align-items: baseline;
              padding: 0.3rem 0.4rem; border-bottom: 1px solid #eee;
              cursor: pointer; }
    .ep-row:hover { background: #f5f5f5; }
    .ep-row.playing { background: #e8f4ff; font-weight: bold; }
    .ep-title { flex: 1; font-size: 0.88em; }
    .ep-date  { font-size: 0.78em; color: #666; white-space: nowrap; }
    .ep-dur   { font-size: 0.78em; color: #555; white-space: nowrap;
                font-variant-numeric: tabular-nums; }

    .audio-error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb;
                   border-radius: 4px; padding: 0.4rem 0.6rem; font-size: 0.85em;
                   margin-bottom: 0.5rem; }

    .now-playing { border-top: 2px solid #ccc; padding-top: 0.75rem; }
    .np-title { font-weight: bold; margin-bottom: 0.2rem; font-size: 0.95em; }
    .np-sub   { font-size: 0.82em; color: #555; margin-bottom: 0.4rem; }
    .seek { width: 100%; margin-bottom: 0.5rem; }
    .ctrls { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
    .vol { display: flex; align-items: center; gap: 0.5rem; }
    .vol input { width: 120px; }
    .empty { color: #888; font-size: 0.9em; margin: 1rem 0; }
  `;

  @state() private _feeds:       PodcastFeed[]     = [];
  @state() private _showAddForm  = false;
  @state() private _addUrl       = "";
  @state() private _adding       = false;
  @state() private _addError     = "";
  @state() private _selected:    PodcastDetail | null = null;
  @state() private _loadingFeed  = false;
  @state() private _playlist:    PodcastEpisode[] = [];
  @state() private _currentIndex = -1;
  @state() private _playing      = false;
  @state() private _elapsed      = 0;
  @state() private _duration     = 0;
  @state() private _volume       = 1.0;
  @state() private _audioError   = "";

  private readonly _audio = new Audio();

  override connectedCallback(): void {
    super.connectedCallback();
    this._audio.addEventListener("timeupdate", () => {
      this._elapsed  = this._audio.currentTime;
      this._duration = isFinite(this._audio.duration) ? this._audio.duration : 0;
    });
    this._audio.addEventListener("play",  () => { this._playing = true; });
    this._audio.addEventListener("pause", () => { this._playing = false; });
    this._audio.addEventListener("ended", () => { void this._playNext(); });
    this._audio.addEventListener("error", () => {
      const err      = this._audio.error;
      this._audioError = err ? `Audio error ${err.code}: ${err.message}` : "Unknown audio error";
      this._playing  = false;
    });
    void this._fetchFeeds();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._audio.pause();
    this._audio.src = "";
  }

  // ---- feeds ----

  private async _fetchFeeds(): Promise<void> {
    try {
      const r = await fetch("/api/podcasts/feeds");
      if (r.ok) this._feeds = await r.json() as PodcastFeed[];
    } catch { /* backend unavailable */ }
  }

  private async _addFeed(): Promise<void> {
    const url = this._addUrl.trim();
    if (!url) return;
    this._adding  = true;
    this._addError = "";
    try {
      const r = await fetch("/api/podcasts/feeds", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({ url }),
      });
      const data = await r.json() as PodcastDetail & { error?: string };
      if (!r.ok) {
        this._addError = data.error ?? "Unknown error";
      } else {
        this._addUrl    = "";
        this._showAddForm = false;
        await this._fetchFeeds();
        // Immediately show the newly subscribed feed's episodes.
        this._selected = data;
      }
    } catch { this._addError = "Network error"; }
    finally  { this._adding = false; }
  }

  private async _removeFeed(url: string, e: Event): Promise<void> {
    e.stopPropagation();
    await fetch("/api/podcasts/feeds/remove", {
      method: "POST",
      headers: { "content-type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify({ url }),
    });
    if (this._selected?.url === url) this._selected = null;
    await this._fetchFeeds();
  }

  private async _selectFeed(feed: PodcastFeed): Promise<void> {
    if (this._selected?.url === feed.url) {
      this._selected = null;
      return;
    }
    this._loadingFeed = true;
    try {
      const r = await fetch(`/api/podcasts/episodes?url=${encodeURIComponent(feed.url)}`);
      if (r.ok) this._selected = await r.json() as PodcastDetail;
    } catch { /* backend unavailable */ }
    finally { this._loadingFeed = false; }
  }

  // ---- playback ----

  private _playAt(index: number): void {
    if (index < 0 || index >= this._playlist.length) return;
    this._currentIndex = index;
    this._audioError   = "";
    const ep           = this._playlist[index];
    this._audio.src    = ep.url;
    this._audio.volume = this._volume;
    void this._audio.play();
  }

  private _playEpisode(ep: PodcastEpisode, playlist: PodcastEpisode[]): void {
    this._playlist = playlist;
    this._playAt(playlist.findIndex((e) => e.guid === ep.guid));
  }

  private async _playNext(): Promise<void> { this._playAt(this._currentIndex + 1); }

  private _playPrev(): void {
    // Restart if past 3 s into the episode; otherwise go back.
    if (this._audio.currentTime > 3) {
      this._audio.currentTime = 0;
    } else {
      this._playAt(this._currentIndex - 1);
    }
  }

  private _onSeek(e: Event): void {
    this._audio.currentTime = parseFloat((e.target as HTMLInputElement).value);
  }

  private _onVolume(e: Event): void {
    this._volume = parseInt((e.target as HTMLInputElement).value, 10) / 100;
    this._audio.volume = this._volume;
  }

  // ---- helpers ----

  private _fmt(seconds: number): string {
    if (!seconds || !isFinite(seconds)) return "--:--";
    const m = String(Math.floor(seconds / 60)).padStart(2, "0");
    const s = String(Math.floor(seconds % 60)).padStart(2, "0");
    return `${m}:${s}`;
  }

  private get _currentEp(): PodcastEpisode | null {
    return this._currentIndex >= 0 ? (this._playlist[this._currentIndex] ?? null) : null;
  }

  // ---- rendering ----

  override render() {
    const episodes = this._selected?.episodes ?? [];
    const currentGuid = this._currentEp?.guid ?? "";

    return html`
      <h3>${t("service.podcasts")}</h3>

      <!-- toolbar -->
      <div class="toolbar">
        <button @click=${() => { this._showAddForm = !this._showAddForm; this._addError = ""; }}>
          ${t("podcasts.add")}
        </button>
      </div>

      <!-- add feed form -->
      ${this._showAddForm ? html`
        <div class="add-form">
          <h4>${t("podcasts.add")}</h4>
          <label>
            ${t("podcasts.feed-url")}
            <input type="url" placeholder="https://example.com/feed.rss"
                   .value=${this._addUrl}
                   @input=${(e: Event) => { this._addUrl = (e.target as HTMLInputElement).value; }}
                   @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void this._addFeed(); }} />
          </label>
          ${this._addError ? html`<div class="audio-error">${this._addError}</div>` : nothing}
          <div class="row">
            <button ?disabled=${!this._addUrl.trim() || this._adding}
                    @click=${() => void this._addFeed()}>
              ${this._adding ? t("podcasts.adding") : t("podcasts.subscribe")}
            </button>
            <button @click=${() => { this._showAddForm = false; this._addError = ""; }}>
              ${t("podcasts.cancel")}
            </button>
          </div>
        </div>
      ` : nothing}

      <!-- feed list -->
      ${this._feeds.length === 0 && !this._showAddForm
        ? html`<p class="empty">${t("podcasts.no-feeds")}</p>`
        : html`
          <div class="feed-list">
            ${this._feeds.map((f) => html`
              <div class="feed-row ${this._selected?.url === f.url ? "selected" : ""}"
                   @click=${() => void this._selectFeed(f)}>
                ${f.image
                  ? html`<img class="feed-thumb" src=${f.image} alt="" loading="lazy" />`
                  : html`<div class="feed-thumb-placeholder"></div>`}
                <span class="feed-title">${f.title || f.url}</span>
                <div class="feed-actions">
                  <button @click=${(e: Event) => void this._removeFeed(f.url, e)}>
                    ${t("podcasts.unsubscribe")}
                  </button>
                </div>
              </div>
            `)}
          </div>
        `
      }

      <!-- episode list -->
      ${this._loadingFeed ? html`<p class="empty">${t("podcasts.loading")}</p>` : nothing}
      ${this._selected && !this._loadingFeed ? html`
        ${episodes.length === 0
          ? html`<p class="empty">${t("podcasts.no-episodes")}</p>`
          : html`
            <div class="episode-list">
              ${episodes.map((ep) => html`
                <div class="ep-row ${ep.guid === currentGuid && this._playing ? "playing" : ""}"
                     @click=${() => this._playEpisode(ep, episodes)}>
                  <span class="ep-title">${ep.title}</span>
                  <span class="ep-date">${ep.pub_date}</span>
                  <span class="ep-dur">${this._fmt(ep.duration)}</span>
                </div>
              `)}
            </div>
          `
        }
      ` : nothing}

      <!-- audio error -->
      ${this._audioError ? html`<div class="audio-error">${this._audioError}</div>` : nothing}

      <!-- now-playing panel -->
      ${this._currentEp ? html`
        <div class="now-playing">
          <div class="np-title">${this._currentEp.title}</div>
          <div class="np-sub">${this._selected?.title ?? ""}</div>
          <input class="seek" type="range" min="0" max=${this._duration || 1}
                 .value=${live(this._elapsed)} @change=${this._onSeek} />
          <div class="np-sub">${this._fmt(this._elapsed)} / ${this._fmt(this._duration)}</div>
          <div class="ctrls">
            <button @click=${() => this._playPrev()}>${t("player.prev")}</button>
            <button @click=${this._playing ? () => this._audio.pause() : () => void this._audio.play()}>
              ${this._playing ? t("player.pause") : t("player.play")}
            </button>
            <button @click=${() => { this._audio.pause(); this._audio.currentTime = 0; }}>
              ${t("player.stop")}
            </button>
            <button @click=${() => void this._playNext()}>${t("player.next")}</button>
          </div>
          <div class="vol">
            <span>${t("player.volume")}</span>
            <input type="range" min="0" max="100"
                   .value=${live(Math.round(this._volume * 100))} @input=${this._onVolume} />
          </div>
        </div>
      ` : nothing}
    `;
  }
}
