import { TemplateResult, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { getCsrfHeaders } from "../../csrf.js";
import { t } from "../../i18n/i18n.js";
import { VolumeNormalizer } from "../../audio/normalizer.js";
import { PlayerBase } from "../../player-base.js";

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

interface DownloadState {
  received: number;
  total:    number;      // 0 if server did not send Content-Length
  error?:   string;
}

interface QuotaInfo {
  used_bytes:  number;
  limit_bytes: number;
}

/** Format bytes as a short human-readable string (e.g. "42.3 MB"). */
function _fmtBytes(n: number): string {
  if (n < 1024)                  return `${n} B`;
  if (n < 1024 * 1024)          return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024)   return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Podcasts player element.
 * Saves subscribed RSS feed URLs in the backend DB; fetches and parses feeds
 * on demand; streams episode audio directly from enclosure URLs via <audio>.
 * Episodes can be saved for offline playback (progress tracked via SSE).
 */
@customElement("podcasts-player")
export class PodcastsPlayerElement extends PlayerBase {
  static styles = css`
    :host { display: block; font-family: sans-serif; padding: 1rem; max-width: 700px; }
    h3 { margin: 0 0 0.5rem; }

    .toolbar { display: flex; gap: 0.5rem; align-items: center;
               flex-wrap: wrap; margin-bottom: 0.5rem; }

    .quota-pill { font-size: 0.78em; color: #555; background: #f0f0f0;
                  border: 1px solid #ddd; border-radius: 10px;
                  padding: 0.15em 0.6em; display: flex; align-items: center; gap: 0.4rem; }
    .quota-bar  { width: 60px; height: 6px; border-radius: 3px;
                  background: #ccc; overflow: hidden; }
    .quota-fill { height: 100%; background: #0057b8; border-radius: 3px; transition: width .3s; }
    .quota-fill.warning { background: #c80; }
    .quota-fill.danger  { background: #c00; }

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
    .ep-row { display: flex; gap: 0.5rem; align-items: center;
              padding: 0.3rem 0.4rem; border-bottom: 1px solid #eee; }
    .ep-row:hover { background: #f5f5f5; }
    .ep-row.playing { background: #e8f4ff; font-weight: bold; }
    .ep-play { flex: 1; display: flex; gap: 0.4rem; align-items: baseline; cursor: pointer; }
    .ep-title { flex: 1; font-size: 0.88em; }
    .ep-date  { font-size: 0.78em; color: #666; white-space: nowrap; }
    .ep-dur   { font-size: 0.78em; color: #555; white-space: nowrap;
                font-variant-numeric: tabular-nums; }
    .ep-actions { display: flex; align-items: center; gap: 0.3rem; flex-shrink: 0; }
    .ep-save-btn { font-size: 0.78em; padding: 0.1em 0.4em; border: 1px solid #bbb;
                   border-radius: 3px; cursor: pointer; background: #f8f8f8; white-space: nowrap; }
    .ep-save-btn.saved { color: #0a0; border-color: #0a0; background: #efffef; }
    .ep-save-btn.error { color: #c00; border-color: #c00; }
    .ep-offline-badge { font-size: 0.72em; color: #0057b8; }

    /* Download progress bar — appears inside the episode row when a save is in flight */
    .dl-progress { display: flex; align-items: center; gap: 0.4rem;
                   font-size: 0.75em; color: #555; width: 100%;
                   padding: 0.2rem 0.4rem; background: #f0f8ff;
                   border-top: 1px solid #b8d4f0; }
    .dl-bar-wrap { flex: 1; height: 6px; background: #dde; border-radius: 3px; overflow: hidden; }
    .dl-bar      { height: 100%; background: #0057b8; border-radius: 3px;
                   transition: width .2s; min-width: 3px; }
    .dl-bar.indeterminate { width: 40% !important; animation: dl-pulse 1.2s ease-in-out infinite; }
    @keyframes dl-pulse {
      0%   { margin-left: 0%;   }
      50%  { margin-left: 60%;  }
      100% { margin-left: 0%;   }
    }

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
  // audio_url → local_url for all saved episodes
  @state() private _saved:       Map<string, string> = new Map();
  // audio_url → in-progress download state
  @state() private _downloads:   Map<string, DownloadState> = new Map();
  @state() private _quota:            QuotaInfo | null = null;
  @state() private _normalizeOn      = false;
  @state() private _normalizeBlocked = false;

  private readonly _audio      = new Audio();
  private readonly _normalizer = new VolumeNormalizer();
  // Keep EventSource refs so we can close them on disconnect.
  private readonly _eventSources = new Map<string, EventSource>();

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
      const err        = this._audio.error;
      this._audioError = err ? `Audio error ${err.code}: ${err.message}` : "Unknown audio error";
      this._playing    = false;
    });
    void this._fetchFeeds();
    void this._fetchSaved();
    void this._fetchQuota();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._audio.pause();
    this._audio.src = "";
    this._normalizer.disconnect();
    // Close any open SSE connections.
    for (const es of this._eventSources.values()) es.close();
    this._eventSources.clear();
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
    this._adding   = true;
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
        this._addUrl      = "";
        this._showAddForm = false;
        await this._fetchFeeds();
        this._selected = data;
      }
    } catch { this._addError = "Network error"; }
    finally   { this._adding = false; }
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
    if (this._selected?.url === feed.url) { this._selected = null; return; }
    this._loadingFeed = true;
    try {
      const r = await fetch(`/api/podcasts/episodes?url=${encodeURIComponent(feed.url)}`);
      if (r.ok) this._selected = await r.json() as PodcastDetail;
    } catch { /* backend unavailable */ }
    finally { this._loadingFeed = false; }
  }

  // ---- offline save ----

  private async _fetchSaved(): Promise<void> {
    try {
      const r = await fetch("/api/podcasts/episodes/saved");
      if (r.ok) {
        const list = await r.json() as Array<{ audio_url: string; local_url: string }>;
        this._saved = new Map(list.map((m) => [m.audio_url, m.local_url]));
      }
    } catch { /* backend unavailable */ }
  }

  private async _fetchQuota(): Promise<void> {
    try {
      const r = await fetch("/api/quota");
      if (r.ok) this._quota = await r.json() as QuotaInfo;
    } catch { /* backend unavailable */ }
  }

  private async _saveEpisode(ep: PodcastEpisode, e: Event): Promise<void> {
    e.stopPropagation();
    const feedUrl = this._selected?.url ?? "";

    const r = await fetch("/api/podcasts/episodes/save", {
      method: "POST",
      headers: { "content-type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify({ feed_url: feedUrl, episode: ep }),
    });
    const data = await r.json() as {
      task_id?: string; already_saved?: boolean; local_url?: string; error?: string
    };

    if (!r.ok) {
      // Show error inline on the episode row.
      this._downloads = new Map(this._downloads).set(ep.url, {
        received: 0, total: 0, error: data.error ?? `HTTP ${r.status}`,
      });
      return;
    }

    if (data.already_saved && data.local_url) {
      this._saved = new Map(this._saved).set(ep.url, data.local_url);
      return;
    }

    if (!data.task_id) return;

    // Subscribe to SSE progress stream.
    this._downloads = new Map(this._downloads).set(ep.url, { received: 0, total: 0 });
    const es = new EventSource(`/api/podcasts/episodes/save/${data.task_id}`);
    this._eventSources.set(ep.url, es);

    es.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(ev.data as string) as {
        type: string; received?: number; total?: number; local_url?: string; message?: string
      };
      if (msg.type === "progress") {
        this._downloads = new Map(this._downloads).set(ep.url, {
          received: msg.received ?? 0,
          total:    msg.total    ?? 0,
        });
      } else if (msg.type === "done" && msg.local_url) {
        es.close();
        this._eventSources.delete(ep.url);
        const dl = new Map(this._downloads);
        dl.delete(ep.url);
        this._downloads = dl;
        this._saved = new Map(this._saved).set(ep.url, msg.local_url);
        void this._fetchQuota();
      } else if (msg.type === "error") {
        es.close();
        this._eventSources.delete(ep.url);
        this._downloads = new Map(this._downloads).set(ep.url, {
          received: 0, total: 0, error: msg.message ?? "Download failed",
        });
      }
    };

    es.onerror = () => {
      es.close();
      this._eventSources.delete(ep.url);
      this._downloads = new Map(this._downloads).set(ep.url, {
        received: 0, total: 0, error: "Connection lost",
      });
    };
  }

  private async _unsaveEpisode(ep: PodcastEpisode, e: Event): Promise<void> {
    e.stopPropagation();
    const feedUrl = this._selected?.url ?? "";
    await fetch("/api/podcasts/episodes/save", {
      method: "DELETE",
      headers: { "content-type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify({ audio_url: ep.url, feed_url: feedUrl }),
    });
    const saved = new Map(this._saved);
    saved.delete(ep.url);
    this._saved = saved;
    void this._fetchQuota();
  }

  // ---- playback ----

  private _playAt(index: number): void {
    if (index < 0 || index >= this._playlist.length) return;
    this._currentIndex = index;
    this._audioError   = "";
    const ep           = this._playlist[index];
    // Use the local URL if the episode has been saved offline.
    const localUrl     = this._saved.get(ep.url);
    const src          = localUrl ?? ep.url;
    this._audio.src    = src;
    this._audio.volume = this._volume;
    void this._audio.play();
    // Re-evaluate normalize availability: CDN URLs are cross-origin → blocked.
    const sameOrigin = VolumeNormalizer.isSameOrigin(this._audio.src);
    this._normalizeBlocked = !sameOrigin;
    if (!sameOrigin) this._normalizer.disable();
  }

  private _connectNormalizer(): void {
    // Cross-origin check MUST happen before connect(): Chrome permanently captures
    // the audio element on createMediaElementSource (even when it throws), routing
    // its output to the now-dead AudioContext → permanent silence if we proceed.
    if (!VolumeNormalizer.isSameOrigin(this._audio.src)) {
      this._normalizeBlocked = true;
      this._normalizer.disable();
      return;
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

  private _playEpisode(ep: PodcastEpisode, playlist: PodcastEpisode[]): void {
    this._playlist = playlist;
    this._playAt(playlist.findIndex((e) => e.guid === ep.guid));
  }

  private async _playNext(): Promise<void> { this._playAt(this._currentIndex + 1); }

  private _playPrev(): void {
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

  // ---- episode row ----

  private _renderEpisode(ep: PodcastEpisode, episodes: PodcastEpisode[], currentGuid: string) {
    const isSaved    = this._saved.has(ep.url);
    const dl         = this._downloads.get(ep.url);
    const isDownloading = dl !== undefined && !dl.error;

    // Save/unsave action button.
    let saveBtn: TemplateResult | typeof nothing = nothing;
    if (dl?.error) {
      saveBtn = html`
        <button class="ep-save-btn error" title=${dl.error}
                @click=${(e: Event) => void this._saveEpisode(ep, e)}>
          ${t("podcasts.save-error")} ↺
        </button>`;
    } else if (isDownloading) {
      saveBtn = html`<span class="ep-save-btn">${t("podcasts.saving")}</span>`;
    } else if (isSaved) {
      saveBtn = html`
        <button class="ep-save-btn saved" title=${t("podcasts.unsave")}
                @click=${(e: Event) => void this._unsaveEpisode(ep, e)}>
          ✓ ${t("podcasts.saved")}
        </button>`;
    } else {
      saveBtn = html`
        <button class="ep-save-btn" title=${t("podcasts.save")}
                @click=${(e: Event) => void this._saveEpisode(ep, e)}>
          ↓ ${t("podcasts.save")}
        </button>`;
    }

    // Download progress bar (shown below the row while downloading).
    let progressBar: TemplateResult | typeof nothing = nothing;
    if (isDownloading && dl) {
      const pct  = dl.total > 0 ? Math.round((dl.received / dl.total) * 100) : 0;
      const label = dl.total > 0
        ? `${_fmtBytes(dl.received)} / ${_fmtBytes(dl.total)} (${pct}%)`
        : _fmtBytes(dl.received);
      const indeterminate = dl.total === 0;
      progressBar = html`
        <div class="dl-progress">
          <div class="dl-bar-wrap">
            <div class="dl-bar ${indeterminate ? "indeterminate" : ""}"
                 style="width: ${indeterminate ? "40" : pct}%"></div>
          </div>
          <span>${label}</span>
        </div>`;
    }

    return html`
      <div class="ep-row ${ep.guid === currentGuid && this._playing ? "playing" : ""}">
        <div class="ep-play" @click=${() => this._playEpisode(ep, episodes)}>
          <span class="ep-title">${ep.title}${isSaved ? html` <span class="ep-offline-badge">⊙</span>` : nothing}</span>
          <span class="ep-date">${ep.pub_date}</span>
          <span class="ep-dur">${this._fmt(ep.duration)}</span>
        </div>
        <div class="ep-actions">${saveBtn}</div>
      </div>
      ${progressBar}
    `;
  }

  // ---- quota pill ----

  private _renderQuota() {
    if (!this._quota) return nothing;
    const { used_bytes, limit_bytes } = this._quota;
    if (limit_bytes === 0) return nothing;  // unlimited
    const pct = Math.min(100, Math.round((used_bytes / limit_bytes) * 100));
    const cls = pct >= 90 ? "danger" : pct >= 70 ? "warning" : "";
    return html`
      <div class="quota-pill" title="${t("quota.label")}">
        <div class="quota-bar">
          <div class="quota-fill ${cls}" style="width: ${pct}%"></div>
        </div>
        <span>${_fmtBytes(used_bytes)} ${t("quota.of")} ${_fmtBytes(limit_bytes)}</span>
      </div>`;
  }

  // ---- rendering ----

  override render() {
    const episodes    = this._selected?.episodes ?? [];
    const currentGuid = this._currentEp?.guid    ?? "";

    return html`
      <h3>${t("service.podcasts")}</h3>

      <!-- toolbar + quota -->
      <div class="toolbar">
        <button @click=${() => { this._showAddForm = !this._showAddForm; this._addError = ""; }}>
          ${t("podcasts.add")}
        </button>
        ${this._renderQuota()}
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
        `}

      <!-- episode list -->
      ${this._loadingFeed ? html`<p class="empty">${t("podcasts.loading")}</p>` : nothing}
      ${this._selected && !this._loadingFeed ? html`
        ${episodes.length === 0
          ? html`<p class="empty">${t("podcasts.no-episodes")}</p>`
          : html`
            <div class="episode-list">
              ${episodes.map((ep) => this._renderEpisode(ep, episodes, currentGuid))}
            </div>
          `}
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
    `;
  }
}
