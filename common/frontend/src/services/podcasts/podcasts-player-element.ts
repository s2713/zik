import { type TemplateResult, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { getCsrfHeaders } from "../../csrf.js";
import { t } from "../../i18n/i18n.js";
import { playerBus, type SelectionStateEvent } from "../../player-bus.js";
import { PlayerBase } from "../../player-base.js";
import { queue } from "../../queue/queue-controller.js";
import type { QueueItem } from "../../queue/queue-item.js";
import "../../queue/queue-panel-element.js";

// ---- types ----

type SortCol = "title" | "feed" | "date" | "duration";

interface PodcastFeed { url: string; title: string; image?: string; }

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

/** Episode enriched with its parent feed metadata, used for the flat/grouped list. */
interface EpisodeEx extends PodcastEpisode {
  feedUrl:    string;
  feedTitle:  string;
  feedImage?: string;
}

interface DownloadState { received: number; total: number; error?: string; }
interface QuotaInfo { used_bytes: number; limit_bytes: number; }

// ---- helpers ----

function fmtSec(s: number): string {
  if (!s || !isFinite(s)) return "--:--";
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function fmtBytes(n: number): string {
  if (n < 1024)       return `${n} B`;
  if (n < 1048576)    return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/**
 * Podcasts player — two-panel layout.
 * Feeds bar for subscription management; left panel shows all episodes from all feeds
 * with per-column sort and search-as-you-type; right panel is the shared queue.
 * Episodes are played via the cross-service queue controller.
 */
@customElement("podcasts-player")
export class PodcastsPlayerElement extends PlayerBase {
  static styles = css`
    :host {
      display: flex; flex-direction: column;
      height: calc(100vh - 56px - 76px);
      font-family: sans-serif; color: #f1f5f9; background: #0f172a;
      overflow: hidden;
    }

    /* ---- feeds bar ---- */
    .feeds-bar {
      flex-shrink: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem;
      padding: 0.5rem 1rem; background: #1e293b; border-bottom: 1px solid #334155;
    }
    .feeds-label { font-size: 0.78em; color: #94a3b8; white-space: nowrap; }
    .feed-chip {
      display: inline-flex; align-items: center; gap: 0.35rem;
      padding: 0.3em 0.65em; border-radius: 4px; font-size: 0.85em;
      border: 1px solid #334155; background: #0f172a; color: #cbd5e1;
      white-space: nowrap;
    }
    .feed-thumb { width: 18px; height: 18px; border-radius: 2px; object-fit: cover; }
    .remove-btn {
      padding: 0.05em 0.3em; font-size: 0.75em;
      background: transparent; border: 1px solid #475569; border-radius: 3px;
      color: #64748b; cursor: pointer;
    }
    .remove-btn:hover { background: #334155; color: #f87171; }
    .add-feed-btn {
      padding: 0.35em 0.75em; border-radius: 4px; font-size: 0.85em;
      background: #0f172a; border: 1px dashed #475569; color: #64748b; cursor: pointer;
    }
    .add-feed-btn:hover { border-color: #94a3b8; color: #cbd5e1; }

    .quota-pill {
      font-size: 0.78em; color: #94a3b8; background: #0f172a;
      border: 1px solid #334155; border-radius: 10px;
      padding: 0.15em 0.6em; display: flex; align-items: center; gap: 0.4rem;
      margin-left: auto;
    }
    .quota-bar  { width: 50px; height: 5px; border-radius: 3px; background: #334155; overflow: hidden; }
    .quota-fill { height: 100%; border-radius: 3px; transition: width .3s; background: #3b82f6; }
    .quota-fill.warning { background: #f59e0b; }
    .quota-fill.danger  { background: #ef4444; }

    /* ---- add-feed form ---- */
    .add-form {
      flex-shrink: 0; padding: 0.75rem 1rem; background: #1e293b;
      border-bottom: 1px solid #334155;
    }
    .add-form h4 { margin: 0 0 0.5rem; font-size: 0.9em; color: #94a3b8; }
    .add-form label { display: flex; flex-direction: column; font-size: 0.82em; gap: 0.15rem; margin-bottom: 0.4rem; }
    .add-form input {
      font-size: 0.9em; padding: 0.25em 0.35em;
      border: 1px solid #334155; border-radius: 3px;
      background: #0f172a; color: #f1f5f9;
    }
    .add-form .form-actions { display: flex; gap: 0.4rem; }
    .btn {
      padding: 0.3em 0.8em; border-radius: 4px; font-size: 0.88em; cursor: pointer;
      border: 1px solid #475569; background: #334155; color: #f1f5f9; white-space: nowrap;
    }
    .btn:hover { background: #475569; }
    .btn.primary { background: #1d4ed8; border-color: #3b82f6; }
    .btn.primary:hover { background: #2563eb; }
    .btn.toggled { background: #1e3a8a; border-color: #3b82f6; color: #93c5fd; }
    .btn:disabled { opacity: 0.4; cursor: default; }
    .error-strip {
      background: #7f1d1d; color: #fca5a5; border: 1px solid #dc2626;
      border-radius: 3px; padding: 0.3rem 0.5rem; font-size: 0.82em; margin-bottom: 0.4rem;
    }

    /* ---- two-panel layout ---- */
    .panels { display: grid; grid-template-columns: 1fr 1fr; flex: 1; overflow: hidden; }
    @media (orientation: portrait) {
      .panels { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
    }
    queue-panel { display: flex; flex-direction: column; overflow: hidden; }

    /* ---- episode panel (left) ---- */
    .ep-panel { display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid #334155; }

    /* shared column grid: title | feed | date | duration | save | actions */
    .ep-grid { display: grid; grid-template-columns: 1fr 1fr 6.5em 4em 7em 5.5em; }

    .ep-header { flex-shrink: 0; background: #0f172a; border-bottom: 1px solid #334155; }
    .ep-cols   { border-bottom: 1px solid #1e293b; }
    .col-hd {
      padding: 0.3rem 0.4rem; font-size: 0.8em; font-weight: 600; color: #94a3b8;
      display: flex; align-items: center; gap: 0.25em;
      cursor: pointer; user-select: none;
    }
    .col-hd:hover  { color: #f1f5f9; }
    .col-hd.sorted { color: #60a5fa; }
    .col-hd-static { cursor: default; padding: 0.3rem 0.4rem; font-size: 0.8em; font-weight: 600; color: #94a3b8; }
    .ep-search { padding: 0.25rem 0; gap: 0 0.25rem; align-items: center; }
    .ep-search input {
      font-size: 0.8em; padding: 0.2em 0.35em; margin: 0 0.25rem;
      border: 1px solid #334155; border-radius: 3px;
      background: #1e293b; color: #f1f5f9; width: calc(100% - 0.5rem);
    }
    .ep-search input::placeholder { color: #475569; }

    .ep-count { flex-shrink: 0; padding: 0.25rem 0.5rem; font-size: 0.75em; color: #475569; }
    .ep-rows  { flex: 1; overflow-y: auto; }

    /* group section header (grouped-by-feed mode) */
    .ep-group-hd {
      display: flex; align-items: center; gap: 0.45rem;
      padding: 0.35rem 0.6rem; background: #1e293b; cursor: pointer;
      font-size: 0.83em; font-weight: 600; color: #94a3b8;
      border-bottom: 1px solid #334155; user-select: none;
    }
    .ep-group-hd:hover { background: #334155; color: #f1f5f9; }
    .grp-count { font-weight: normal; color: #475569; }

    /* episode row */
    .ep-row { border-bottom: 1px solid #1e293b; font-size: 0.85em; user-select: none; }
    .ep-row:hover .ep-cell,
    .ep-row:hover .ep-save,
    .ep-row:hover .ep-actions { background: #1e293b; }
    .ep-row.selected .ep-cell,
    .ep-row.selected .ep-save,
    .ep-row.selected .ep-actions { background: rgba(96,165,250,0.12); }
    .ep-cell {
      padding: 0.3rem 0.4rem; overflow: hidden;
      white-space: nowrap; text-overflow: ellipsis; align-self: center;
    }
    .ep-cell.date { color: #64748b; font-size: 0.82em; }
    .ep-cell.dur  { color: #64748b; font-variant-numeric: tabular-nums; font-size: 0.9em; }
    .ep-offline   { color: #60a5fa; font-size: 0.75em; margin-left: 0.3em; }

    /* save button cell */
    .ep-save { display: flex; align-items: center; padding: 0 0.3rem; }
    .save-btn {
      font-size: 0.75em; padding: 0.2em 0.45em; white-space: nowrap;
      border: 1px solid #475569; border-radius: 3px;
      background: #1e293b; color: #94a3b8; cursor: pointer;
    }
    .save-btn:hover { background: #334155; color: #f1f5f9; }
    .save-btn.saved { border-color: #22c55e; color: #86efac; background: #14532d; }
    .save-btn.err   { border-color: #ef4444; color: #fca5a5; }

    /* download progress (full-width row below the episode row) */
    .dl-row {
      display: flex; align-items: center; gap: 0.4rem;
      padding: 0.2rem 0.4rem; background: #1e293b;
      font-size: 0.75em; color: #94a3b8; border-bottom: 1px solid #334155;
    }
    .dl-bar-wrap { flex: 1; height: 5px; background: #334155; border-radius: 3px; overflow: hidden; }
    .dl-bar { height: 100%; background: #3b82f6; border-radius: 3px; transition: width .2s; min-width: 3px; }
    .dl-bar.indeterminate { width: 40% !important; animation: dl-pulse 1.2s ease-in-out infinite; }
    @keyframes dl-pulse {
      0%   { margin-left: 0%;  }
      50%  { margin-left: 60%; }
      100% { margin-left: 0%;  }
    }

    /* action buttons */
    .ep-actions { display: flex; gap: 2px; align-items: center; padding: 0 0.2rem; }
    .act-btn {
      font-size: 0.82em; padding: 0.35em 0.55em;
      background: #334155; border: none; color: #f1f5f9;
      border-radius: 3px; cursor: pointer; line-height: 1;
    }
    .act-btn:hover { background: #475569; }
    .act-btn.play-now { background: #1d4ed8; }
    .act-btn.play-now:hover { background: #2563eb; }

    .empty { padding: 1.5rem 1rem; color: #475569; font-size: 0.9em; }
    .loading-note { color: #475569; font-style: italic; }
    .sel-info { color: #7dd3fc; }
    .sel-clear {
      margin-left: 0.3em; font-size: 0.85em;
      background: none; border: none; color: #94a3b8; cursor: pointer; padding: 0;
    }
    .sel-clear:hover { color: #f1f5f9; }
  `;

  // ---- feed + episode state ----
  @state() private _feeds:        PodcastFeed[]             = [];
  @state() private _feedDetails:  Map<string, PodcastDetail> = new Map();
  @state() private _loadingFeeds: Set<string>               = new Set();
  @state() private _showForm      = false;
  @state() private _addUrl        = "";
  @state() private _adding        = false;
  @state() private _addError      = "";

  // ---- sort / filter / grouping ----
  @state() private _sortCol:        SortCol = "date";
  @state() private _sortDir:        1 | -1  = -1;   // newest first by default
  @state() private _fTitle  = "";
  @state() private _fFeed   = "";
  @state() private _fDate   = "";
  @state() private _groupByFeed        = false;
  @state() private _collapsedFeeds: Set<string> = new Set();

  // ---- selection ----
  @state() private _selected: Set<string> = new Set();   // episode guids
  private _anchor: string | null = null;

  // ---- offline save ----
  @state() private _saved:     Map<string, string>       = new Map();
  @state() private _downloads: Map<string, DownloadState> = new Map();
  @state() private _quota:     QuotaInfo | null           = null;

  private readonly _eventSources = new Map<string, EventSource>();

  private readonly _onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this._selected.size > 0) {
      this._selected = new Set(); this._anchor = null;
      this._emitSelectionState();
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("keydown", this._onKeyDown);
    void this._loadAll();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("keydown", this._onKeyDown);
    for (const es of this._eventSources.values()) es.close();
    this._eventSources.clear();
    playerBus.dispatchEvent(new CustomEvent<SelectionStateEvent>("selection-state", {
      detail: { items: [], source: "podcasts" },
    }));
  }

  // ---- data loading ----

  private async _loadAll(): Promise<void> {
    await Promise.all([this._fetchFeeds(), this._fetchSaved(), this._fetchQuota()]);
  }

  private async _fetchFeeds(): Promise<void> {
    try {
      const r = await fetch("/api/podcasts/feeds");
      if (!r.ok) return;
      this._feeds = await r.json() as PodcastFeed[];
      // Load episodes for all feeds in parallel; skip already-cached ones.
      await Promise.all(this._feeds.map((f) => this._loadFeedEpisodes(f.url)));
    } catch { /* backend unavailable */ }
  }

  private async _loadFeedEpisodes(feedUrl: string, force = false): Promise<void> {
    if (!force && this._feedDetails.has(feedUrl)) return;
    this._loadingFeeds = new Set(this._loadingFeeds).add(feedUrl);
    try {
      const r = await fetch(`/api/podcasts/episodes?url=${encodeURIComponent(feedUrl)}`);
      if (r.ok) {
        this._feedDetails = new Map(this._feedDetails).set(feedUrl, await r.json() as PodcastDetail);
      }
    } catch { /* backend unavailable */ }
    finally {
      const s = new Set(this._loadingFeeds); s.delete(feedUrl); this._loadingFeeds = s;
    }
  }

  private async _refreshAll(): Promise<void> {
    this._feedDetails = new Map();
    await Promise.all(this._feeds.map((f) => this._loadFeedEpisodes(f.url, true)));
  }

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

  // ---- feed management ----

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
        this._addUrl   = "";
        this._showForm = false;
        this._feedDetails = new Map(this._feedDetails).set(url, data);
        await this._fetchFeeds();
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
    const fd = new Map(this._feedDetails); fd.delete(url); this._feedDetails = fd;
    this._feeds = this._feeds.filter((f) => f.url !== url);
  }

  // ---- offline save ----

  private async _saveEpisode(ep: EpisodeEx, e: Event): Promise<void> {
    e.stopPropagation();
    const r = await fetch("/api/podcasts/episodes/save", {
      method: "POST",
      headers: { "content-type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify({ feed_url: ep.feedUrl, episode: ep }),
    });
    const data = await r.json() as {
      task_id?: string; already_saved?: boolean; local_url?: string; error?: string
    };
    if (!r.ok) {
      this._downloads = new Map(this._downloads).set(ep.url, {
        received: 0, total: 0, error: data.error ?? `HTTP ${r.status}`,
      });
      return;
    }
    if (data.already_saved && data.local_url) {
      this._saved = new Map(this._saved).set(ep.url, data.local_url); return;
    }
    if (!data.task_id) return;

    this._downloads = new Map(this._downloads).set(ep.url, { received: 0, total: 0 });
    const es = new EventSource(`/api/podcasts/episodes/save/${data.task_id}`);
    this._eventSources.set(ep.url, es);
    es.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(ev.data as string) as {
        type: string; received?: number; total?: number; local_url?: string; message?: string
      };
      if (msg.type === "progress") {
        this._downloads = new Map(this._downloads).set(ep.url, {
          received: msg.received ?? 0, total: msg.total ?? 0,
        });
      } else if (msg.type === "done" && msg.local_url) {
        es.close(); this._eventSources.delete(ep.url);
        const dl = new Map(this._downloads); dl.delete(ep.url); this._downloads = dl;
        this._saved = new Map(this._saved).set(ep.url, msg.local_url);
        void this._fetchQuota();
      } else if (msg.type === "error") {
        es.close(); this._eventSources.delete(ep.url);
        this._downloads = new Map(this._downloads).set(ep.url, {
          received: 0, total: 0, error: msg.message ?? "Download failed",
        });
      }
    };
    es.onerror = () => {
      es.close(); this._eventSources.delete(ep.url);
      this._downloads = new Map(this._downloads).set(ep.url, {
        received: 0, total: 0, error: "Connection lost",
      });
    };
  }

  private async _unsaveEpisode(ep: EpisodeEx, e: Event): Promise<void> {
    e.stopPropagation();
    await fetch("/api/podcasts/episodes/save", {
      method: "DELETE",
      headers: { "content-type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify({ audio_url: ep.url, feed_url: ep.feedUrl }),
    });
    const saved = new Map(this._saved); saved.delete(ep.url); this._saved = saved;
    void this._fetchQuota();
  }

  // ---- queue ----

  /** Use the local URL when the episode is saved offline — same-origin, normalizer-compatible. */
  private _toQueueItem(ep: EpisodeEx): QueueItem {
    return {
      serviceId: "podcasts",
      trackId:   ep.guid,
      audioUrl:  this._saved.get(ep.url) ?? ep.url,
      artUrl:    ep.feedImage ?? "",
      title:     ep.title,
      artist:    "",
      album:     ep.feedTitle,
      duration:  ep.duration,
    };
  }

  // ---- selection / drag ----

  private _emitSelectionState(): void {
    const byGuid = new Map(this._allEpisodes.map(ep => [ep.guid, ep]));
    const items: QueueItem[] = [...this._selected]
      .map(guid => byGuid.get(guid))
      .filter((ep): ep is EpisodeEx => ep !== undefined)
      .map(ep => this._toQueueItem(ep));
    playerBus.dispatchEvent(new CustomEvent<SelectionStateEvent>("selection-state", {
      detail: { items, source: "podcasts" },
    }));
  }

  private _onTrackClick(e: MouseEvent, guid: string, orderedGuids: string[]): void {
    if (e.shiftKey && this._anchor !== null) {
      const ai = orderedGuids.indexOf(this._anchor);
      const ki = orderedGuids.indexOf(guid);
      if (ai >= 0 && ki >= 0) {
        const lo = Math.min(ai, ki); const hi = Math.max(ai, ki);
        const s = new Set(this._selected);
        for (let i = lo; i <= hi; i++) s.add(orderedGuids[i]);
        this._selected = s;
      }
    } else if (e.ctrlKey || e.metaKey) {
      const s = new Set(this._selected);
      if (s.has(guid)) s.delete(guid); else s.add(guid);
      this._selected = s;
      this._anchor = guid;
    } else {
      this._selected = new Set([guid]);
      this._anchor = guid;
    }
    this._emitSelectionState();
  }

  private _onDragStart(e: DragEvent, ep: EpisodeEx, allEps: EpisodeEx[]): void {
    const isSel  = this._selected.has(ep.guid);
    const source = isSel && this._selected.size > 0
      ? allEps.filter(t => this._selected.has(t.guid))
      : [ep];
    e.dataTransfer!.effectAllowed = "copy";
    e.dataTransfer!.setData("queue-items-json", JSON.stringify(source.map(t => this._toQueueItem(t))));
  }

  // ---- filter / sort / group ----

  /** Flat list of all episodes enriched with their feed metadata. */
  private get _allEpisodes(): EpisodeEx[] {
    const out: EpisodeEx[] = [];
    for (const [url, detail] of this._feedDetails) {
      for (const ep of detail.episodes)
        out.push({ ...ep, feedUrl: url, feedTitle: detail.title, ...(detail.image ? { feedImage: detail.image } : {}) });
    }
    return out;
  }

  /** Apply text filters and sort. */
  private _buildDisplay(): EpisodeEx[] {
    const q  = (v: string) => v.trim().toLowerCase();
    const ft = q(this._fTitle);
    const ff = q(this._fFeed);
    const fd = q(this._fDate);

    const base = this._allEpisodes.filter((ep) => {
      if (ft && !ep.title.toLowerCase().includes(ft))     return false;
      if (ff && !ep.feedTitle.toLowerCase().includes(ff)) return false;
      if (fd && !ep.pub_date.toLowerCase().includes(fd))  return false;
      return true;
    });

    const col = this._sortCol;
    const dir = this._sortDir;
    return [...base].sort((a, b) => {
      if (col === "duration") return (a.duration - b.duration) * dir;
      const va = col === "title" ? a.title.toLowerCase()
               : col === "feed"  ? a.feedTitle.toLowerCase()
               : a.pub_date;
      const vb = col === "title" ? b.title.toLowerCase()
               : col === "feed"  ? b.feedTitle.toLowerCase()
               : b.pub_date;
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
  }

  private _setSort(col: SortCol): void {
    if (this._sortCol === col) this._sortDir = (this._sortDir === 1 ? -1 : 1) as 1 | -1;
    // Default direction: date → newest first; everything else → A-Z / shortest first.
    else { this._sortCol = col; this._sortDir = col === "date" ? -1 : 1; }
  }

  private _toggleGroup(feedUrl: string): void {
    const s = new Set(this._collapsedFeeds);
    if (s.has(feedUrl)) s.delete(feedUrl); else s.add(feedUrl);
    this._collapsedFeeds = s;
  }

  // ---- rendering ----

  private _renderColHeader(col: SortCol, label: string): TemplateResult {
    const sorted = this._sortCol === col;
    const arrow  = sorted ? (this._sortDir === 1 ? " ↑" : " ↓") : "";
    return html`
      <div class="col-hd ${sorted ? "sorted" : ""}" @click=${() => this._setSort(col)}>
        ${label}${arrow}
      </div>`;
  }

  private _renderEpisode(ep: EpisodeEx, allEps: EpisodeEx[]): TemplateResult {
    const isSaved = this._saved.has(ep.url);
    const dl      = this._downloads.get(ep.url);
    const isSel   = this._selected.has(ep.guid);
    // When the clicked row is already selected, act buttons apply to the full selection.
    const effective = isSel && this._selected.size > 0
      ? allEps.filter(t => this._selected.has(t.guid))
      : [ep];
    const items   = () => effective.map(t => this._toQueueItem(t));
    const allGuids = allEps.map(t => t.guid);

    let saveBtn: TemplateResult;
    if (dl?.error) {
      saveBtn = html`<button class="save-btn err" title=${dl.error}
                             @click=${(e: Event) => void this._saveEpisode(ep, e)}>
                       ${t("podcasts.save-error")} ↺
                     </button>`;
    } else if (dl) {
      saveBtn = html`<span class="save-btn">${t("podcasts.saving")}</span>`;
    } else if (isSaved) {
      saveBtn = html`<button class="save-btn saved" title=${t("podcasts.unsave")}
                             @click=${(e: Event) => void this._unsaveEpisode(ep, e)}>
                       ✓ ${t("podcasts.saved")}
                     </button>`;
    } else {
      saveBtn = html`<button class="save-btn"
                             @click=${(e: Event) => void this._saveEpisode(ep, e)}>
                       ↓ ${t("podcasts.save")}
                     </button>`;
    }

    return html`
      <div class="ep-row ep-grid ${isSel ? "selected" : ""}"
           draggable="true"
           @click=${(e: MouseEvent) => this._onTrackClick(e, ep.guid, allGuids)}
           @dragstart=${(e: DragEvent) => this._onDragStart(e, ep, allEps)}>
        <div class="ep-cell">
          ${ep.title}${isSaved ? html`<span class="ep-offline">⊙</span>` : nothing}
        </div>
        <div class="ep-cell">${ep.feedTitle}</div>
        <div class="ep-cell date">${ep.pub_date}</div>
        <div class="ep-cell dur">${fmtSec(ep.duration)}</div>
        <div class="ep-save">${saveBtn}</div>
        <div class="ep-actions">
          <button class="act-btn" title="Append to queue"
                  @click=${(e: Event) => { e.stopPropagation(); queue.add(items()); }}>+</button>
          <button class="act-btn" title="Play after current"
                  @click=${(e: Event) => { e.stopPropagation(); queue.insertNext(items()); }}>⏭</button>
          <button class="act-btn play-now" title="Play now"
                  @click=${(e: Event) => { e.stopPropagation(); queue.playNow(items()); }}>▶</button>
        </div>
      </div>
      ${dl && !dl.error ? this._renderDlProgress(dl) : nothing}
    `;
  }

  private _renderDlProgress(dl: DownloadState): TemplateResult {
    const pct   = dl.total > 0 ? Math.round((dl.received / dl.total) * 100) : 0;
    const label = dl.total > 0
      ? `${fmtBytes(dl.received)} / ${fmtBytes(dl.total)} (${pct}%)`
      : fmtBytes(dl.received);
    return html`
      <div class="dl-row">
        <div class="dl-bar-wrap">
          <div class="dl-bar ${dl.total === 0 ? "indeterminate" : ""}"
               style="width: ${dl.total === 0 ? "40" : pct}%"></div>
        </div>
        <span>${label}</span>
      </div>`;
  }

  /**
   * Grouped view: one collapsible section per feed, groups sorted alphabetically.
   * Groups preserve the sorted order of episodes within each section.
   */
  private _renderGrouped(episodes: EpisodeEx[]): TemplateResult {
    // Collect groups while preserving intra-group episode order from _buildDisplay.
    const groups = new Map<string, EpisodeEx[]>();
    for (const ep of episodes) {
      const arr = groups.get(ep.feedUrl) ?? [];
      arr.push(ep);
      groups.set(ep.feedUrl, arr);
    }
    // Sort group headers alphabetically by feed title.
    const sorted = [...groups.entries()].sort(([, a], [, b]) => {
      const ta = a[0]?.feedTitle.toLowerCase() ?? "";
      const tb = b[0]?.feedTitle.toLowerCase() ?? "";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    return html`
      ${sorted.map(([feedUrl, eps]) => {
        const collapsed = this._collapsedFeeds.has(feedUrl);
        const detail    = this._feedDetails.get(feedUrl);
        return html`
          <div class="ep-group-hd" @click=${() => this._toggleGroup(feedUrl)}>
            ${collapsed ? "▶" : "▼"}
            ${detail?.image ? html`<img class="feed-thumb" src=${detail.image} alt="" />` : nothing}
            ${eps[0]?.feedTitle ?? feedUrl}
            <span class="grp-count">(${eps.length})</span>
          </div>
          ${collapsed ? nothing : eps.map((ep) => this._renderEpisode(ep, episodes))}
        `;
      })}
    `;
  }

  private _renderEpisodePanel(): TemplateResult {
    if (this._feeds.length === 0) {
      return html`<div class="empty">${t("podcasts.no-feeds")}</div>`;
    }

    const episodes = this._buildDisplay();
    const total    = this._allEpisodes.length;
    const loading  = this._loadingFeeds.size > 0;

    const countLabel = total !== episodes.length
      ? `${episodes.length} / ${total} episodes`
      : `${total} episode${total !== 1 ? "s" : ""}`;
    const selInfo = this._selected.size > 0
      ? html` · <span class="sel-info">${this._selected.size} selected</span
          ><button class="sel-clear" @click=${() => { this._selected = new Set(); this._anchor = null; this._emitSelectionState(); }}>✕</button>`
      : nothing;

    return html`
      <div class="ep-header">
        <div class="ep-cols ep-grid">
          ${this._renderColHeader("title",    "Title")}
          ${this._renderColHeader("feed",     "Feed")}
          ${this._renderColHeader("date",     "Date")}
          ${this._renderColHeader("duration", "Duration")}
          <div class="col-hd-static">Offline</div>
          <div></div>
        </div>
        <div class="ep-search ep-grid">
          <input placeholder="Title…"  .value=${live(this._fTitle)}
                 @input=${(e: Event) => { this._fTitle = (e.target as HTMLInputElement).value; }} />
          <input placeholder="Feed…"   .value=${live(this._fFeed)}
                 @input=${(e: Event) => { this._fFeed  = (e.target as HTMLInputElement).value; }} />
          <input placeholder="Date…"   .value=${live(this._fDate)}
                 @input=${(e: Event) => { this._fDate  = (e.target as HTMLInputElement).value; }} />
          <div></div><div></div><div></div>
        </div>
      </div>

      <div class="ep-count">
        ${countLabel}${selInfo}${loading ? html` · <span class="loading-note">loading…</span>` : nothing}
      </div>

      <div class="ep-rows">
        ${this._groupByFeed
          ? this._renderGrouped(episodes)
          : episodes.map((ep) => this._renderEpisode(ep, episodes))}
      </div>
    `;
  }

  private _renderQuota(): TemplateResult | typeof nothing {
    if (!this._quota || this._quota.limit_bytes === 0) return nothing;
    const { used_bytes, limit_bytes } = this._quota;
    const pct = Math.min(100, Math.round((used_bytes / limit_bytes) * 100));
    const cls = pct >= 90 ? "danger" : pct >= 70 ? "warning" : "";
    return html`
      <div class="quota-pill" title=${t("quota.label")}>
        <div class="quota-bar"><div class="quota-fill ${cls}" style="width: ${pct}%"></div></div>
        <span>${fmtBytes(used_bytes)} ${t("quota.of")} ${fmtBytes(limit_bytes)}</span>
      </div>`;
  }

  private _renderFeedsBar(): TemplateResult {
    return html`
      <div class="feeds-bar">
        <span class="feeds-label">${t("service.podcasts")}:</span>
        ${this._feeds.map((f) => html`
          <span style="display:inline-flex;align-items:center;gap:0.2rem;">
            <span class="feed-chip">
              ${f.image ? html`<img class="feed-thumb" src=${f.image} alt="" loading="lazy" />` : nothing}
              ${f.title || f.url}
              ${this._loadingFeeds.has(f.url) ? html`<span style="opacity:.5">…</span>` : nothing}
            </span>
            <button class="remove-btn" title=${t("podcasts.unsubscribe")}
                    @click=${(e: Event) => void this._removeFeed(f.url, e)}>✕</button>
          </span>
        `)}
        <button class="add-feed-btn"
                @click=${() => { this._showForm = !this._showForm; this._addError = ""; }}>
          + ${t("podcasts.add")}
        </button>
        <button class="btn" @click=${() => void this._refreshAll()}>↺</button>
        <button class="btn ${this._groupByFeed ? "toggled" : ""}"
                @click=${() => { this._groupByFeed = !this._groupByFeed; }}>
          ⊞ ${this._groupByFeed ? "Grouped" : "Group"}
        </button>
        ${this._renderQuota()}
      </div>
    `;
  }

  private _renderAddForm(): TemplateResult {
    return html`
      <div class="add-form">
        <h4>${t("podcasts.add")}</h4>
        <label>
          ${t("podcasts.feed-url")}
          <input type="url" placeholder="https://example.com/feed.rss"
                 .value=${this._addUrl}
                 @input=${(e: Event) => { this._addUrl = (e.target as HTMLInputElement).value; }}
                 @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void this._addFeed(); }} />
        </label>
        ${this._addError ? html`<div class="error-strip">${this._addError}</div>` : nothing}
        <div class="form-actions">
          <button class="btn primary" ?disabled=${!this._addUrl.trim() || this._adding}
                  @click=${() => void this._addFeed()}>
            ${this._adding ? t("podcasts.adding") : t("podcasts.subscribe")}
          </button>
          <button class="btn" @click=${() => { this._showForm = false; this._addError = ""; }}>
            ${t("podcasts.cancel")}
          </button>
        </div>
      </div>
    `;
  }

  override render() {
    return html`
      ${this._renderFeedsBar()}
      ${this._showForm ? this._renderAddForm() : nothing}

      <div class="panels">
        <div class="ep-panel">${this._renderEpisodePanel()}</div>
        <queue-panel></queue-panel>
      </div>
    `;
  }
}
