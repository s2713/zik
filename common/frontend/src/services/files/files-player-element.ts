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
  root?: string;   // absolute path on the backend; used to strip prefix for relative paths
  config?: Record<string, string>;
}

interface LanForm {
  label: string; server: string; share: string;
  subpath: string; username: string; password: string;
}

// ---- FS tree types ----

interface FsDir {
  kind: "dir";
  name: string;
  key: string;          // unique: "s:{sourceId}" for roots, "d:{sourceId}::{relPath}" for subdirs
  children: FsNode[];
  allTracks: FileTrack[]; // all tracks in this subtree
}

interface FsFile {
  kind: "file";
  track: FileTrack;
}

type FsNode = FsDir | FsFile;

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

/** Format seconds as M:SS. */
function fmtDur(s: number): string {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

/**
 * Return the longest common directory prefix of a list of absolute paths.
 * Result always ends with "/" so it can be used directly as a strip prefix.
 * Returns "" when the list is empty or no common prefix exists.
 */
function commonDirPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  // Start from the shortest path's parent directory.
  let prefix = paths[0].slice(0, paths[0].lastIndexOf("/") + 1);
  for (const p of paths) {
    while (prefix && !p.startsWith(prefix)) {
      // Walk up one directory level.
      prefix = prefix.slice(0, prefix.lastIndexOf("/", prefix.length - 2) + 1);
    }
  }
  return prefix;
}

/** Recursively sort a dir's children: subdirs alphabetically first, then files by track_number/title. */
function sortFsDir(dir: FsDir): void {
  dir.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    if (a.kind === "dir" && b.kind === "dir") return a.name.localeCompare(b.name);
    if (a.kind === "file" && b.kind === "file") {
      const tn = (a.track.track_number ?? 9999) - (b.track.track_number ?? 9999);
      return tn !== 0 ? tn : a.track.title.localeCompare(b.track.title);
    }
    return 0;
  });
  for (const c of dir.children) if (c.kind === "dir") sortFsDir(c);
}

