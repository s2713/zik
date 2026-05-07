import { css, html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { getCsrfHeaders } from "../../csrf.js";
import { t } from "../../i18n/i18n.js";
import { VolumeNormalizer } from "../../audio/normalizer.js";
import { type PlayerBusCmd, type PlaylistStateEvent, playerBus } from "../../player-bus.js";
import { PlayerBase } from "../../player-base.js";
import { FilesPlayer, type FileTrack, type FilesPlayerState } from "./files-player.js";

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

interface PlaylistEntry {
  track: FileTrack;
  uid:   number;   // unique per addition; stable through reorder
}

// ---- helpers ----

/** Format seconds as m:ss or h:mm:ss. */
function fmtDuration(totalSecs: number): string {
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = Math.floor(totalSecs % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
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
 * Files service player: two-panel search + playlist UI.
 * Left panel: library search with artist/album/year/track filters and source checkboxes.
 * Right panel: playlist with drag-and-drop reorder, multi-select, and playback controls.
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
    .result-row:hover { background: rgba(255,255,255,0.05); }
    .result-row[draggable] { cursor: grab; }
    /* Visual hierarchy via left border; indentation via padding on the first cell only
       so all other columns stay aligned with the header. */
    .result-row.row-album { border-left: 3px solid #334155; }
    .result-row.row-track  { border-left: 3px solid #475569; }
    .result-row.row-album > :first-child { padding-left: 0.65rem; }
    .result-row.row-track  > :first-child { padding-left: 1.3rem; }

    .expand-icon {
      color: #475569; font-size: 0.75em; user-select: none;
      display: inline-block; transition: transform 0.15s;
    }
    .expand-icon.open { transform: rotate(90deg); }

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

    /* ---- playlist panel ---- */
    .playlist-panel { display: flex; flex-direction: column; overflow: hidden; }
    .playlist-controls {
      flex-shrink: 0;
      display: flex; align-items: center; gap: 0.3rem; flex-wrap: wrap;
      padding: 0.5rem 0.75rem;
      background: #1e293b;
      border-bottom: 1px solid #334155;
      font-size: 0.82rem;
    }
    .pl-ctrl {
      padding: 0.55em 0.9em; border-radius: 4px;
      background: #334155; border: none; color: #f1f5f9; cursor: pointer; font-size: 0.95em;
      display: inline-flex; align-items: center; justify-content: center; line-height: 1;
    }
    .pl-ctrl:hover { background: #475569; }
    .pl-ctrl.active { background: #1d4ed8; }
    .pl-ctrl:disabled { opacity: 0.4; cursor: default; }
    .sort-sep { color: #475569; padding: 0 0.1rem; }
    .pl-count { margin-left: auto; color: #64748b; font-size: 0.78em; }

    /* playlist track list */
    .playlist-list { flex: 1; overflow-y: auto; }
    .pl-row {
      display: grid;
      grid-template-columns: 28px 32px 1fr 1fr 3em 5em;
      align-items: center; gap: 0.3rem;
      padding: 0.2rem 0.5rem;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      user-select: none; cursor: pointer;
    }
    .pl-row:hover { background: rgba(255,255,255,0.04); }
    .pl-row.selected { background: rgba(96,165,250,0.15); }
    .pl-row.playing  { background: rgba(96,165,250,0.22); font-weight: 600; }
    .pl-row.drop-above { border-top: 2px solid #60a5fa; }
    .pl-row[draggable] { cursor: grab; }
    .pl-num  { font-size: 0.72em; color: #64748b; text-align: right; padding-right: 0.2rem; }
    .pl-art  { width: 32px; height: 32px; object-fit: cover; border-radius: 3px; }
    .pl-art-ph { width: 32px; height: 32px; border-radius: 3px;
                 background: #334155; display: flex; align-items: center;
                 justify-content: center; font-size: 0.9rem; color: #475569; }
    .pl-cell { font-size: 0.8em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
               min-width: 0; }
    .pl-cell.dim { color: #64748b; font-size: 0.72em; }
    .pl-drop-end {
      height: 4px;
      background: transparent;
    }
    .pl-drop-end.drop-above { background: #60a5fa; border-radius: 2px; }

    /* empty states */
    .empty { color: #475569; font-size: 0.85em; padding: 1.5rem; text-align: center; }

    /* scan button and normalizer */
    .scan-btn { font-size: 0.75em; }
    .norm-btn { font-size: 0.95em; padding: 0.55em 0.85em; border-radius: 3px;
                background: #334155; border: none; color: #94a3b8; cursor: pointer; }
    .norm-btn.on { background: #0f4c75; color: #7dd3fc; }
    .norm-btn:disabled { opacity: 0.4; cursor: default; }
  `;

  // ---- audio engine ----
  private readonly _player     = new FilesPlayer();
  private readonly _normalizer = new VolumeNormalizer();

  // ---- state ----
  @state() private _ps: FilesPlayerState = { ...this._player.state };
  @state() private _tracks:         FileTrack[]      = [];
  @state() private _sources:        Source[]         = [];
  @state() private _enabledSources: Set<string>      = new Set(["internal"]);
  @state() private _playlist:       PlaylistEntry[]  = [];
  @state() private _currentIndex    = -1;
  @state() private _selected:       Set<number>      = new Set();
  @state() private _dropIndex:      number | null    = null;  // drag-over target in playlist
  @state() private _showAddLan      = false;
  @state() private _normalizeOn     = false;
  @state() private _normalizeBlocked = false;
  @state() private _expandedArtists: Set<string> = new Set();
  @state() private _expandedAlbums:  Set<string> = new Set();
  @state() private _sortCol: SortCol = "artist";
  @state() private _sortDir: 1 | -1  = 1;

  // search fields (not @state to avoid per-keystroke re-renders; debounced manually)
  private _qArtist = "";
  private _qAlbum  = "";
  private _qYear   = "";
  private _qTrack  = "";
  @state() private _searchTick = 0;  // bumped by debounce to trigger re-render

  private _lanForm: LanForm = { label: "", server: "", share: "",
                                 subpath: "", username: "", password: "" };
  private _uidCounter   = 0;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // artist-image cache: name → URL | null (null = not found / pending)
  private _artistImages: Record<string, string | null> = {};
  // anchor for shift-click range selection; set on every non-shift click
  private _selectionAnchor = -1;

  // ---- bus handler ----
  private readonly _onBusCmd = (e: Event): void => {
    const cmd = (e as CustomEvent<PlayerBusCmd>).detail;
    if (cmd.serviceId !== "files") return;
    const ps = this._ps;
    switch (cmd.type) {
      case "Play":      if (ps.status === "paused") this._resume(); break;
      case "Pause":     this._pause();    break;
      case "Stop":      this._stop();     break;
      case "Next":      this._playNext(); break;
      case "Previous":  this._playPrev(); break;
      case "SetVolume": this._player.setVolume(cmd.volume); break;
    }
  };

  private readonly _onStateChange = (e: Event): void => {
    this._ps = (e as CustomEvent<FilesPlayerState>).detail;
    this._dispatchPlaylistState();
  };

  private _dispatchPlaylistState(): void {
    const totalDuration = this._playlist.reduce((s, e) => s + e.track.duration, 0);
    playerBus.dispatchEvent(new CustomEvent<PlaylistStateEvent>("playlist-state", {
      detail: {
        serviceId: "files",
        index: this._currentIndex,
        total: this._playlist.length,
        totalDuration,
        position: this._ps.position,
        duration: this._ps.track?.duration ?? 0,
      },
    }));
  }

  // Auto-advance when a track ends naturally (fires before statechange → stopped).
  private readonly _onTrackEnded = (): void => { this._playNext(); };

  // Remove selected tracks when Delete or Backspace is pressed outside any input.
  private readonly _onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (this._selected.size === 0) return;
    const target = e.composedPath()[0];
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    this._removeSelected();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this._player.addEventListener("statechange",   this._onStateChange);
    this._player.audioElement.addEventListener("ended", this._onTrackEnded);
    playerBus.addEventListener("cmd", this._onBusCmd);
    document.addEventListener("keydown", this._onKeyDown);
    void this._fetchSources();
    void this._fetchTracks();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._player.removeEventListener("statechange",   this._onStateChange);
    this._player.audioElement.removeEventListener("ended", this._onTrackEnded);
    playerBus.removeEventListener("cmd", this._onBusCmd);
    document.removeEventListener("keydown", this._onKeyDown);
    this._player.stop();
    this._normalizer.disconnect();
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

  // ---- playlist management ----

  private _nextUid(): number { return this._uidCounter++; }

  private _appendTracks(tracks: FileTrack[]): void {
    this._playlist = [...this._playlist,
      ...tracks.map(t => ({ track: t, uid: this._nextUid() }))];
    this._dispatchPlaylistState();
  }

  private _addAfterCurrent(tracks: FileTrack[]): void {
    const ins = this._currentIndex + 1;
    const entries = tracks.map(t => ({ track: t, uid: this._nextUid() }));
    this._playlist = [
      ...this._playlist.slice(0, ins),
      ...entries,
      ...this._playlist.slice(ins),
    ];
    this._dispatchPlaylistState();
  }

  private _playNow(tracks: FileTrack[]): void {
    const ins = this._currentIndex + 1;
    const entries = tracks.map(t => ({ track: t, uid: this._nextUid() }));
    this._playlist = [
      ...this._playlist.slice(0, ins),
      ...entries,
      ...this._playlist.slice(ins),
    ];
    this._playAt(ins);
  }

  private _playAt(index: number): void {
    if (index < 0 || index >= this._playlist.length) return;
    this._currentIndex = index;
    this._selected = new Set();
    const track = this._playlist[index].track;
    this._player.play(track, `/api/files/audio/${track.id}`);
    this._connectNormalizer();
    void this._postCommand("Play", track);
    this._dispatchPlaylistState();
  }

  private _playNext(): void {
    if (this._currentIndex + 1 < this._playlist.length)
      this._playAt(this._currentIndex + 1);
  }

  private _playPrev(): void {
    if (this._currentIndex > 0)
      this._playAt(this._currentIndex - 1);
  }

  private _removeSelected(): void {
    const del = this._selected;
    const newPl = this._playlist.filter((_, i) => !del.has(i));
    // Adjust currentIndex: count how many deleted entries were before it.
    const removedBefore = [...del].filter(i => i < this._currentIndex).length;
    let newIdx = this._currentIndex - removedBefore;
    if (del.has(this._currentIndex)) {
      // The playing track was deleted; stop and reset.
      this._player.stop();
      newIdx = Math.min(this._currentIndex - removedBefore, newPl.length - 1);
    }
    this._playlist = newPl;
    this._currentIndex = newIdx;
    this._selected = new Set();
    this._selectionAnchor = -1;
    this._dispatchPlaylistState();
  }

  private _clearPlaylist(): void {
    this._player.stop();
    void this._postCommand("Stop");
    this._playlist = [];
    this._currentIndex = -1;
    this._selected = new Set();
    this._selectionAnchor = -1;
    this._dispatchPlaylistState();
  }

  private _shufflePlaylist(): void {
    const currentUid = this._playlist[this._currentIndex]?.uid ?? null;
    const shuffled = [...this._playlist].sort(() => Math.random() - 0.5);
    this._playlist = shuffled;
    this._currentIndex = currentUid !== null
      ? shuffled.findIndex(e => e.uid === currentUid)
      : -1;
    this._dispatchPlaylistState();
  }

  private _sortPlaylist(by: "artist" | "year" | "album"): void {
    const currentUid = this._playlist[this._currentIndex]?.uid ?? null;
    const sorted = [...this._playlist].sort((a, b) => {
      const ta = a.track; const tb = b.track;
      if (by === "artist")
        return ta.artist.localeCompare(tb.artist) ||
               ta.album.localeCompare(tb.album) ||
               ((ta.track_number ?? 999) - (tb.track_number ?? 999));
      if (by === "year")
        return ((ta.year ?? 0) - (tb.year ?? 0)) ||
               ta.artist.localeCompare(tb.artist) ||
               ta.album.localeCompare(tb.album);
      // album
      return ta.album.localeCompare(tb.album) ||
             ta.artist.localeCompare(tb.artist) ||
             ((ta.track_number ?? 999) - (tb.track_number ?? 999));
    });
    this._playlist = sorted;
    this._currentIndex = currentUid !== null
      ? sorted.findIndex(e => e.uid === currentUid) : -1;
    this._dispatchPlaylistState();
  }

  /** Move dragged playlist indices to just before `toIndex`. */
  private _movePlaylistItems(fromIndices: number[], toIndex: number): void {
    const fromSet = new Set(fromIndices);
    const items = fromIndices.sort((a, b) => a - b).map(i => this._playlist[i]);
    const rest  = this._playlist.filter((_, i) => !fromSet.has(i));
    const removedBefore = fromIndices.filter(i => i < toIndex).length;
    const insertAt = Math.max(0, Math.min(toIndex - removedBefore, rest.length));
    const newPl = [...rest.slice(0, insertAt), ...items, ...rest.slice(insertAt)];
    const currentUid = this._playlist[this._currentIndex]?.uid ?? null;
    this._playlist = newPl;
    this._currentIndex = currentUid !== null
      ? newPl.findIndex(e => e.uid === currentUid) : -1;
    this._selected = new Set();
    this._dispatchPlaylistState();
  }

  // ---- playback control ----

  private _pause(): void { this._player.pause(); void this._postCommand("Pause"); }
  private _resume(): void { this._player.resume(); void this._postCommand("Play"); }
  private _stop(): void { this._player.stop(); void this._postCommand("Stop"); }

  private _connectNormalizer(): void {
    if (!VolumeNormalizer.isSameOrigin(this._player.audioElement.src)) {
      this._normalizeBlocked = true; this._normalizer.disable(); return;
    }
    if (this._normalizer.blocked) { this._normalizeBlocked = true; return; }
    const ok = this._normalizer.connect(this._player.audioElement);
    this._normalizeBlocked = !ok;
    if (ok && this._normalizeOn) this._normalizer.enable();
  }

  private _toggleNormalize(): void {
    if (this._normalizeBlocked) return;
    this._normalizeOn = !this._normalizeOn;
    this._normalizeOn ? this._normalizer.enable() : this._normalizer.disable();
  }

  private async _postCommand(type: string, track?: FileTrack): Promise<void> {
    const ps = this._player.state;
    const tr = track ?? ps.track;
    try {
      await fetch("/api/player/command", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({
          type,
          service:  "files",
          track_id:  tr?.id       ?? "",
          title:     tr?.title    ?? "",
          duration:  tr?.duration ?? 0,
          artist:    tr?.artist   ?? "",
          album:     tr?.album    ?? "",
          art_url:   tr ? `/api/files/cover/${tr.id}` : "",
          position:  ps.position,
          volume:    ps.volume,
        }),
      });
    } catch { /* backend unavailable */ }
  }

  // ---- drag-and-drop ----

  private _onSearchDragStart(e: DragEvent, tracks: FileTrack[]): void {
    e.dataTransfer!.effectAllowed = "copy";
    e.dataTransfer!.setData("files-tracks", JSON.stringify(tracks.map(t => t.id)));
  }

  private _onPlaylistDragStart(e: DragEvent, index: number): void {
    if (!this._selected.has(index)) this._selected = new Set([index]);
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("playlist-indices", JSON.stringify([...this._selected]));
  }

  private _onPlaylistDragOver(e: DragEvent, index: number): void {
    const types = e.dataTransfer?.types ?? [];
    if (types.includes("files-tracks") || types.includes("playlist-indices")) {
      e.preventDefault();
      if (this._dropIndex !== index) this._dropIndex = index;
    }
  }

  private _onPlaylistDrop(e: DragEvent, index: number): void {
    e.preventDefault();
    const types = e.dataTransfer?.types ?? [];
    if (types.includes("playlist-indices")) {
      const indices: number[] = JSON.parse(e.dataTransfer!.getData("playlist-indices"));
      this._movePlaylistItems(indices, index);
    } else if (types.includes("files-tracks")) {
      const ids: string[] = JSON.parse(e.dataTransfer!.getData("files-tracks"));
      const trackMap = new Map(this._tracks.map(t => [t.id, t]));
      const tracks = ids.map(id => trackMap.get(id)).filter(Boolean) as FileTrack[];
      const entries = tracks.map(t => ({ track: t, uid: this._nextUid() }));
      const pl = [...this._playlist];
      pl.splice(index, 0, ...entries);
      const currentUid = this._playlist[this._currentIndex]?.uid ?? null;
      this._playlist = pl;
      this._currentIndex = currentUid !== null ? pl.findIndex(e => e.uid === currentUid) : -1;
    }
    this._dropIndex = null;
  }

  private _onPlaylistDragLeave(): void { this._dropIndex = null; }

  // ---- playlist row click (multi-select) ----

  private _onPlaylistClick(e: MouseEvent, index: number): void {
    if (e.shiftKey && this._selectionAnchor >= 0) {
      // Range select from anchor to clicked row; replaces current selection.
      const lo = Math.min(this._selectionAnchor, index);
      const hi = Math.max(this._selectionAnchor, index);
      const next = new Set<number>();
      for (let i = lo; i <= hi; i++) next.add(i);
      this._selected = next;
      // anchor stays fixed until the next plain/ctrl click
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(this._selected);
      if (next.has(index)) next.delete(index); else next.add(index);
      this._selected = next;
      this._selectionAnchor = index;
    } else {
      // Plain click: select only this row; use ▶ in the playlist bar to play.
      this._selected = new Set([index]);
      this._selectionAnchor = index;
    }
  }

  // ---- source label lookup ----

  private _sourceLabel(sourceId: string): string {
    return this._sources.find(s => s.id === sourceId)?.label ?? sourceId;
  }

  // ---- rendering: cover art helpers ----

  private _artImg(trackId: string, cls: string): TemplateResult {
    return html`<img class="${cls}" src="/api/files/cover/${trackId}"
      @error=${(e: Event) => { (e.target as HTMLImageElement).style.display = "none"; }}
      alt="" />`;
  }

  private _artPlaceholder(cls: string, icon = "♪"): TemplateResult {
    return html`<div class="${cls}">${icon}</div>`;
  }

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

  /** Append / add-after-current / play-now action buttons for a track set. */
  private _renderActions(tracks: FileTrack[]): TemplateResult {
    return html`
      <div class="row-actions">
        <button class="row-act" title="Append"
                @click=${(e: Event) => { e.stopPropagation(); this._appendTracks(tracks); }}>+</button>
        <button class="row-act" title="After current"
                @click=${(e: Event) => { e.stopPropagation(); this._addAfterCurrent(tracks); }}>⏭</button>
        <button class="row-act play-now" title="Play now"
                @click=${(e: Event) => { e.stopPropagation(); this._playNow(tracks); }}>▶</button>
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
    return html`
      <div class="result-header">
        <span></span><span></span>
        ${h("artist", t("files.artist"))}
        ${h("album",  t("files.album"))}
        ${h("track",  t("files.track"))}
        ${h("year",   t("files.year"))}
        ${h("source", "Source")}
        <span style="color:#64748b">Action</span>
      </div>`;
  }

  /** Hierarchical artist → album → track tree (default and artist-only mode). */
  private _renderArtistList(tracks: FileTrack[]): TemplateResult {
    const artists = this._groupByArtist(tracks);
    if (artists.length === 0) return html`<div class="empty">No artists found</div>`;
    return html`${artists.map(([name, aTracks]) => {
      const expanded = this._expandedArtists.has(name);
      const albums   = this._groupByAlbum(aTracks);
      return html`
        <div class="result-row" draggable="true"
             @dragstart=${(e: DragEvent) => this._onSearchDragStart(e, aTracks)}
             @click=${() => {
               const s = new Set(this._expandedArtists);
               if (expanded) s.delete(name); else s.add(name);
               this._expandedArtists = s;
             }}>
          <span class="expand-icon ${expanded ? "open" : ""}">▶</span>
          ${this._artistImgCell(name)}
          <span class="row-cell strong" title="${name}">${name}</span>
          <span class="row-cell dim">${albums.length} album${albums.length !== 1 ? "s" : ""}</span>
          <span class="row-cell dim">${aTracks.length} track${aTracks.length !== 1 ? "s" : ""}</span>
          <span class="row-cell"></span>
          <span class="row-cell"></span>
          ${this._renderActions(aTracks)}
        </div>
        ${expanded ? albums.map(([albumKey, alTracks]) => {
          const albExpanded = this._expandedAlbums.has(albumKey);
          const first = alTracks[0];
          return html`
            <div class="result-row row-album" draggable="true"
                 @dragstart=${(e: DragEvent) => this._onSearchDragStart(e, alTracks)}
                 @click=${() => {
                   const s = new Set(this._expandedAlbums);
                   if (albExpanded) s.delete(albumKey); else s.add(albumKey);
                   this._expandedAlbums = s;
                 }}>
              <span class="expand-icon ${albExpanded ? "open" : ""}">▶</span>
              ${this._artImgCell(first.id)}
              <span class="row-cell dim">${first.artist}</span>
              <span class="row-cell strong" title="${first.album}">${first.album || "(no album)"}</span>
              <span class="row-cell dim">${alTracks.length} track${alTracks.length !== 1 ? "s" : ""}</span>
              <span class="row-cell dim">${first.year ?? ""}</span>
              <span class="row-cell dim">${this._sourceLabel(first.source_id)}</span>
              ${this._renderActions(alTracks)}
            </div>
            ${albExpanded ? this._sortedTracks(alTracks).map(tr => html`
              <div class="result-row row-track" draggable="true"
                   @dragstart=${(e: DragEvent) => this._onSearchDragStart(e, [tr])}>
                <span></span>
                ${this._artImgCell(tr.id)}
                <span class="row-cell dim">${tr.artist}</span>
                <span class="row-cell dim">${tr.album}</span>
                <span class="row-cell" title="${tr.title}">${tr.title}</span>
                <span class="row-cell dim">${tr.year ?? ""}</span>
                <span class="row-cell dim">${this._sourceLabel(tr.source_id)}</span>
                ${this._renderActions([tr])}
              </div>
            `) : nothing}
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
      const expanded = this._expandedAlbums.has(key);
      const first = alTracks[0];
      return html`
        <div class="result-row" draggable="true"
             @dragstart=${(e: DragEvent) => this._onSearchDragStart(e, alTracks)}
             @click=${() => {
               const s = new Set(this._expandedAlbums);
               if (expanded) s.delete(key); else s.add(key);
               this._expandedAlbums = s;
             }}>
          <span class="expand-icon ${expanded ? "open" : ""}">▶</span>
          ${this._artImgCell(first.id)}
          <span class="row-cell" title="${first.artist}">${first.artist}</span>
          <span class="row-cell strong" title="${first.album}">${first.album || "(no album)"}</span>
          <span class="row-cell dim">${alTracks.length} track${alTracks.length !== 1 ? "s" : ""}</span>
          <span class="row-cell dim">${first.year ?? ""}</span>
          <span class="row-cell dim">${this._sourceLabel(first.source_id)}</span>
          ${this._renderActions(alTracks)}
        </div>
        ${expanded ? this._sortedTracks(alTracks).map(tr => html`
          <div class="result-row row-track" draggable="true"
               @dragstart=${(e: DragEvent) => this._onSearchDragStart(e, [tr])}>
            <span></span>
            ${this._artImgCell(tr.id)}
            <span class="row-cell dim">${tr.artist}</span>
            <span class="row-cell dim">${tr.album}</span>
            <span class="row-cell" title="${tr.title}">${tr.title}</span>
            <span class="row-cell dim">${tr.year ?? ""}</span>
            <span class="row-cell dim">${this._sourceLabel(tr.source_id)}</span>
            ${this._renderActions([tr])}
          </div>
        `) : nothing}
      `;
    })}`;
  }

  /** Flat sorted track list (track-name search mode). */
  private _renderTrackList(tracks: FileTrack[]): TemplateResult {
    const sorted = this._sortedTracks(tracks);
    if (sorted.length === 0) return html`<div class="empty">No tracks found</div>`;
    return html`${sorted.map(tr => html`
      <div class="result-row" draggable="true"
           @dragstart=${(e: DragEvent) => this._onSearchDragStart(e, [tr])}>
        <span></span>
        ${this._artImgCell(tr.id)}
        <span class="row-cell" title="${tr.artist}">${tr.artist}</span>
        <span class="row-cell dim" title="${tr.album}">${tr.album}</span>
        <span class="row-cell strong" title="${tr.title}">${tr.title}</span>
        <span class="row-cell dim">${tr.year ?? ""}</span>
        <span class="row-cell dim">${this._sourceLabel(tr.source_id)}</span>
        ${this._renderActions([tr])}
      </div>
    `)}`;
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
    const hasSel  = this._selected.size > 0;
    const pl      = this._playlist;

    return html`
      <div class="playlist-panel">
        <div class="playlist-controls">

          <!-- always starts from beginning; footer bar handles pause/resume -->
          <button class="pl-ctrl" title="Play from beginning"
                  @click=${() => this._playAt(0)}
                  ?disabled=${pl.length === 0}>▶</button>

          <!-- selection ops -->
          <button class="pl-ctrl" title="Remove selected"
                  ?disabled=${!hasSel}
                  @click=${() => this._removeSelected()}>🗑</button>
          <button class="pl-ctrl" title="Clear playlist"
                  ?disabled=${pl.length === 0}
                  @click=${() => this._clearPlaylist()}>🔥</button>
          <button class="pl-ctrl" title="Shuffle"
                  ?disabled=${pl.length < 2}
                  @click=${() => this._shufflePlaylist()}>🔀</button>

          <!-- sort -->
          <span class="sort-sep">|</span>
          <button class="pl-ctrl" title="Sort by artist → album"
                  @click=${() => this._sortPlaylist("artist")}>Artist</button>
          <button class="pl-ctrl" title="Sort by year → artist → album"
                  @click=${() => this._sortPlaylist("year")}>Year</button>
          <button class="pl-ctrl" title="Sort by album → artist"
                  @click=${() => this._sortPlaylist("album")}>Album</button>

          <!-- normalizer -->
          <span class="sort-sep">|</span>
          <button class="norm-btn ${this._normalizeOn ? "on" : ""}"
                  ?disabled=${this._normalizeBlocked}
                  title="Volume normalizer"
                  @click=${() => this._toggleNormalize()}>≈ Norm</button>

          <span class="pl-count">${pl.length} track${pl.length !== 1 ? "s" : ""}${pl.length > 0 ? ` · ${fmtDuration(pl.reduce((s, e) => s + e.track.duration, 0))}` : ""}</span>
        </div>

        <div class="playlist-list"
             @dragover=${(e: DragEvent) => this._onPlaylistDragOver(e, pl.length)}
             @drop=${(e: DragEvent) => this._onPlaylistDrop(e, pl.length)}
             @dragleave=${() => this._onPlaylistDragLeave()}>
          ${pl.length === 0
            ? html`<div class="empty">Playlist is empty — drag tracks here or use ▶ / + / ⏭</div>`
            : pl.map((entry, i) => {
                const tr      = entry.track;
                const isCur   = i === this._currentIndex;
                const isSel   = this._selected.has(i);
                const isDrop  = this._dropIndex === i;
                return html`
                  <div class="pl-row ${isCur ? "playing" : ""} ${isSel ? "selected" : ""} ${isDrop ? "drop-above" : ""}"
                       draggable="true"
                       @click=${(e: MouseEvent) => this._onPlaylistClick(e, i)}
                       @dblclick=${(e: MouseEvent) => { e.stopPropagation(); this._playAt(i); }}
                       @dragstart=${(e: DragEvent) => this._onPlaylistDragStart(e, i)}
                       @dragover=${(e: DragEvent) => { e.stopPropagation(); this._onPlaylistDragOver(e, i); }}
                       @drop=${(e: DragEvent) => { e.stopPropagation(); this._onPlaylistDrop(e, i); }}
                       @dragleave=${(e: DragEvent) => { e.stopPropagation(); this._onPlaylistDragLeave(); }}>
                    <span class="pl-num">${i + 1}</span>
                    <!-- overflow:hidden clips the placeholder behind the img; on img error
                         img becomes display:none and placeholder shows at offset 0 -->
                    <div style="position:relative;width:32px;height:32px;overflow:hidden;flex-shrink:0;">
                      ${this._artImg(tr.id, "pl-art")}
                      ${this._artPlaceholder("pl-art-ph")}
                    </div>
                    <span class="pl-cell" title="${tr.title}">${tr.title}</span>
                    <span class="pl-cell dim" title="${tr.artist}">${tr.artist}</span>
                    <span class="pl-cell dim">${tr.year ?? ""}</span>
                    <span class="pl-cell dim">${this._sourceLabel(tr.source_id)}</span>
                  </div>`;
              })}
          <!-- drop-zone at end -->
          <div class="pl-drop-end ${this._dropIndex === pl.length ? "drop-above" : ""}"
               @dragover=${(e: DragEvent) => this._onPlaylistDragOver(e, pl.length)}
               @drop=${(e: DragEvent) => this._onPlaylistDrop(e, pl.length)}>
          </div>
        </div>
      </div>`;
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
