import { css, html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { getCsrfHeaders } from "../../csrf.js";
import { playerBus, type SelectionStateEvent } from "../../player-bus.js";
import { PlayerBase } from "../../player-base.js";
import { queue } from "../../queue/queue-controller.js";
import type { QueueItem } from "../../queue/queue-item.js";
import "../../queue/queue-panel-element.js";

// ---- types ----

type SortCol = "title" | "artist" | "album" | "year" | "genre";

interface SubsonicTrack {
  id:        string;
  albumId?:  string;
  title?:    string;
  artist?:   string;
  album?:    string;
  genre?:    string;
  duration?: number;  // seconds
  track?:    number;
  year?:     number;
}

interface AuthInfo {
  server: string;
  user:   string;
  token:  string;
  salt:   string;
}

interface SubsonicSource {
  id:       string;
  label:    string;
  server:   string;
  user:     string;
  password: string;
  active:   boolean;  // set by backend — currently connected
}

/** Source with client-side ping state. */
type SubsonicSourceEx = SubsonicSource & { ping_ms: number | null; ping_err: boolean; pinging: boolean };

interface SourceForm {
  label:    string;
  server:   string;
  user:     string;
  password: string;
}

// ---- helpers ----

/** Format seconds as m:ss, or --:-- when unknown. */
function fmt(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return "--:--";
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${m}:${s}`;
}

const EMPTY_FORM: SourceForm = { label: "", server: "", user: "", password: "" };

/**
 * Subsonic service player.
 * Sources bar (accounts) at top; library table with sticky column-header/search row;
 * now-playing panel at bottom. Matches the MPD player layout.
 */
@customElement("subsonic-player")
export class SubsonicPlayerElement extends PlayerBase {
  static styles = css`
    :host {
      display: flex; flex-direction: column;
      height: calc(100vh - 56px - 76px);
      font-family: sans-serif; color: #f1f5f9; background: #0f172a;
      overflow: hidden;
    }

    /* ---- sources bar ---- */
    .sources-bar {
      flex-shrink: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem;
      padding: 0.5rem 1rem; background: #1e293b; border-bottom: 1px solid #334155;
    }
    .sources-label { font-size: 0.78em; color: #94a3b8; white-space: nowrap; }
    .src-btn {
      display: inline-flex; align-items: center; gap: 0.35rem;
      padding: 0.4em 0.85em; border-radius: 4px; font-size: 0.88em;
      border: 1px solid #475569; background: #1e293b; color: #cbd5e1;
      cursor: pointer; white-space: nowrap;
    }
    .src-btn.active   { background: #1d4ed8; border-color: #3b82f6; color: #fff; }
    .src-btn:hover:not(.active) { background: #334155; }
    .ping-badge { font-size: 0.75em; opacity: 0.75; }
    .ping-ok  { color: #86efac; }
    .ping-err { color: #f87171; }
    .src-edit-btn {
      padding: 0.1em 0.35em; font-size: 0.78em;
      background: transparent; border: 1px solid #475569; border-radius: 3px;
      color: #94a3b8; cursor: pointer;
    }
    .src-edit-btn:hover { background: #334155; color: #f1f5f9; }
    .add-src-btn {
      padding: 0.35em 0.75em; border-radius: 4px; font-size: 0.85em;
      background: #0f172a; border: 1px dashed #475569; color: #64748b; cursor: pointer;
    }
    .add-src-btn:hover { border-color: #94a3b8; color: #cbd5e1; }

    /* ---- source form ---- */
    .src-form {
      flex-shrink: 0; padding: 0.75rem 1rem; background: #1e293b;
      border-bottom: 1px solid #334155;
    }
    .src-form h4 { margin: 0 0 0.5rem; font-size: 0.9em; color: #94a3b8; }
    .src-form .fields {
      display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem 0.75rem;
    }
    .src-form label { display: flex; flex-direction: column; font-size: 0.82em; gap: 0.15rem; }
    .src-form input {
      font-size: 0.9em; padding: 0.25em 0.35em;
      border: 1px solid #334155; border-radius: 3px;
      background: #0f172a; color: #f1f5f9;
    }
    .src-form .form-actions { margin-top: 0.5rem; display: flex; gap: 0.4rem; }
    .btn {
      padding: 0.3em 0.8em; border-radius: 4px; font-size: 0.88em; cursor: pointer;
      border: 1px solid #475569; background: #334155; color: #f1f5f9;
    }
    .btn:hover { background: #475569; }
    .btn.primary { background: #1d4ed8; border-color: #3b82f6; }
    .btn.primary:hover { background: #2563eb; }
    .btn.danger { background: #7f1d1d; border-color: #dc2626; }
    .btn.danger:hover { background: #991b1b; }
    .btn:disabled { opacity: 0.4; cursor: default; }

    /* connect strip */
    .connect-strip {
      flex-shrink: 0; display: flex; align-items: center; gap: 0.5rem;
      padding: 0.4rem 1rem; background: #1e293b; border-bottom: 1px solid #334155;
      font-size: 0.85em;
    }
    .badge { font-size: 0.78em; padding: 0.15em 0.5em; border-radius: 3px; }
    .badge.on  { background: #14532d; color: #86efac; }
    .badge.off { background: #7f1d1d; color: #fca5a5; }
    .lib-stats { font-size: 0.78em; color: #64748b; white-space: nowrap; }

    /* ---- two-panel layout ---- */
    .panels {
      display: grid; grid-template-columns: 1fr 1fr;
      flex: 1; overflow: hidden;
    }
    @media (orientation: portrait) {
      .panels { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
    }
    queue-panel { display: flex; flex-direction: column; overflow: hidden; }

    /* ---- search panel (left) ---- */
    .search-panel { display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid #334155; }

    .lib-header { flex-shrink: 0; background: #0f172a; border-bottom: 1px solid #334155; }
    .lib-cols, .lib-search {
      display: grid;
      /* title | artist | album | year | genre | duration | actions */
      grid-template-columns: 1fr 1fr 1fr 4em 1fr 4em 5.5em;
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
      grid-template-columns: 1fr 1fr 1fr 4em 1fr 4em 5.5em;
      border-bottom: 1px solid #1e293b; font-size: 0.85em;
    }
    .lib-row:hover    { background: #1e293b; }
    .lib-row.selected { background: rgba(96,165,250,0.12); }
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

    /* selection indicator in count bar */
    .sel-info { color: #7dd3fc; }
    .sel-clear {
      margin-left: 0.3em; font-size: 0.85em;
      background: none; border: none; color: #94a3b8; cursor: pointer; padding: 0;
    }
    .sel-clear:hover { color: #f1f5f9; }
  `;

  // ---- sources state ----
  @state() private _sources:    SubsonicSourceEx[] = [];
  @state() private _selectedId: string | null = null;
  @state() private _showForm  = false;
  @state() private _editingId: string | null = null;
  @state() private _form: SourceForm = { ...EMPTY_FORM };

  // ---- auth + library state ----
  @state() private _connected   = false;
  @state() private _auth: AuthInfo = { server: "", user: "", token: "", salt: "" };
  @state() private _library: SubsonicTrack[] = [];
  @state() private _refreshing  = false;  // true while a refresh request is in flight

  // ---- library filter/sort state ----
  @state() private _sortCol: SortCol = "artist";
  @state() private _sortDir: 1 | -1  = 1;
  @state() private _fTitle  = "";
  @state() private _fArtist = "";
  @state() private _fAlbum  = "";
  @state() private _fYear   = "";
  @state() private _fGenre  = "";

  // ---- library selection ----
  @state() private _selected: Set<string> = new Set();
  private _anchor: string | null = null;

  /** Broadcast current selection to the footer via playerBus. */
  private _emitSelectionState(): void {
    const items: QueueItem[] = this._library
      .filter(t => this._selected.has(t.id))
      .map(t => this._toQueueItem(t));
    playerBus.dispatchEvent(new CustomEvent<SelectionStateEvent>("selection-state", {
      detail: { items, source: "subsonic" },
    }));
  }

  private readonly _onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this._selected.size > 0) {
      this._selected = new Set(); this._anchor = null;
      this._emitSelectionState();
    }
  };

  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("keydown", this._onKeyDown);
    void this._fetchSources();
    void this._fetchStatus();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("keydown", this._onKeyDown);
    this._stopPolling();
    // Clear selection state when panel is hidden.
    playerBus.dispatchEvent(new CustomEvent<SelectionStateEvent>("selection-state", {
      detail: { items: [], source: "subsonic" },
    }));
  }

  // ---- sources ----

  private async _fetchSources(): Promise<void> {
    try {
      const r = await fetch("/api/subsonic/sources");
      if (!r.ok) return;
      const list = await r.json() as SubsonicSource[];
      this._sources = list.map((s) => ({ ...s, ping_ms: null, ping_err: false, pinging: false }));
      const active = list.find((s) => s.active);
      if (active) this._selectedId = active.id;
      void this._pingAll();
    } catch { /* backend unavailable */ }
  }

  private async _pingAll(): Promise<void> {
    await Promise.all(this._sources.map((s) => this._pingSource(s.id)));
  }

  private async _pingSource(id: string): Promise<void> {
    this._sources = this._sources.map((s) => s.id === id ? { ...s, pinging: true } : s);
    try {
      const r = await fetch(`/api/subsonic/sources/${id}/ping`);
      const data = await r.json() as { reachable: boolean; ms: number | null };
      this._sources = this._sources.map((s) =>
        s.id === id
          ? { ...s, pinging: false, ping_ms: data.ms ?? null, ping_err: !data.reachable }
          : s
      );
    } catch {
      this._sources = this._sources.map((s) =>
        s.id === id ? { ...s, pinging: false, ping_err: true, ping_ms: null } : s
      );
    }
  }

  private async _saveSource(): Promise<void> {
    const body = {
      label:    this._form.label.trim() || "Subsonic",
      server:   this._form.server.trim(),
      user:     this._form.user.trim(),
      password: this._form.password,
    };
    try {
      if (this._editingId) {
        await fetch(`/api/subsonic/sources/${this._editingId}`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...getCsrfHeaders() },
          body: JSON.stringify(body),
        });
      } else {
        await fetch("/api/subsonic/sources", {
          method: "POST",
          headers: { "content-type": "application/json", ...getCsrfHeaders() },
          body: JSON.stringify(body),
        });
      }
      this._showForm  = false;
      this._editingId = null;
      this._form      = { ...EMPTY_FORM };
      await this._fetchSources();
    } catch { /* backend unavailable */ }
  }

  private async _deleteSource(id: string): Promise<void> {
    try {
      await fetch(`/api/subsonic/sources/${id}`, {
        method: "DELETE", headers: { ...getCsrfHeaders() },
      });
      if (this._selectedId === id) this._selectedId = null;
      await this._fetchSources();
    } catch { /* backend unavailable */ }
  }

  private async _activateSource(id: string): Promise<void> {
    try {
      const r = await fetch(`/api/subsonic/sources/${id}/activate`, {
        method: "POST", headers: { ...getCsrfHeaders() },
      });
      const data = await r.json() as {
        connected?: boolean; server?: string; user?: string; token?: string; salt?: string;
      };
      if (data.connected) {
        this._connected = true;
        this._auth = {
          server: data.server ?? "",
          user:   data.user   ?? "",
          token:  data.token  ?? "",
          salt:   data.salt   ?? "",
        };
        await this._fetchSources();
        this._startPolling();
        // Load cache instantly, then refresh in background for new additions.
        await this._loadCachedLibrary();
        void this._quickRefresh();
      }
    } catch { /* backend unavailable */ }
  }

  private async _disconnect(): Promise<void> {
    try {
      await fetch("/api/subsonic/disconnect", { method: "POST", headers: { ...getCsrfHeaders() } });
      this._connected = false;
      this._auth      = { server: "", user: "", token: "", salt: "" };
      this._library   = [];
      this._stopPolling();
      await this._fetchSources();
    } catch { /* backend unavailable */ }
  }

  private _openAddForm(): void {
    this._editingId = null;
    this._form      = { ...EMPTY_FORM };
    this._showForm  = true;
  }

  private _openEditForm(s: SubsonicSourceEx): void {
    this._editingId = s.id;
    this._form = { label: s.label, server: s.server, user: s.user, password: s.password };
    this._showForm = true;
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
      const r = await fetch("/api/subsonic/status");
      const data = await r.json() as {
        connected: boolean; active_id?: string;
        server?: string; user?: string; token?: string; salt?: string;
      };
      this._connected = data.connected;
      if (data.connected) {
        this._auth = {
          server: data.server ?? "",
          user:   data.user   ?? "",
          token:  data.token  ?? "",
          salt:   data.salt   ?? "",
        };
        if (data.active_id) this._selectedId = data.active_id;
        this._startPolling();
        // If the backend restarted and the library is blank, load from cache.
        if (this._library.length === 0) {
          await this._loadCachedLibrary();
          if (this._library.length === 0) void this._quickRefresh();
        }
      } else {
        this._stopPolling();
      }
    } catch { /* backend unavailable */ }
  }

  // ---- library ----

  private async _loadCachedLibrary(): Promise<void> {
    // Returns the on-disk cache instantly; empty array if none.
    try {
      const r = await fetch("/api/subsonic/library");
      if (r.ok) this._library = await r.json() as SubsonicTrack[];
    } catch (err) { console.error("subsonic: cache load failed", err); }
  }

  private async _quickRefresh(): Promise<void> {
    // Fetches albums added since last cache; fast; does not detect deletions.
    if (this._refreshing) return;
    this._refreshing = true;
    try {
      const r = await fetch("/api/subsonic/library/refresh", {
        method: "POST", headers: { ...getCsrfHeaders() },
      });
      if (r.ok) this._library = await r.json() as SubsonicTrack[];
    } catch (err) { console.error("subsonic: quick refresh failed", err); }
    finally { this._refreshing = false; }
  }

  private async _fullRefresh(): Promise<void> {
    // Re-fetches every track; slow but catches deletions and metadata changes.
    if (this._refreshing) return;
    this._refreshing = true;
    try {
      const r = await fetch("/api/subsonic/library/full-refresh", {
        method: "POST", headers: { ...getCsrfHeaders() },
      });
      if (r.ok) this._library = await r.json() as SubsonicTrack[];
    } catch (err) { console.error("subsonic: full refresh failed", err); }
    finally { this._refreshing = false; }
  }

  /** Apply per-column filters, sort by selected column, cap at 500. */
  private _buildDisplay(): { tracks: SubsonicTrack[]; matched: number } {
    const q = (v: string) => v.trim().toLowerCase();
    const ft = q(this._fTitle);
    const fa = q(this._fArtist);
    const fl = q(this._fAlbum);
    const fy = q(this._fYear);
    const fg = q(this._fGenre);

    const base = this._library.filter((tr) => {
      if (ft && !String(tr.title  ?? "").toLowerCase().includes(ft)) return false;
      if (fa && !String(tr.artist ?? "").toLowerCase().includes(fa)) return false;
      if (fl && !String(tr.album  ?? "").toLowerCase().includes(fl)) return false;
      if (fy && !String(tr.year   ?? "").includes(fy))               return false;
      if (fg && !String(tr.genre  ?? "").toLowerCase().includes(fg)) return false;
      return true;
    });

    const matched = base.length;
    const col = this._sortCol;
    const dir = this._sortDir;

    const sorted = [...base].sort((a, b) => {
      let va: string | number;
      let vb: string | number;
      if (col === "year") {
        va = a.year ?? 0; vb = b.year ?? 0;
      } else if (col === "title") {
        va = String(a.title ?? "").toLowerCase();
        vb = String(b.title ?? "").toLowerCase();
      } else if (col === "artist") {
        va = String(a.artist ?? "").toLowerCase();
        vb = String(b.artist ?? "").toLowerCase();
      } else if (col === "album") {
        va = String(a.album ?? "").toLowerCase();
        vb = String(b.album ?? "").toLowerCase();
      } else {
        // genre
        va = String(a.genre ?? "").toLowerCase();
        vb = String(b.genre ?? "").toLowerCase();
      }
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });

    return { tracks: sorted.slice(0, 500), matched };
  }

  private _setSort(col: SortCol): void {
    if (this._sortCol === col) this._sortDir = (this._sortDir === 1 ? -1 : 1) as 1 | -1;
    else { this._sortCol = col; this._sortDir = 1; }
  }

  // ---- queue helpers ----

  /** Build a Subsonic stream URL using token auth; credentials never leave the backend. */
  private _streamUrl(songId: string): string {
    const p = new URLSearchParams({
      id: songId, u: this._auth.user,
      t: this._auth.token, s: this._auth.salt,
      v: "1.16.1", c: "zik",
    });
    return `${this._auth.server}/rest/stream?${p.toString()}`;
  }

  /** Cover art URL for a song/album ID via the Subsonic getCoverArt endpoint. */
  private _coverUrl(id: string): string {
    const p = new URLSearchParams({
      id, u: this._auth.user, t: this._auth.token, s: this._auth.salt,
      v: "1.16.1", c: "zik",
    });
    return `${this._auth.server}/rest/getCoverArt?${p.toString()}`;
  }

  /** Convert a SubsonicTrack to a cross-service QueueItem. */
  private _toQueueItem(track: SubsonicTrack): QueueItem {
    const item: QueueItem = {
      serviceId: "subsonic",
      trackId:   track.id,
      audioUrl:  this._streamUrl(track.id),
      title:     track.title  ?? track.id,
      artist:    track.artist ?? "",
      album:     track.album  ?? "",
      duration:  track.duration ?? 0,
    };
    if (this._connected) item.artUrl = this._coverUrl(track.id);
    return item;
  }

  /** Click/ctrl-click/shift-click handler for library rows. */
  private _onTrackClick(e: MouseEvent, id: string, orderedIds: string[]): void {
    if (e.shiftKey && this._anchor !== null) {
      const ai = orderedIds.indexOf(this._anchor);
      const ki = orderedIds.indexOf(id);
      if (ai >= 0 && ki >= 0) {
        const lo = Math.min(ai, ki); const hi = Math.max(ai, ki);
        const s = new Set(this._selected);
        for (let i = lo; i <= hi; i++) s.add(orderedIds[i]);
        this._selected = s;
      }
    } else if (e.ctrlKey || e.metaKey) {
      const s = new Set(this._selected);
      if (s.has(id)) s.delete(id); else s.add(id);
      this._selected = s;
      this._anchor = id;
    } else {
      this._selected = new Set([id]);
      this._anchor = id;
    }
    this._emitSelectionState();
  }

  /**
   * Drag-start: if the dragged row is selected export the whole selection,
   * otherwise just this track.
   */
  private _onSearchDragStart(e: DragEvent, track: SubsonicTrack): void {
    const isSel  = this._selected.has(track.id);
    const tracks = isSel && this._selected.size > 0
      ? this._library.filter(t => this._selected.has(t.id))
      : [track];
    e.dataTransfer!.effectAllowed = "copy";
    e.dataTransfer!.setData("queue-items-json", JSON.stringify(tracks.map(t => this._toQueueItem(t))));
  }

  // ---- rendering ----

  private _renderPingBadge(s: SubsonicSourceEx): TemplateResult {
    if (s.pinging)           return html`<span class="ping-badge">…</span>`;
    if (s.ping_err)          return html`<span class="ping-badge ping-err">✗</span>`;
    if (s.ping_ms !== null)  return html`<span class="ping-badge ping-ok">${Math.round(s.ping_ms)}ms</span>`;
    return html``;
  }

  private _renderSourcesBar(): TemplateResult {
    return html`
      <div class="sources-bar">
        <span class="sources-label">Subsonic:</span>
        ${this._sources.map((s) => html`
          <span style="display:inline-flex;align-items:center;gap:0.25rem;">
            <button class="src-btn ${s.id === this._selectedId ? "active" : ""}"
                    @click=${() => { this._selectedId = s.id; }}>
              ${s.label}
              ${this._renderPingBadge(s)}
            </button>
            <button class="src-edit-btn" title="Edit"
                    @click=${() => this._openEditForm(s)}>✎</button>
            <button class="src-edit-btn" title="Ping"
                    @click=${() => void this._pingSource(s.id)}>⟳</button>
          </span>
        `)}
        <button class="add-src-btn" @click=${() => this._openAddForm()}>+ Add</button>
      </div>
    `;
  }

  private _renderSourceForm(): TemplateResult {
    const isEdit  = this._editingId !== null;
    const canSave = this._form.server.trim().length > 0 && this._form.user.trim().length > 0;
    return html`
      <div class="src-form">
        <h4>${isEdit ? "Edit Subsonic account" : "Add Subsonic account"}</h4>
        <div class="fields">
          <label>
            Label
            <input type="text" placeholder="My Navidrome" .value=${this._form.label}
                   @input=${(e: Event) => { this._form = { ...this._form, label: (e.target as HTMLInputElement).value }; }} />
          </label>
          <label>
            Username
            <input type="text" autocomplete="username" .value=${this._form.user}
                   @input=${(e: Event) => { this._form = { ...this._form, user: (e.target as HTMLInputElement).value }; }} />
          </label>
          <label style="grid-column: 1 / -1">
            Server URL
            <input type="url" placeholder="http://navidrome.local:4533" .value=${this._form.server}
                   @input=${(e: Event) => { this._form = { ...this._form, server: (e.target as HTMLInputElement).value }; }} />
          </label>
          <label style="grid-column: 1 / -1">
            Password
            <input type="password" autocomplete="current-password" .value=${this._form.password}
                   @input=${(e: Event) => { this._form = { ...this._form, password: (e.target as HTMLInputElement).value }; }} />
          </label>
        </div>
        <div class="form-actions">
          <button class="btn primary" ?disabled=${!canSave} @click=${() => void this._saveSource()}>
            ${isEdit ? "Save" : "Add"}
          </button>
          ${isEdit ? html`
            <button class="btn danger"
                    @click=${() => { if (this._editingId) void this._deleteSource(this._editingId); this._showForm = false; }}>
              Delete
            </button>
          ` : nothing}
          <button class="btn" @click=${() => { this._showForm = false; }}>Cancel</button>
        </div>
      </div>
    `;
  }

  private _renderConnectStrip(): TemplateResult {
    const sel = this._sources.find((s) => s.id === this._selectedId);
    return html`
      <div class="connect-strip">
        <span class="badge ${this._connected ? "on" : "off"}">
          ${this._connected ? "Connected" : "Disconnected"}
        </span>
        ${sel ? html`
          <span style="color:#94a3b8;">${sel.label} — ${sel.server}</span>
        ` : nothing}
        ${this._selectedId && !this._connected ? html`
          <button class="btn primary" @click=${() => void this._activateSource(this._selectedId!)}>
            Connect
          </button>
        ` : nothing}
        ${this._connected ? html`
          <button class="btn" @click=${() => void this._disconnect()}>Disconnect</button>
          <button class="btn" ?disabled=${this._refreshing}
                  @click=${() => void this._quickRefresh()}>
            ${this._refreshing ? "…" : "↺ Refresh"}
          </button>
          <button class="btn" ?disabled=${this._refreshing}
                  title="Re-fetch every track (slow; detects deletions and metadata changes)"
                  @click=${() => void this._fullRefresh()}>⟳ Full</button>
          ${this._library.length > 0 ? html`
            <span class="lib-stats">${this._libraryStats()}</span>
          ` : nothing}
        ` : nothing}
      </div>
    `;
  }

  private _libraryStats(): string {
    const tracks  = this._library.length;
    const albums  = new Set(this._library.map(t => t.albumId).filter(Boolean)).size;
    const artists = new Set(this._library.map(t => t.artist).filter(Boolean)).size;
    const fmt = (n: number) => n.toLocaleString();
    return `${fmt(tracks)} tracks · ${fmt(albums)} albums · ${fmt(artists)} artists`;
  }

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
    if (!this._connected) {
      return html`<div class="empty">Select an account and connect to browse the library.</div>`;
    }
    if (this._library.length === 0) {
      return html`<div class="empty">${this._refreshing
        ? "Loading library…"
        : "Library is empty — click ↺ Refresh after connecting."}</div>`;
    }
    const { tracks, matched } = this._buildDisplay();
    const allIds  = tracks.map(t => t.id);   // ordered for shift-click range
    const selInfo = this._selected.size > 0
      ? html` · <span class="sel-info">${this._selected.size} selected</span
        ><button class="sel-clear" title="Clear selection"
                 @click=${() => { this._selected = new Set(); this._anchor = null; }}>✕</button>`
      : nothing;
    return html`
      ${matched < this._library.length
        ? html`<div class="lib-count">${matched} / ${this._library.length} tracks${tracks.length < matched ? ` — showing first ${tracks.length}` : ""}${selInfo}</div>`
        : html`<div class="lib-count">${matched} track${matched !== 1 ? "s" : ""}${selInfo}</div>`}
      ${tracks.map((tr) => {
        const isSel    = this._selected.has(tr.id);
        // When the clicked row is selected, act on the full selection; otherwise just this track.
        const effective = isSel && this._selected.size > 0
          ? this._library.filter(t => this._selected.has(t.id))
          : [tr];
        return html`
          <div class="lib-row ${isSel ? "selected" : ""}"
               draggable="true"
               @click=${(e: MouseEvent) => this._onTrackClick(e, tr.id, allIds)}
               @dragstart=${(e: DragEvent) => this._onSearchDragStart(e, tr)}>
            <div class="lib-cell">${String(tr.title  ?? "")}</div>
            <div class="lib-cell">${String(tr.artist ?? "")}</div>
            <div class="lib-cell">${String(tr.album  ?? "")}</div>
            <div class="lib-cell">${tr.year ?? ""}</div>
            <div class="lib-cell">${String(tr.genre  ?? "")}</div>
            <div class="lib-cell dur">${fmt(tr.duration ?? 0)}</div>
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

  override render() {
    return html`
      ${this._renderSourcesBar()}
      ${this._showForm ? this._renderSourceForm() : nothing}
      ${this._renderConnectStrip()}

      <div class="panels">
        <!-- left: library search -->
        <div class="search-panel">
          <div class="lib-header">
            <div class="lib-cols">
              ${this._renderColHeader("title",  "Title")}
              ${this._renderColHeader("artist", "Artist")}
              ${this._renderColHeader("album",  "Album")}
              ${this._renderColHeader("year",   "Year")}
              ${this._renderColHeader("genre",  "Genre")}
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
              <input placeholder="Genre…"  .value=${live(this._fGenre)}
                     @input=${(e: Event) => { this._fGenre  = (e.target as HTMLInputElement).value; }} />
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