/**
 * Files service player: two-panel FS tree + queue UI.
 * Left panel: filesystem hierarchy with metadata filters and path/name search.
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
    .search-fields .sep { grid-column: 1 / -1; border: none; border-top: 1px solid #1e293b; margin: 0.1rem 0; }
    .search-results { flex: 1; overflow-y: auto; padding: 0.25rem 0; }

    /* ---- FS tree rows ---- */
    .fs-node {
      display: flex; align-items: center; gap: 0.4rem;
      padding: 0.25rem 0.5rem;
      border-bottom: 1px solid rgba(255,255,255,0.03);
      min-width: 0;
    }
    .fs-node:hover { background: rgba(255,255,255,0.05); }
    .fs-node.is-dir { background: rgba(255,255,255,0.02); }
    .fs-node.is-dir:hover { background: rgba(255,255,255,0.06); }
    /* selected must come last to win over is-dir with equal specificity */
    .fs-node.selected,
    .fs-node.is-dir.selected { background: rgba(96,165,250,0.22); }
    .fs-node[draggable] { cursor: grab; }

    .node-expander {
      flex-shrink: 0;
      color: #475569; font-size: 0.75em; user-select: none;
      display: inline-flex; align-items: center; justify-content: center;
      width: 1.4em; height: 1.4em; transition: transform 0.15s;
      background: none; border: none; padding: 0; cursor: pointer;
    }
    .node-expander:hover { color: #94a3b8; }
    .node-expander.open { transform: rotate(90deg); }
    /* placeholder for leaf nodes to keep names aligned */
    .node-expander-ph { width: 1.4em; flex-shrink: 0; }

    .node-thumb-wrap {
      flex-shrink: 0; width: 28px; height: 28px;
      border-radius: 3px; overflow: hidden; position: relative;
    }
    .node-thumb-ph {
      width: 28px; height: 28px; border-radius: 3px;
      background: #334155; display: flex; align-items: center;
      justify-content: center; font-size: 0.8em; color: #475569;
    }

    .node-name {
      flex: 1; min-width: 0;
      font-size: 0.83em; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .node-name.dir-name { font-weight: 600; color: #e2e8f0; }

    .node-meta {
      flex-shrink: 0; display: flex; gap: 0.5rem; align-items: center;
      font-size: 0.74em; color: #64748b; white-space: nowrap;
    }

    /* selection indicator */
    .sel-info  { color: #7dd3fc; font-size: 0.78em; margin-left: 0.5em; }
    .sel-clear {
      margin-left: 0.25em; font-size: 0.85em;
      background: none; border: none; color: #94a3b8; cursor: pointer; padding: 0;
    }
    .sel-clear:hover { color: #f1f5f9; }

    /* action buttons */
    .row-actions { display: flex; gap: 2px; flex-shrink: 0; }
    .row-act {
      font-size: 0.85em; padding: 0.4em 0.65em;
      background: #334155; border: none; color: #f1f5f9;
      border-radius: 3px; cursor: pointer;
    }
    .row-act:hover { background: #475569; }
    .row-act.play-now { background: #1d4ed8; }
    .row-act.play-now:hover { background: #2563eb; }

    /* tree info bar */
    .tree-info {
      flex-shrink: 0;
      padding: 0.2rem 0.75rem;
      background: #1e293b; border-bottom: 1px solid #334155;
      font-size: 0.75em; color: #64748b;
      display: flex; align-items: center; gap: 0.75rem;
    }

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
  @state() private _expandedDirs:   Set<string>      = new Set();
  @state() private _scanning        = false;

  // search fields (not @state; debounced via _searchTick)
  private _qArtist = "";
  private _qAlbum  = "";
  private _qYear   = "";
  private _qTrack  = "";
  private _qPath   = "";
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
      await this._fetchSources();
      await this._pollScanDone();
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

  /** Poll /api/files/scan/status every 800 ms until the backend reports idle,
   *  keeping _scanning true while in progress, then refresh the track list. */
  private async _pollScanDone(): Promise<void> {
    this._scanning = true;
    try {
      // Give the backend a moment to flip the source to "running" before we start polling.
      await new Promise((r) => setTimeout(r, 300));
      while (true) {
        const r = await fetch("/api/files/scan/status");
        const data = await r.json() as { scanning: boolean };
        if (!data.scanning) break;
        await new Promise((r) => setTimeout(r, 800));
      }
      await this._fetchTracks();
    } catch { /* backend unavailable */ }
    finally { this._scanning = false; }
  }

  private async _scan(): Promise<void> {
    try {
      const r = await fetch("/api/files/scan", { method: "POST", headers: { ...getCsrfHeaders() } });
      if (!r.ok) return;
      await this._pollScanDone();
    } catch { /* backend unavailable */ }
  }

  // ---- search / filter ----

  private _debounceSearch(): void {
    if (this._debounceTimer !== null) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => { this._searchTick++; }, 150);
  }

  /** Return true when any filter field is non-empty. */
  private _anyFilterActive(): boolean {
    return !!(this._qArtist.trim() || this._qAlbum.trim() || this._qYear.trim()
           || this._qTrack.trim()  || this._qPath.trim());
  }

  /**
   * Per-source path prefixes derived from the FULL library (all tracks, unfiltered).
   * Using the full set guarantees the prefix is stable regardless of what filter is
   * active — filtering down to a single directory must not cause that directory to be
   * absorbed into the prefix and disappear from the tree.
   */
  private _sourcePrefixes(): Map<string, string> {
    const bySource = new Map<string, string[]>();
    for (const t of this._tracks) {
      if (!bySource.has(t.source_id)) bySource.set(t.source_id, []);
      bySource.get(t.source_id)!.push(t.path);
    }
    return new Map([...bySource.entries()].map(([sid, paths]) =>
      [sid, commonDirPrefix(paths)]
    ));
  }

  /** Apply all active filter fields and return matching tracks. */
  private _filteredTracks(): FileTrack[] {
    let tracks = this._tracks.filter(t => this._enabledSources.has(t.source_id));
    const qa = this._qArtist.trim().toLowerCase();
    const qb = this._qAlbum.trim().toLowerCase();
    const yr = parseYearFilter(this._qYear);
    const qt = this._qTrack.trim().toLowerCase();
    const qp = this._qPath.trim().toLowerCase();
    if (qa) tracks = tracks.filter(t => t.artist.toLowerCase().includes(qa));
    if (qb) tracks = tracks.filter(t => t.album.toLowerCase().includes(qb));
    if (yr) tracks = tracks.filter(t => t.year !== null && t.year >= yr.from && t.year <= yr.to);
    if (qt) tracks = tracks.filter(t => t.title.toLowerCase().includes(qt));
    if (qp) {
      const prefixes = this._sourcePrefixes();
      tracks = tracks.filter(t => {
        const pfx = prefixes.get(t.source_id) ?? "";
        const rel = pfx && t.path.startsWith(pfx) ? t.path.slice(pfx.length) : t.path.replace(/^\//, "");
        return rel.toLowerCase().split("/").filter(Boolean).some(p => p.includes(qp));
      });
    }
    return tracks;
  }

  // ---- FS tree builder ----

  /**
   * Build a forest of FsDir roots, one per active source with matching tracks.
   * Each source root contains nested FsDir and FsFile children reflecting the actual filesystem.
   */
  private _buildFsTree(tracks: FileTrack[]): FsDir[] {
    // Group tracks by source.
    const bySource = new Map<string, FileTrack[]>();
    for (const t of tracks) {
      if (!bySource.has(t.source_id)) bySource.set(t.source_id, []);
      bySource.get(t.source_id)!.push(t);
    }

    // Use full-library prefixes so filtering never collapses intermediate dirs.
    const prefixes = this._sourcePrefixes();
    const result: FsDir[] = [];

    for (const [sid, sTracks] of bySource) {
      const source  = this._sources.find(s => s.id === sid);
      const prefix  = prefixes.get(sid) ?? "";

      const rootDir: FsDir = {
        kind: "dir", name: source?.label ?? sid,
        key: `s:${sid}`, children: [], allTracks: sTracks,
      };

      for (const t of sTracks) {
        // Strip the source root prefix to get a relative path.
        const rel   = prefix && t.path.startsWith(prefix)
          ? t.path.slice(prefix.length)
          : t.path.replace(/^\//, "");  // fallback: strip leading slash only
        const parts = rel.split("/").filter(Boolean);  // remove empty segments
        const dirs  = parts.slice(0, -1);  // directory components

        // Walk or create directory nodes.
        let cur = rootDir;
        for (let i = 0; i < dirs.length; i++) {
          const dirKey = `d:${sid}::${dirs.slice(0, i + 1).join("/")}`;
          let child = cur.children.find(c => c.kind === "dir" && c.key === dirKey) as FsDir | undefined;
          if (!child) {
            child = { kind: "dir", name: dirs[i], key: dirKey, children: [], allTracks: [] };
            cur.children.push(child);
          }
          child.allTracks.push(t);
          cur = child;
        }

        cur.children.push({ kind: "file", track: t });
      }

      sortFsDir(rootDir);
      result.push(rootDir);
    }

    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }

  // ---- drag-and-drop ----

  /** Drag tracks from a row; uses selection if the row's key is selected. */
  private _onSearchDragStart(e: DragEvent, ownTracks: FileTrack[], key: string): void {
    const isSel  = this._selected.has(key);
    const tracks = isSel && this._selected.size > 0 ? this._selectedTracks() : ownTracks;
    e.dataTransfer!.effectAllowed = "copy";
    e.dataTransfer!.setData("queue-items-json", JSON.stringify(tracks.map(fileTrackToQueueItem)));
  }

  // ---- selection ----

  /**
   * Flat ordered list of all visible row keys in tree render order —
   * includes both dir/source keys and file keys, so shift-click ranges
   * work across both node types.
   */
  private _visibleKeyOrder(): string[] {
    const keys: string[] = [];
    const anyFilter = this._anyFilterActive();

    const walk = (node: FsNode) => {
      if (node.kind === "file") { keys.push(`t:${node.track.id}`); return; }
      keys.push(node.key);  // dir or source node
      const expanded = anyFilter || this._expandedDirs.has(node.key);
      if (expanded) { for (const c of node.children) walk(c); }
    };

    for (const root of this._buildFsTree(this._filteredTracks())) walk(root);
    return keys;
  }

  /**
   * Resolve the current selection to a deduplicated list of FileTrack objects.
   * Supports t: (file), d: (directory), and s: (source root) keys.
   * Tracks are drawn from the filtered set so only visible files are included.
   */
  private _selectedTracks(): FileTrack[] {
    const filtered  = this._filteredTracks();
    const prefixes  = this._sourcePrefixes();
    const result: FileTrack[] = [];
    const seen = new Set<string>();

    const add = (t: FileTrack) => { if (!seen.has(t.id)) { result.push(t); seen.add(t.id); } };

    for (const key of this._selected) {
      if (key.startsWith("t:")) {
        const t = filtered.find(tr => tr.id === key.slice(2));
        if (t) add(t);
      } else if (key.startsWith("s:")) {
        const sid = key.slice(2);
        filtered.filter(t => t.source_id === sid).forEach(add);
      } else if (key.startsWith("d:")) {
        // key format: "d:{sourceId}::{relDirPath}"
        const rest   = key.slice(2);
        const sep    = rest.indexOf("::");
        const sid    = rest.slice(0, sep);
        const relDir = rest.slice(sep + 2);
        const pfx    = prefixes.get(sid) ?? "";
        filtered.filter(t => {
          const rel = pfx && t.path.startsWith(pfx) ? t.path.slice(pfx.length) : t.path.replace(/^\//, "");
          return rel.startsWith(relDir + "/");
        }).forEach(add);
      }
    }
    return result;
  }

  /** Handle click / ctrl-click / shift-click for track row selection. */
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

  // ---- rendering helpers ----

  /** Album art thumbnail with placeholder on error. */
  private _artImgCell(trackId: string): TemplateResult {
    return html`
      <div class="node-thumb-wrap">
        <div class="node-thumb-ph">♪</div>
        <img style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"
             src="/api/files/cover/${trackId}"
             @error=${(e: Event) => { (e.target as HTMLImageElement).style.display = "none"; }}
             alt="" />
      </div>`;
  }

  /**
   * +/⏭/▶ action buttons for a row.
   * When the row's key is in the active selection, acts on the full selection instead.
   */
  private _renderActions(tracks: FileTrack[], key: string): TemplateResult {
    const isSel     = this._selected.has(key);
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

  // ---- rendering: FS tree ----

  /**
   * Render one tree node (dir or file) and, if expanded, all its children.
   * depth: indentation level (0 = source root, 1 = first subdir, …)
   * anyFilter: when true, all dirs auto-expand so matches are visible.
   */
  private _renderFsNode(node: FsNode, depth: number, anyFilter: boolean): TemplateResult[] {
    const indent = `${depth * 1.25}rem`;

    if (node.kind === "file") {
      const t    = node.track;
      const tKey = `t:${t.id}`;
      // Show metadata title; fall back to filename stem.
      const fileName = t.path.split("/").pop() ?? t.path;
      const label    = t.title || fileName.replace(/\.[^.]+$/, "");
      return [html`
        <div class="fs-node ${this._selected.has(tKey) ? "selected" : ""}"
             style="padding-left: calc(0.5rem + ${indent})"
             draggable="true"
             @click=${(e: MouseEvent) => this._onRowClick(e, tKey)}
             @dragstart=${(e: DragEvent) => this._onSearchDragStart(e, [t], tKey)}>
          <span class="node-expander-ph"></span>
          ${this._artImgCell(t.id)}
          <span class="node-name" title="${label}">${label}</span>
          <span class="node-meta">
            ${t.album || t.artist ? html`<span>${
              t.album && t.artist ? `in ${t.album} by ${t.artist}`
              : t.album           ? `in ${t.album}`
              :                     `by ${t.artist}`
            }</span>` : nothing}
            ${t.duration ? html`<span>${fmtDur(t.duration)}</span>` : nothing}
          </span>
          ${this._renderActions([t], tKey)}
        </div>`];
    }

    // Directory node.
    const expanded = anyFilter || this._expandedDirs.has(node.key);
    const rows: TemplateResult[] = [html`
      <div class="fs-node is-dir ${this._selected.has(node.key) ? "selected" : ""}"
           style="padding-left: calc(0.5rem + ${indent})"
           draggable="true"
           @click=${(e: MouseEvent) => this._onRowClick(e, node.key)}
           @dragstart=${(e: DragEvent) => this._onSearchDragStart(e, node.allTracks, node.key)}>
        <button class="node-expander ${expanded ? "open" : ""}"
                title="${expanded ? "Collapse" : "Expand"}"
                @click=${(e: MouseEvent) => {
                  e.stopPropagation();  // don't trigger row selection
                  if (anyFilter) return;
                  const s = new Set(this._expandedDirs);
                  if (expanded) s.delete(node.key); else s.add(node.key);
                  this._expandedDirs = s;
                }}>▶</button>
        <span class="node-name dir-name">${node.name}</span>
        <span class="node-meta">
          <span>${node.allTracks.length} track${node.allTracks.length !== 1 ? "s" : ""}</span>
        </span>
        ${this._renderActions(node.allTracks, node.key)}
      </div>`];

    if (expanded) {
      for (const child of node.children) {
        rows.push(...this._renderFsNode(child, depth + 1, anyFilter));
      }
    }
    return rows;
  }

  /** Render the full FS tree for all active sources. */
  private _renderFsTree(): TemplateResult {
    const filtered  = this._filteredTracks();
    const tree      = this._buildFsTree(filtered);
    const anyFilter = this._anyFilterActive();

    if (tree.length === 0) {
      return html`<div class="empty">${
        this._tracks.length === 0 ? "No files — scan a source to populate the library." : "No files match the current filters."
      }</div>`;
    }

    return html`${tree.flatMap(root => this._renderFsNode(root, 0, anyFilter))}`;
  }

  // ---- rendering: search panel ----

  private _renderSearchPanel(): TemplateResult {
    const selInfo = this._selected.size > 0
      ? html`<span class="sel-info">${this._selected.size} selected</span
          ><button class="sel-clear" title="Clear selection"
                   @click=${() => { this._selected = new Set(); this._anchor = null; }}>✕</button>`
      : nothing;

    return html`
      <div class="search-panel">
        <div class="search-fields">
          <label>${t("files.artist")}</label>
          <input type="text" .value=${live(this._qArtist)}
                 @input=${(e: Event) => { this._qArtist = (e.target as HTMLInputElement).value; this._debounceSearch(); }} />
          <label>${t("files.album")}</label>
          <input type="text" .value=${live(this._qAlbum)}
                 @input=${(e: Event) => { this._qAlbum = (e.target as HTMLInputElement).value; this._debounceSearch(); }} />
          <label>${t("files.year")}</label>
          <input type="text" placeholder="e.g. 1967 or 1965-1970"
                 .value=${live(this._qYear)}
                 @input=${(e: Event) => { this._qYear = (e.target as HTMLInputElement).value; this._debounceSearch(); }} />
          <label>${t("files.track")}</label>
          <input type="text" .value=${live(this._qTrack)}
                 @input=${(e: Event) => { this._qTrack = (e.target as HTMLInputElement).value; this._debounceSearch(); }} />
          <hr class="sep" />
          <label>Path / name</label>
          <input type="text" placeholder="folder or file name"
                 .value=${live(this._qPath)}
                 @input=${(e: Event) => { this._qPath = (e.target as HTMLInputElement).value; this._debounceSearch(); }} />
        </div>

        ${selInfo
          ? html`<div class="tree-info">${selInfo}</div>`
          : nothing}

        <div class="search-results">
          ${this._renderFsTree()}
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
        <button class="src-btn" ?disabled=${this._scanning}
                @click=${() => void this._scan()}>
          ${this._scanning ? "⟳ Scanning…" : "⟳ Scan"}
        </button>
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
