import { css, html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { customElement, state } from "lit/decorators.js";

import { getCsrfHeaders } from "../../csrf.js";
import { t } from "../../i18n/i18n.js";
import { playerBus, type SelectionStateEvent } from "../../player-bus.js";
import { PlayerBase } from "../../player-base.js";
import { queue } from "../../queue/queue-controller.js";
import type { QueueItem } from "../../queue/queue-item.js";
import type { FileTrack } from "./files-player.js";
import "../../queue/queue-panel-element.js";

// ---- interfaces ----

interface Source {
  id: string;
  label: string;
  kind: string;
  mounted: boolean;
  config?: Record<string, string>;
}

interface LanForm {
  label: string; server: string; share: string;
  subpath: string; username: string; password: string;
}

// ---- helpers ----

/** Build a QueueItem from a FileTrack for the shared cross-service queue. */
function fileTrackToQueueItem(track: FileTrack): QueueItem {
  return {
    serviceId: "files",
    trackId:   track.id,
    audioUrl:  `/api/files/audio/${track.id}`,
    artUrl:    `/api/files/cover/${track.id}`,
    title:     track.title,
    artist:    track.artist,
    album:     track.album,
    duration:  track.duration,
  };
}

/** Parse "1967", "1965-1970" or "1960s" into a {from, to} year range. */
function parseYearFilter(s: string): { from: number; to: number } | null {
  s = s.trim();
  const range = s.match(/^(\d{4})\s*[-–]\s*(\d{4})$/);
  if (range) return { from: parseInt(range[1]), to: parseInt(range[2]) };
  const single = parseInt(s);
  if (!isNaN(single) && single > 999 && single < 2100) return { from: single, to: single };
  return null;
}


type SortCol = "artist" | "album" | "track" | "year" | "source";

/**
 * Files service player: two-panel search + queue UI.
 * Left panel: library search with artist/album/year/track filters and source checkboxes.
 * Right panel: shared <queue-panel> element (cross-service play queue).
 */
@customElement("files-player")
export class FilesPlayerElement extends PlayerBase {
  static styles = css`
    :host {
      display: flex; flex-direction: column;
      height: calc(100vh - 56px - 76px);  /* below topbar, above footer */
      font-family: sans-serif;
      color: #f1f5f9;
      background: #0f172a;
      overflow: hidden;
    }

    /* ---- sources bar (fixed top strip) ---- */
    .sources-bar {
      flex-shrink: 0;
      display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem;
      padding: 0.5rem 1rem;
      background: #1e293b;
      border-bottom: 1px solid #334155;
      font-size: 0.85rem;
    }
    .source-chk { display: flex; align-items: center; gap: 0.3rem; cursor: pointer; }
    .source-chk input { cursor: pointer; accent-color: #60a5fa; }
    .src-badge {
      font-size: 0.7em; padding: 0.1em 0.4em; border-radius: 3px;
      background: #334155; color: #94a3b8;
    }
    .src-badge.mounted { background: #14532d; color: #86efac; }
    .src-badge.smb     { background: #1e3a5f; color: #7dd3fc; }
    .src-btn { font-size: 0.95em; padding: 0.55em 1.05em; border-radius: 4px;
               background: #334155; border: none; color: #f1f5f9; cursor: pointer; }
    .src-btn:hover { background: #475569; }
    .src-btn.danger { background: #7f1d1d; color: #fca5a5; }
    .src-btn.danger:hover { background: #991b1b; }

    /* ---- LAN form ---- */
    .lan-form {
      background: #1e293b; border: 1px solid #334155; border-radius: 6px;
      padding: 0.75rem 1rem; margin: 0.5rem 1rem;
    }
    .lan-form h4 { margin: 0 0 0.5rem; font-size: 0.9em; color: #94a3b8; }
    .lan-form .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem 0.75rem; }
    .lan-form label { display: flex; flex-direction: column; font-size: 0.82em; gap: 0.15rem; color: #94a3b8; }
    .lan-form input {
      font-size: 0.9em; padding: 0.25em 0.4em;
      background: #0f172a; border: 1px solid #475569;
      border-radius: 3px; color: #f1f5f9;
    }
    .lan-form .form-actions { margin-top: 0.5rem; display: flex; gap: 0.4rem; }

    /* ---- two-panel layout ---- */
    .panels {
      display: grid;
      grid-template-columns: 1fr 1fr;
      flex: 1;
      overflow: hidden;
      gap: 0;
    }
    @media (orientation: portrait) {
      .panels { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
    }

    /* ---- search panel ---- */
    .search-panel {
      display: flex; flex-direction: column;
      overflow: hidden;
      border-right: 1px solid #334155;
    }
    .search-fields {
      flex-shrink: 0;
      display: grid; grid-template-columns: auto 1fr; gap: 0.3rem 0.5rem;
      align-items: center;
      padding: 0.6rem 0.75rem;
      background: #1e293b;
      border-bottom: 1px solid #334155;
      font-size: 0.85rem;
    }
    .search-fields label { color: #94a3b8; white-space: nowrap; }
    .search-fields input {
      padding: 0.25em 0.4em;
      background: #0f172a; border: 1px solid #475569;
      border-radius: 4px; color: #f1f5f9; font-size: 0.9em;
      width: 100%; box-sizing: border-box;
    }
    .search-fields input:focus { outline: none; border-color: #60a5fa; }
    .search-results { flex: 1; overflow-y: auto; padding: 0.5rem; }

    /* ---- hierarchical search results ---- */
    .result-header {
      display: grid;
      grid-template-columns: 36px 32px 1fr 1fr 1fr 3.5em 5.5em auto;
      align-items: center; gap: 0.3rem;
      padding: 0.2rem 0.5rem;
      background: #1e293b; border-bottom: 1px solid #334155;
      font-size: 0.75em; flex-shrink: 0;
    }
    .sort-btn {
      background: none; border: none; color: #64748b;
      cursor: pointer; padding: 0.05em 0;
      font-size: 1em; text-align: left; white-space: nowrap;
    }
    .sort-btn:hover { color: #94a3b8; }
    .sort-btn.active { color: #60a5fa; }

    .result-row {
      display: grid;
      grid-template-columns: 36px 32px 1fr 1fr 1fr 3.5em 5.5em auto;
      align-items: center; gap: 0.3rem;
      padding: 0.25rem 0.5rem;
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }
    .result-row:hover    { background: rgba(255,255,255,0.05); }
    .result-row.selected { background: rgba(96,165,250,0.10); }
    .result-row[draggable] { cursor: grab; }
    /* Visual hierarchy via left border; indentation via padding on the first cell only
       so all other columns stay aligned with the header. */
    .result-row.row-album { border-left: 3px solid #334155; }
    .result-row.row-track  { border-left: 3px solid #475569; }
    .result-row.row-album > :first-child { padding-left: 0.65rem; }
    .result-row.row-track  > :first-child { padding-left: 1.3rem; }

    .expand-icon {
      color: #475569; font-size: 0.75em; user-select: none;
      display: inline-flex; align-items: center; justify-content: center;
      width: 1.4em; transition: transform 0.15s;
      background: none; border: none; padding: 0; cursor: pointer;
    }
    .expand-icon:hover { color: #94a3b8; }
    .expand-icon.open  { transform: rotate(90deg); }

    /* selection indicator in the column header */
    .sel-info  { color: #7dd3fc; margin-left: 0.5em; font-weight: normal; }
    .sel-clear {
      margin-left: 0.25em; font-size: 0.85em;
      background: none; border: none; color: #94a3b8; cursor: pointer; padding: 0;
    }
    .sel-clear:hover { color: #f1f5f9; }

    .row-cell {
      font-size: 0.82em; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; min-width: 0;
    }
    .row-cell.dim    { color: #64748b; font-size: 0.75em; }
    .row-cell.strong { font-weight: 600; }

    .row-thumb { width: 32px; height: 32px; border-radius: 3px; object-fit: cover; }
    .row-thumb-ph {
      width: 32px; height: 32px; border-radius: 3px;
      background: #334155; display: flex; align-items: center;
      justify-content: center; font-size: 0.9em; color: #475569;
    }

    .row-actions { display: flex; gap: 2px; flex-shrink: 0; }
    .row-act {
      font-size: 0.88em; padding: 0.45em 0.7em;
      background: #334155; border: none; color: #f1f5f9;
      border-radius: 3px; cursor: pointer;
    }
    .row-act:hover { background: #475569; }
    .row-act.play-now { background: #1d4ed8; }
    .row-act.play-now:hover { background: #2563eb; }

    /* empty states */
    .empty { color: #475569; font-size: 0.85em; padding: 1.5rem; text-align: center; }

    /* scan button */
    .scan-btn { font-size: 0.75em; }
  `;

  // ---- state ----
  @state() private _tracks:         FileTrack[]      = [];
  @state() private _sources:        Source[]         = [];
  @state() private _enabledSources: Set<string>      = new Set(["internal"]);
  @state() private _showAddLan      = false;
  @state() private _expandedArtists: Set<string> = new Set();
  @state() private _expandedAlbums:  Set<string> = new Set();
  @state() private _sortCol: SortCol = "artist";
  @state() private _sortDir: 1 | -1  = 1;

  // search fields (not @state; debounced via _searchTick)
  private _qArtist = "";
  private _qAlbum  = "";
  private _qYear   = "";
  private _qTrack  = "";
  @state() private _searchTick = 0;

  private _lanForm: LanForm = { label: "", server: "", share: "",
                                 subpath: "", username: "", password: "" };
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- library selection ----
  @state() private _selected: Set<string> = new Set();
  private _anchor: string | null = null;

  /** Broadcast current selection to the footer via playerBus. */
  private _emitSelectionState(): void {
    const items: QueueItem[] = this._selectedTracks().map(fileTrackToQueueItem);
    playerBus.dispatchEvent(new CustomEvent<SelectionStateEvent>("selection-state", {
      detail: { items, source: "files" },
    }));
  }

  private readonly _onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this._selected.size > 0) {
      this._selected = new Set(); this._anchor = null;
      this._emitSelectionState();
    }
  };

  // artist-image cache: name → URL | null (null = not found / pending)
  private _artistImages: Record<string, string | null> = {};

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("keydown", this._onKeyDown);
    void this._fetchSources();
    void this._fetchTracks();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("keydown", this._onKeyDown);
    // Clear selection state when panel is hidden.
    playerBus.dispatchEvent(new CustomEvent<SelectionStateEvent>("selection-state", {
      detail: { items: [], source: "files" },
    }));
  }

  // ---- sources ----

  private async _fetchSources(): Promise<void> {
    try {
      const r = await fetch("/api/files/sources");
      const sources = await r.json() as Source[];
      this._sources = sources;
      // Enable all mounted sources by default.
      const mounted = new Set(sources.filter(s => s.mounted).map(s => s.id));
      this._enabledSources = new Set([...this._enabledSources, ...mounted]);
    } catch { /* backend unavailable */ }
  }

  private async _mount(sourceId: string): Promise<void> {
    try {
      await fetch(`/api/files/sources/${sourceId}/mount`, {
        method: "POST", headers: { ...getCsrfHeaders() },
      });
      await new Promise((r) => setTimeout(r, 400));
      await this._fetchSources();
      await this._fetchTracks();
    } catch { /* backend unavailable */ }
  }

  private async _unmount(sourceId: string): Promise<void> {
    try {
      await fetch(`/api/files/sources/${sourceId}/unmount`, {
        method: "POST", headers: { ...getCsrfHeaders() },
      });
      await this._fetchSources();
      await this._fetchTracks();
    } catch { /* backend unavailable */ }
  }

  private async _addLanSource(): Promise<void> {
    const f = this._lanForm;
    try {
      const r = await fetch("/api/files/lan", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({ label: f.label, server: f.server, share: f.share,
                               subpath: f.subpath, username: f.username, password: f.password }),
      });
      if (r.ok) {
        this._showAddLan = false;
        this._lanForm = { label: "", server: "", share: "", subpath: "", username: "", password: "" };
        await this._fetchSources();
      }
    } catch { /* backend unavailable */ }
  }

  private async _removeLanSource(sourceId: string): Promise<void> {
    try {
      await fetch(`/api/files/lan/${sourceId}`, {
        method: "DELETE", headers: { ...getCsrfHeaders() },
      });
      await this._fetchSources();
      await this._fetchTracks();
    } catch { /* backend unavailable */ }
  }

  // ---- library ----

  private async _fetchTracks(): Promise<void> {
    try {
      const r = await fetch("/api/files/tracks?sort=artist");
      this._tracks = await r.json() as FileTrack[];
    } catch { /* backend unavailable */ }
  }

  private async _scan(): Promise<void> {
    try {
      await fetch("/api/files/scan", { method: "POST", headers: { ...getCsrfHeaders() } });
      await new Promise((r) => setTimeout(r, 600));
      await this._fetchTracks();
    } catch { /* backend unavailable */ }
  }

  // ---- search / filter ----

  private _debounceSearch(): void {
    if (this._debounceTimer !== null) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => { this._searchTick++; }, 150);
  }

  /** Derive the display mode from which search fields are filled. */
  private _displayMode(): "artists" | "albums" | "tracks" {
    if (this._qTrack.trim()) return "tracks";
    if (this._qAlbum.trim() || this._qYear.trim()) return "albums";
    return "artists";  // empty or artist-only → all/filtered artists
  }

  private _filteredTracks(): FileTrack[] {
    let tracks = this._tracks.filter(t => this._enabledSources.has(t.source_id));
    const qa = this._qArtist.trim().toLowerCase();
    const qb = this._qAlbum.trim().toLowerCase();
    const yr = parseYearFilter(this._qYear);
    const qt = this._qTrack.trim().toLowerCase();
    if (qa)  tracks = tracks.filter(t => t.artist.toLowerCase().includes(qa));
    if (qb)  tracks = tracks.filter(t => t.album.toLowerCase().includes(qb));
    if (yr)  tracks = tracks.filter(t => t.year !== null && t.year >= yr.from && t.year <= yr.to);
    if (qt)  tracks = tracks.filter(t => t.title.toLowerCase().includes(qt));
    return tracks;
  }

  // ---- artist image ----

  private _loadArtistImage(artist: string): string | null {
    if (artist in this._artistImages) return this._artistImages[artist];
    this._artistImages[artist] = null;  // prevent duplicate fetch
    void fetch(`/api/files/artist-image?name=${encodeURIComponent(artist)}`)
      .then(r => r.ok ? r.json() as Promise<{ url: string }> : null)
      .then(data => {
        const url = (data as { url?: string } | null)?.url ?? null;
        if (url) {
          this._artistImages[artist] = url;
          this.requestUpdate();
        }
      });
    return null;
  }

  // ---- drag-and-drop (search → queue) ----

  /** Drag tracks from the search panel; queue panel accepts the drop. */
  private _onSearchDragStart(e: DragEvent, ownTracks: FileTrack[], key: string): void {
    const isSel  = this._selected.has(key);
    const tracks = isSel && this._selected.size > 0 ? this._selectedTracks() : ownTracks;
    e.dataTransfer!.effectAllowed = "copy";
    e.dataTransfer!.setData("queue-items-json", JSON.stringify(tracks.map(fileTrackToQueueItem)));
  }

  // ---- source label lookup ----

  private _sourceLabel(sourceId: string): string {
    return this._sources.find(s => s.id === sourceId)?.label ?? sourceId;
  }

  // ---- rendering: cover art helpers ----

  // ---- rendering: search panel ----

  /** Sort a track list by current sort column and direction. */
  private _sortedTracks(tracks: FileTrack[]): FileTrack[] {
    return [...tracks].sort((a, b) => {
      let cmp = 0;
      switch (this._sortCol) {
        case "artist": cmp = a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) || ((a.track_number ?? 999) - (b.track_number ?? 999)); break;
        case "album":  cmp = a.album.localeCompare(b.album)   || a.artist.localeCompare(b.artist) || ((a.track_number ?? 999) - (b.track_number ?? 999)); break;
        case "track":  cmp = a.title.localeCompare(b.title); break;
        case "year":   cmp = ((a.year ?? 0) - (b.year ?? 0)) || a.artist.localeCompare(b.artist); break;
        case "source": cmp = this._sourceLabel(a.source_id).localeCompare(this._sourceLabel(b.source_id)); break;
      }
      return cmp * this._sortDir;
    });
  }

  /** Group tracks into sorted [artist, tracks[]] pairs. */
  private _groupByArtist(tracks: FileTrack[]): [string, FileTrack[]][] {
    const map = new Map<string, FileTrack[]>();
    for (const t of tracks) {
      if (!map.has(t.artist)) map.set(t.artist, []);
      map.get(t.artist)!.push(t);
    }
    return [...map.entries()].sort(([a], [b]) => this._sortDir * a.localeCompare(b));
  }

  /** Group tracks into sorted [key, tracks[]] pairs by album+artist. */
  private _groupByAlbum(tracks: FileTrack[]): [string, FileTrack[]][] {
    const map = new Map<string, FileTrack[]>();
    for (const t of tracks) {
      const key = `${t.album}||${t.artist}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return [...map.entries()].sort(([, a], [, b]) => {
      const fa = a[0]; const fb = b[0];
      let cmp = 0;
      switch (this._sortCol) {
        case "artist": cmp = fa.artist.localeCompare(fb.artist) || fa.album.localeCompare(fb.album); break;
        case "year":   cmp = ((fa.year ?? 0) - (fb.year ?? 0)) || fa.album.localeCompare(fb.album); break;
        case "source": cmp = this._sourceLabel(fa.source_id).localeCompare(this._sourceLabel(fb.source_id)); break;
        default:       cmp = fa.album.localeCompare(fb.album) || fa.artist.localeCompare(fb.artist);
      }
      return cmp * this._sortDir;
    });
  }

  /** Thumbnail cell: cover art layered over a placeholder; placeholder shows on img error. */
  private _artImgCell(trackId: string): TemplateResult {
    return html`
      <div style="position:relative;width:32px;height:32px;border-radius:3px;overflow:hidden;flex-shrink:0;">
        <div class="row-thumb-ph">♪</div>
        <img style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"
             src="/api/files/cover/${trackId}"
             @error=${(e: Event) => { (e.target as HTMLImageElement).style.display = "none"; }}
             alt="" />
      </div>`;
  }

  /** Artist image cell: Wikipedia URL if loaded, placeholder otherwise. */
  private _artistImgCell(name: string): TemplateResult {
    const url = this._loadArtistImage(name);
    return url
      ? html`<img class="row-thumb" src="${url}" alt="" />`
      : html`<div class="row-thumb-ph">♪</div>`;
  }

  /**
   * Flat ordered list of all currently visible row keys (mirrors render order).
   * Used by shift-click to compute the selected range.
   */
  private _visibleKeyOrder(): string[] {
    const keys: string[] = [];
    const filtered = this._filteredTracks();
    const mode     = this._displayMode();
    if (mode === "artists") {
      for (const [name, aTracks] of this._groupByArtist(filtered)) {
        keys.push(`a:${name}`);
        if (this._expandedArtists.has(name)) {
          for (const [albumKey, alTracks] of this._groupByAlbum(aTracks)) {
            keys.push(`l:${albumKey}`);
            if (this._expandedAlbums.has(albumKey)) {
              for (const tr of this._sortedTracks(alTracks)) keys.push(`t:${tr.id}`);
            }
          }
        }
      }
    } else if (mode === "albums") {
      for (const [albumKey, alTracks] of this._groupByAlbum(filtered)) {
        keys.push(`l:${albumKey}`);
        if (this._expandedAlbums.has(albumKey)) {
          for (const tr of this._sortedTracks(alTracks)) keys.push(`t:${tr.id}`);
        }
      }
    } else {
      for (const tr of this._sortedTracks(filtered)) keys.push(`t:${tr.id}`);
    }
    return keys;
  }

  /** Collect all FileTrack objects for the current selection (deduped). */
  private _selectedTracks(): FileTrack[] {
    const result: FileTrack[] = [];
    const seen = new Set<string>();
    for (const key of this._selected) {
      let matches: FileTrack[];
      if (key.startsWith("a:")) {
        const name = key.slice(2);
        matches = this._tracks.filter(t => t.artist === name);
      } else if (key.startsWith("l:")) {
        const raw  = key.slice(2);
        const sep  = raw.lastIndexOf("||");
        const album = raw.slice(0, sep); const artist = raw.slice(sep + 2);
        matches = this._tracks.filter(t => t.album === album && t.artist === artist);
      } else {
        const id = key.slice(2);
        matches = this._tracks.filter(t => t.id === id);
      }
      for (const t of matches) {
        if (!seen.has(t.id)) { result.push(t); seen.add(t.id); }
      }
    }
    return result;
  }

  /** Handle click / ctrl-click / shift-click for library row selection. */
  private _onRowClick(e: MouseEvent, key: string): void {
    if (e.shiftKey && this._anchor !== null) {
      const order = this._visibleKeyOrder();
      const ai = order.indexOf(this._anchor);
      const ki = order.indexOf(key);
      if (ai >= 0 && ki >= 0) {
        const lo = Math.min(ai, ki); const hi = Math.max(ai, ki);
        const s = new Set(this._selected);
        for (let i = lo; i <= hi; i++) s.add(order[i]);
        this._selected = s;
      }
    } else if (e.ctrlKey || e.metaKey) {
      const s = new Set(this._selected);
      if (s.has(key)) s.delete(key); else s.add(key);
      this._selected = s;
      this._anchor = key;
    } else {
      this._selected = new Set([key]);
      this._anchor = key;
    }
    this._emitSelectionState();
  }

  /**
   * Append / add-after-current / play-now action buttons.
   * When the row's key is in the selection, acts on the full selection.
   */
  private _renderActions(tracks: FileTrack[], key: string): TemplateResult {
    const isSel    = this._selected.has(key);
    const effective = isSel && this._selected.size > 0 ? this._selectedTracks() : tracks;
    return html`
      <div class="row-actions">
        <button class="row-act" title="Append to queue"
                @click=${(e: Event) => { e.stopPropagation(); queue.add(effective.map(fileTrackToQueueItem)); }}>+</button>
        <button class="row-act" title="Play after current"
                @click=${(e: Event) => { e.stopPropagation(); queue.insertNext(effective.map(fileTrackToQueueItem)); }}>⏭</button>
        <button class="row-act play-now" title="Play now"
                @click=${(e: Event) => { e.stopPropagation(); queue.playNow(effective.map(fileTrackToQueueItem)); }}>▶</button>
      </div>`;
  }

  /** Sortable column header row above the search results. */
  private _renderColumnHeader(): TemplateResult {
    const h = (col: SortCol, label: string) => html`
      <button class="sort-btn ${this._sortCol === col ? "active" : ""}"
              @click=${() => {
                if (this._sortCol === col)
                  this._sortDir = (this._sortDir === 1 ? -1 : 1) as 1 | -1;
                else { this._sortCol = col; this._sortDir = 1; }
              }}>
        ${label}${this._sortCol === col ? (this._sortDir === 1 ? " ▲" : " ▼") : ""}
      </button>`;
    const selInfo = this._selected.size > 0
      ? html`<span class="sel-info">${this._selected.size} selected</span
          ><button class="sel-clear" title="Clear selection"
                   @click=${() => { this._selected = new Set(); this._anchor = null; }}>✕</button>`
      : nothing;
    return html`
      <div class="result-header">
        <span></span><span></span>
        ${h("artist", t("files.artist"))}
        ${h("album",  t("files.album"))}
        ${h("track",  t("files.track"))}
        ${h("year",   t("files.year"))}
        ${h("source", "Source")}
        <span style="color:#64748b">${selInfo || html`Action`}</span>
      </div>`;
  }

  /** Hierarchical artist → album → track tree (default and artist-only mode). */
  private _renderArtistList(tracks: FileTrack[]): TemplateResult {
    const artists = this._groupByArtist(tracks);
    if (artists.length === 0) return html`<div class="empty">No artists found</div>`;
    return html`${artists.map(([name, aTracks]) => {
      const aKey     = `a:${name}`;
      const expanded = this._expandedArtists.has(name);
      const albums   = this._groupByAlbum(aTracks);
      return html`
        <div class="result-row ${this._selected.has(aKey) ? "selected" : ""}"
             draggable="true"
             @click=${(e: MouseEvent) => this._onRowClick(e, aKey)}
             @dragstart=${(e: DragEvent) => this._onSearchDragStart(e, aTracks, aKey)}>
          <!-- expand icon is a separate button so it doesn't trigger row selection -->
          <button class="expand-icon ${expanded ? "open" : ""}"
                  title="${expanded ? "Collapse" : "Expand"}"
                  @click=${(e: MouseEvent) => {
                    e.stopPropagation();
                    const s = new Set(this._expandedArtists);
                    if (expanded) s.delete(name); else s.add(name);
                    this._expandedArtists = s;
                  }}>▶</button>
          ${this._artistImgCell(name)}
          <span class="row-cell strong" title="${name}">${name}</span>
          <span class="row-cell dim">${albums.length} album${albums.length !== 1 ? "s" : ""}</span>
          <span class="row-cell dim">${aTracks.length} track${aTracks.length !== 1 ? "s" : ""}</span>
          <span class="row-cell"></span>
          <span class="row-cell"></span>
          ${this._renderActions(aTracks, aKey)}
        </div>
        ${expanded ? albums.map(([albumKey, alTracks]) => {
          const lKey       = `l:${albumKey}`;
          const albExpanded = this._expandedAlbums.has(albumKey);
          const first = alTracks[0];
          return html`
            <div class="result-row row-album ${this._selected.has(lKey) ? "selected" : ""}"
                 draggable="true"
                 @click=${(e: MouseEvent) => this._onRowClick(e, lKey)}
                 @dragstart=${(e: DragEvent) => this._onSearchDragStart(e, alTracks, lKey)}>
              <button class="expand-icon ${albExpanded ? "open" : ""}"
                      title="${albExpanded ? "Collapse" : "Expand"}"
                      @click=${(e: MouseEvent) => {
                        e.stopPropagation();
                        const s = new Set(this._expandedAlbums);
                        if (albExpanded) s.delete(albumKey); else s.add(albumKey);
                        this._expandedAlbums = s;
                      }}>▶</button>
              ${this._artImgCell(first.id)}
              <span class="row-cell dim">${first.artist}</span>
              <span class="row-cell strong" title="${first.album}">${first.album || "(no album)"}</span>
              <span class="row-cell dim">${alTracks.length} track${alTracks.length !== 1 ? "s" : ""}</span>
              <span class="row-cell dim">${first.year ?? ""}</span>
              <span class="row-cell dim">${this._sourceLabel(first.source_id)}</span>
              ${this._renderActions(alTracks, lKey)}
            </div>
            ${albExpanded ? this._sortedTracks(alTracks).map(tr => {
              const tKey = `t:${tr.id}`;
              return html`
                <div class="result-row row-track ${this._selected.has(tKey) ? "selected" : ""}"
                     draggable="true"
                     @click=${(e: MouseEvent) => this._onRowClick(e, tKey)}
                     @dragstart=${(e: DragEvent) => this._onSearchDragStart(e, [tr], tKey)}>
                  <span></span>
                  ${this._artImgCell(tr.id)}
                  <span class="row-cell dim">${tr.artist}</span>
                  <span class="row-cell dim">${tr.album}</span>
                  <span class="row-cell" title="${tr.title}">${tr.title}</span>
                  <span class="row-cell dim">${tr.year ?? ""}</span>
                  <span class="row-cell dim">${this._sourceLabel(tr.source_id)}</span>
                  ${this._renderActions([tr], tKey)}
                </div>`;
            }) : nothing}
          `;
        }) : nothing}
      `;
    })}`;
  }

  /** Expandable album → track list (album/year search mode). */
  private _renderAlbumList(tracks: FileTrack[]): TemplateResult {
    const albums = this._groupByAlbum(tracks);
    if (albums.length === 0) return html`<div class="empty">No albums found</div>`;
    return html`${albums.map(([key, alTracks]) => {
      const lKey     = `l:${key}`;
      const expanded = this._expandedAlbums.has(key);
      const first    = alTracks[0];
      return html`
        <div class="result-row ${this._selected.has(lKey) ? "selected" : ""}"
             draggable="true"
             @click=${(e: MouseEvent) => this._onRowClick(e, lKey)}
             @dragstart=${(e: DragEvent) => this._onSearchDragStart(e, alTracks, lKey)}>
          <button class="expand-icon ${expanded ? "open" : ""}"
                  title="${expanded ? "Collapse" : "Expand"}"
                  @click=${(e: MouseEvent) => {
                    e.stopPropagation();
                    const s = new Set(this._expandedAlbums);
                    if (expanded) s.delete(key); else s.add(key);
                    this._expandedAlbums = s;
                  }}>▶</button>
          ${this._artImgCell(first.id)}
          <span class="row-cell" title="${first.artist}">${first.artist}</span>
          <span class="row-cell strong" title="${first.album}">${first.album || "(no album)"}</span>
          <span class="row-cell dim">${alTracks.length} track${alTracks.length !== 1 ? "s" : ""}</span>
          <span class="row-cell dim">${first.year ?? ""}</span>
          <span class="row-cell dim">${this._sourceLabel(first.source_id)}</span>
          ${this._renderActions(alTracks, lKey)}
        </div>
        ${expanded ? this._sortedTracks(alTracks).map(tr => {
          const tKey = `t:${tr.id}`;
          return html`
            <div class="result-row row-track ${this._selected.has(tKey) ? "selected" : ""}"
                 draggable="true"
                 @click=${(e: MouseEvent) => this._onRowClick(e, tKey)}
                 @dragstart=${(e: DragEvent) => this._onSearchDragStart(e, [tr], tKey)}>
              <span></span>
              ${this._artImgCell(tr.id)}
              <span class="row-cell dim">${tr.artist}</span>
              <span class="row-cell dim">${tr.album}</span>
              <span class="row-cell" title="${tr.title}">${tr.title}</span>
              <span class="row-cell dim">${tr.year ?? ""}</span>
              <span class="row-cell dim">${this._sourceLabel(tr.source_id)}</span>
              ${this._renderActions([tr], tKey)}
            </div>`;
        }) : nothing}
      `;
    })}`;
  }

  /** Flat sorted track list (track-name search mode). */
  private _renderTrackList(tracks: FileTrack[]): TemplateResult {
    const sorted = this._sortedTracks(tracks);
    if (sorted.length === 0) return html`<div class="empty">No tracks found</div>`;
    return html`${sorted.map(tr => {
      const tKey = `t:${tr.id}`;
      return html`
        <div class="result-row ${this._selected.has(tKey) ? "selected" : ""}"
             draggable="true"
             @click=${(e: MouseEvent) => this._onRowClick(e, tKey)}
             @dragstart=${(e: DragEvent) => this._onSearchDragStart(e, [tr], tKey)}>
          <span></span>
          ${this._artImgCell(tr.id)}
          <span class="row-cell" title="${tr.artist}">${tr.artist}</span>
          <span class="row-cell dim" title="${tr.album}">${tr.album}</span>
          <span class="row-cell strong" title="${tr.title}">${tr.title}</span>
          <span class="row-cell dim">${tr.year ?? ""}</span>
          <span class="row-cell dim">${this._sourceLabel(tr.source_id)}</span>
          ${this._renderActions([tr], tKey)}
        </div>`;
    })}`;
  }

  private _renderSearchPanel(): TemplateResult {
    const mode    = this._displayMode();
    const results = this._filteredTracks();

    return html`
      <div class="search-panel">
        <div class="search-fields">
          <label>${t("files.artist")}</label>
          <input type="text" .value=${live(this._qArtist)}
                 @input=${(e: Event) => {
                   this._qArtist = (e.target as HTMLInputElement).value;
                   this._debounceSearch();
                 }} />
          <label>${t("files.album")}</label>
          <input type="text" .value=${live(this._qAlbum)}
                 @input=${(e: Event) => {
                   this._qAlbum = (e.target as HTMLInputElement).value;
                   this._debounceSearch();
                 }} />
          <label>${t("files.year")}</label>
          <input type="text" placeholder="e.g. 1967 or 1965-1970"
                 .value=${live(this._qYear)}
                 @input=${(e: Event) => {
                   this._qYear = (e.target as HTMLInputElement).value;
                   this._debounceSearch();
                 }} />
          <label>${t("files.track")}</label>
          <input type="text" .value=${live(this._qTrack)}
                 @input=${(e: Event) => {
                   this._qTrack = (e.target as HTMLInputElement).value;
                   this._debounceSearch();
                 }} />
        </div>

        ${this._renderColumnHeader()}

        <div class="search-results">
          ${mode === "artists" ? this._renderArtistList(results)
          : mode === "tracks"  ? this._renderTrackList(results)
          :                      this._renderAlbumList(results)}
        </div>
      </div>`;
  }

  // ---- rendering: playlist panel ----

  private _renderPlaylistPanel(): TemplateResult {
    return html`<queue-panel></queue-panel>`;
  }

  // ---- rendering: sources bar ----

  private _renderSourcesBar(): TemplateResult {
    return html`
      <div class="sources-bar">
        ${this._sources.map(s => html`
          <label class="source-chk">
            <input type="checkbox"
                   .checked=${this._enabledSources.has(s.id)}
                   @change=${(e: Event) => {
                     const next = new Set(this._enabledSources);
                     (e.target as HTMLInputElement).checked ? next.add(s.id) : next.delete(s.id);
                     this._enabledSources = next;
                     this._searchTick++;
                   }} />
            ${s.label}
            <span class="src-badge ${s.mounted ? "mounted" : ""} ${s.kind === "smb" ? "smb" : ""}">
              ${s.mounted ? "on" : "off"}
            </span>
          </label>
          ${s.mounted
            ? html`<button class="src-btn" @click=${() => void this._unmount(s.id)}>Unmount</button>`
            : html`<button class="src-btn" @click=${() => void this._mount(s.id)}>Mount</button>`}
          ${s.kind === "smb" ? html`
            <button class="src-btn danger" @click=${() => void this._removeLanSource(s.id)}>✕</button>
          ` : nothing}
        `)}
        <button class="src-btn" @click=${() => void this._scan()}>⟳ Scan</button>
        <button class="src-btn" @click=${() => { this._showAddLan = !this._showAddLan; }}>+ LAN</button>
      </div>

      ${this._showAddLan ? html`
        <div class="lan-form">
          <h4>Add LAN share (SMB)</h4>
          <div class="fields">
            ${(["label", "server", "share", "subpath", "username", "password"] as const).map(k => html`
              <label>${k}
                <input type="${k === "password" ? "password" : "text"}"
                       .value=${this._lanForm[k]}
                       @input=${(e: Event) => {
                         this._lanForm = {
                           ...this._lanForm,
                           [k]: (e.target as HTMLInputElement).value,
                         };
                       }} />
              </label>`)}
          </div>
          <div class="form-actions">
            <button class="src-btn" @click=${() => void this._addLanSource()}>Add</button>
            <button class="src-btn" @click=${() => { this._showAddLan = false; }}>Cancel</button>
          </div>
        </div>` : nothing}`;
  }

  // ---- render ----

  override render(): TemplateResult {
    void this._searchTick;  // declare reactive dependency
    return html`
      ${this._renderSourcesBar()}
      <div class="panels">
        ${this._renderSearchPanel()}
        ${this._renderPlaylistPanel()}
      </div>
    `;
  }
}
