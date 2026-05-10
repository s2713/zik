import { css, html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { customElement, state } from "lit/decorators.js";

import { PlayerBase } from "../../player-base.js";
import { queue } from "../../queue/queue-controller.js";
import type { QueueItem } from "../../queue/queue-item.js";
import { playerBus, type SelectionStateEvent } from "../../player-bus.js";
import { USER_CHANGED_EVENT } from "../../session.js";
import { t } from "../../i18n/i18n.js";
import "../../queue/queue-panel-element.js";
import {
  listPlaylists, createPlaylist, getPlaylist, renamePlaylist,
  deletePlaylist, removeTrack, reorderTracks, touchLastPlayed, exportUrl, importPlaylist,
  entryToQueueItem,
} from "./playlist-api.js";
import { PLAYLISTS_CHANGED_EVENT } from "./playlist-popup-element.js";
import type { Playlist, PlaylistDetail, PlaylistEntry, PlaylistExport } from "./playlist.js";

function fmtDur(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

/**
 * Playlists service panel: two-pane layout.
 * Left: accordion list — each playlist unfolds inline to show its track list.
 * Right: shared <queue-panel>.
 */
@customElement("playlists-player")
export class PlaylistsPlayerElement extends PlayerBase {
  static override styles = css`
    :host {
      display: flex; flex-direction: column;
      height: calc(100vh - 56px - 76px);
      font-family: sans-serif; color: #f1f5f9; background: #0f172a;
      overflow: hidden;
    }

    /* ---- two-panel layout ---- */
    .panels {
      display: grid; grid-template-columns: 1fr 1fr;
      flex: 1; overflow: hidden;
    }
    @media (orientation: portrait) {
      .panels { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
    }

    /* ---- left panel ---- */
    .left-panel {
      display: flex; flex-direction: column;
      border-right: 1px solid #334155; overflow: hidden;
    }

    /* toolbar */
    .toolbar {
      flex-shrink: 0;
      display: flex; align-items: center; gap: 0.3rem; flex-wrap: wrap;
      padding: 0.5rem 0.6rem;
      background: #1e293b; border-bottom: 1px solid #334155;
    }
    .search-inp {
      flex: 1; min-width: 100px;
      padding: 0.28em 0.5em;
      background: #0f172a; border: 1px solid #475569;
      border-radius: 5px; color: #f1f5f9; font-size: 0.88em;
    }
    .search-inp:focus { outline: none; border-color: #60a5fa; }
    .tb-btn {
      padding: 0.3em 0.6em; border-radius: 5px; font-size: 0.82em;
      background: #334155; border: none; color: #f1f5f9; cursor: pointer;
      white-space: nowrap; flex-shrink: 0;
    }
    .tb-btn:hover    { background: #475569; }
    .tb-btn.active   { background: #1d4ed8; }
    .tb-btn:disabled { opacity: 0.4; cursor: default; }

    /* new-playlist inline form */
    .new-form {
      display: flex; gap: 0.4rem;
      padding: 0.45rem 0.6rem;
      background: #0f172a; border-bottom: 1px solid #334155; flex-shrink: 0;
    }
    .new-form input {
      flex: 1; padding: 0.28em 0.5em;
      background: #1e293b; border: 1px solid #475569;
      border-radius: 5px; color: #f1f5f9; font-size: 0.88em;
    }
    .new-form input:focus { outline: none; border-color: #60a5fa; }

    /* scrollable area */
    .scroll { flex: 1; overflow-y: auto; }

    /* ---- accordion row ---- */
    .pl-row {
      display: flex; align-items: center; gap: 0.4rem;
      padding: 0.48rem 0.6rem;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      cursor: pointer; user-select: none;
    }
    .pl-row:hover    { background: rgba(255,255,255,0.04); }
    .pl-row.selected { background: rgba(59,130,246,0.18); }
    /* Keep top-of-section border when expanded; bottom border handled by track-section */
    .pl-row.expanded { border-bottom: none; background: rgba(255,255,255,0.03); }

    /* chevron toggle — also a button */
    .pl-chevron {
      font-size: 0.7em; color: #94a3b8; flex-shrink: 0;
      background: none; border: none; color: inherit;
      cursor: pointer; padding: 0.1em 0.25em; border-radius: 3px;
    }
    .pl-chevron:hover { background: rgba(255,255,255,0.1); }

    .pl-icon  { font-size: 1em; flex-shrink: 0; }
    .pl-name  { flex: 1; font-size: 0.9em; font-weight: 500;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pl-count { font-size: 0.75em; color: #64748b; white-space: nowrap; flex-shrink: 0; }

    .pl-act {
      padding: 0.26em 0.5em; border-radius: 5px; font-size: 0.8em;
      background: #334155; border: none; color: #f1f5f9; cursor: pointer; flex-shrink: 0;
    }
    .pl-act:hover         { background: #475569; }
    .pl-act.primary       { background: #1d4ed8; }
    .pl-act.primary:hover { background: #2563eb; }
    .pl-act.danger        { background: transparent; color: #f87171; }
    .pl-act.danger:hover  { background: rgba(239,68,68,0.15); }

    /* inline rename input */
    .rename-inp {
      flex: 1; padding: 0.18em 0.4em;
      background: #0f172a; border: 1px solid #60a5fa;
      border-radius: 4px; color: #f1f5f9; font-size: 0.88em;
    }

    /* ---- inline track section ---- */
    .track-section {
      border-bottom: 1px solid rgba(255,255,255,0.07);
      background: rgba(0,0,0,0.2);
    }
    .track-row {
      display: flex; align-items: center; gap: 0.35rem;
      padding: 0.28rem 0.6rem 0.28rem 1.8rem;  /* left indent */
      border-bottom: 1px solid rgba(255,255,255,0.03);
      font-size: 0.82em; cursor: pointer; user-select: none;
    }
    .track-row:hover      { background: rgba(255,255,255,0.04); }
    .track-row.selected   { background: rgba(59,130,246,0.18); }
    .track-row.drop-above { border-top: 2px solid #3b82f6; }
    .drag-handle { color: #475569; cursor: grab; padding: 0 0.1rem; flex-shrink: 0; }
    .track-num   { color: #475569; width: 1.6em; text-align: right; flex-shrink: 0; }
    .track-art {
      width: 26px; height: 26px; flex-shrink: 0;
      position: relative; border-radius: 3px; overflow: hidden; background: #334155;
    }
    .track-art img {
      position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
    }
    .track-info  { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .track-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .track-sub   { font-size: 0.8em; color: #94a3b8;
                   overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .track-dur   { color: #64748b; font-size: 0.8em; white-space: nowrap; flex-shrink: 0; }
    .del-btn {
      padding: 0.2em 0.4em; border-radius: 4px; font-size: 0.8em;
      background: transparent; border: none; color: #94a3b8; cursor: pointer; flex-shrink: 0;
    }
    .del-btn:hover { background: rgba(239,68,68,0.15); color: #f87171; }

    /* play/queue footer inside expanded section */
    .section-footer {
      display: flex; gap: 0.3rem;
      padding: 0.3rem 0.6rem 0.35rem 1.8rem;
      background: rgba(0,0,0,0.1);
    }

    .loading { padding: 0.5rem 1.8rem; font-size: 0.82em; color: #475569; }
    .empty   { padding: 2rem 1rem; color: #475569; font-size: 0.88em; text-align: center; }
    .toast {
      flex-shrink: 0; padding: 0.4rem 0.7rem; font-size: 0.82em; color: #34d399;
      background: #0f172a; border-top: 1px solid #334155; text-align: center;
    }
    .toast.err { color: #f87171; }
  `;

  // ---- list state ----
  @state() private _playlists: Playlist[] = [];
  @state() private _search  = "";
  @state() private _sort: "name" | "updated" | "played" = "name";
  @state() private _creating = false;
  @state() private _newName  = "";

  // ---- accordion state ----
  @state() private _expandedIds: Set<string>                   = new Set();
  @state() private _details:     Record<string, PlaylistDetail> = {};
  @state() private _loadingIds:  Set<string>                   = new Set();

  // ---- rename state ----
  @state() private _renamingId: string | null = null;
  @state() private _renameName = "";

  // ---- selection ----
  @state() private _selectedPositions: Set<number> = new Set();
  @state() private _selectedPlIds:     Set<string>  = new Set();
  private _selPlId:     string | null = null; // which playlist's tracks are selected
  private _anchorPos:   number | null = null;
  private _anchorPlIdx: number | null = null;

  // ---- drag-reorder (scoped per playlist) ----
  @state() private _dropPos:  number | null = null;
  @state() private _dropPlId: string | null = null;
  private _dragPos:  number | null = null;
  private _dragPlId: string | null = null;

  // ---- shared ----
  @state() private _busy      = false;
  @state() private _toast     = "";
  @state() private _toastErr  = false;
  private _toastTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- lifecycle ----

  private readonly _onPlaylistsChanged = (): void => { void this._loadList(); };
  private readonly _onUserChanged      = (): void => { void this._loadList(); };

  private readonly _onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Delete" && this._selectedPositions.size > 0 && this._selPlId) {
      void this._deleteSelectedTracks(this._selPlId);
      return;
    }
    if (e.key !== "Escape") return;
    const hadSel = this._selectedPositions.size > 0 || this._selectedPlIds.size > 0;
    this._selectedPositions = new Set(); this._anchorPos   = null;
    this._selectedPlIds     = new Set(); this._anchorPlIdx = null;
    this._selPlId = null;
    if (hadSel) this._emitSelectionState();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(PLAYLISTS_CHANGED_EVENT, this._onPlaylistsChanged);
    window.addEventListener(USER_CHANGED_EVENT,      this._onUserChanged);
    document.addEventListener("keydown", this._onKeyDown);
    void this._loadList();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(PLAYLISTS_CHANGED_EVENT, this._onPlaylistsChanged);
    window.removeEventListener(USER_CHANGED_EVENT,      this._onUserChanged);
    document.removeEventListener("keydown", this._onKeyDown);
    this._emitSelectionState(); // clear on unmount
    if (this._toastTimer !== null) clearTimeout(this._toastTimer);
  }

  // ---- data loading ----

  private async _loadList(): Promise<void> {
    try {
      this._playlists = await listPlaylists();
      for (const id of this._expandedIds) void this._fetchDetail(id);
    } catch (err) {
      // 401 is expected before login — suppress the toast, reload fires on USER_CHANGED_EVENT.
      if (!(err instanceof Error && err.message === "401"))
        this._showToast(t("playlists.err-load"), true);
    }
  }

  private async _fetchDetail(id: string): Promise<void> {
    this._loadingIds = new Set([...this._loadingIds, id]);
    try {
      const detail = await getPlaylist(id);
      this._details = { ...this._details, [id]: detail };
    } catch {
      this._showToast(t("playlists.err-load"), true);
    } finally {
      const next = new Set(this._loadingIds); next.delete(id);
      this._loadingIds = next;
    }
  }

  // ---- toast ----

  private _showToast(msg: string, err = false): void {
    this._toast = msg; this._toastErr = err;
    if (this._toastTimer !== null) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this._toast = ""; }, 2500);
  }

  // ---- accordion ----

  private _toggleExpand(id: string): void {
    const next = new Set(this._expandedIds);
    if (next.has(id)) {
      next.delete(id);
      if (this._selPlId === id) {
        this._selectedPositions = new Set(); this._anchorPos = null; this._selPlId = null;
        this._emitSelectionState();
      }
    } else {
      next.add(id);
      if (!(id in this._details)) void this._fetchDetail(id);
    }
    this._expandedIds = next;
  }

  // ---- list-level actions ----

  private async _create(): Promise<void> {
    const name = this._newName.trim();
    if (!name) return;
    this._busy = true;
    try {
      await createPlaylist(name);
      this._newName = ""; this._creating = false;
      await this._loadList();
    } finally { this._busy = false; }
  }

  private _triggerImport(): void {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json";
    inp.onchange = async () => {
      const file = inp.files?.[0];
      if (!file) return;
      this._busy = true;
      try {
        const data = JSON.parse(await file.text()) as PlaylistExport;
        const pl   = await importPlaylist(data);
        await this._loadList();
        this._showToast(`Imported "${pl.name}"`);
      } catch { this._showToast("Import failed — invalid file", true); }
      finally  { this._busy = false; }
    };
    inp.click();
  }

  // ---- per-playlist actions ----

  private _startRename(pl: Playlist): void {
    this._renamingId = pl.id; this._renameName = pl.name;
  }

  private async _commitRename(): Promise<void> {
    const id = this._renamingId;
    if (!id || !this._renameName.trim()) return;
    this._busy = true;
    try {
      await renamePlaylist(id, this._renameName.trim());
      this._renamingId = null;
      await this._loadList();
    } finally { this._busy = false; }
  }

  private async _deletePl(pl: Playlist): Promise<void> {
    if (!confirm(`Delete "${pl.name}"?`)) return;
    this._busy = true;
    try {
      await deletePlaylist(pl.id);
      const nextExp = new Set(this._expandedIds); nextExp.delete(pl.id);
      this._expandedIds = nextExp;
      const { [pl.id]: _removed, ...rest } = this._details;
      this._details = rest;
      if (this._selPlId === pl.id) {
        this._selectedPositions = new Set(); this._selPlId = null; this._emitSelectionState();
      }
      await this._loadList();
    } finally { this._busy = false; }
  }

  private _exportPl(id: string): void {
    const a = document.createElement("a"); a.href = exportUrl(id); a.click();
  }

  private async _playAll(plId: string): Promise<void> {
    const d = this._details[plId] ?? await getPlaylist(plId);
    queue.clear(); queue.add(d.tracks.map(entryToQueueItem)); queue.playAt(0);
    await touchLastPlayed(plId);
  }

  private async _addAll(plId: string): Promise<void> {
    const d = this._details[plId] ?? await getPlaylist(plId);
    queue.add(d.tracks.map(entryToQueueItem));
    await touchLastPlayed(plId);
  }

  // ---- track-level actions ----

  private async _deleteTrack(plId: string, position: number): Promise<void> {
    this._busy = true;
    try {
      await removeTrack(plId, position);
      await this._fetchDetail(plId);
      this._playlists = this._playlists.map(p =>
        p.id === plId ? { ...p, track_count: p.track_count - 1 } : p
      );
    } finally { this._busy = false; }
  }

  private async _deleteSelectedTracks(plId: string): Promise<void> {
    if (this._selectedPositions.size === 0) return;
    // Delete highest positions first so each removal doesn't shift remaining targets.
    const sorted = [...this._selectedPositions].sort((a, b) => b - a);
    this._busy = true;
    try {
      for (const pos of sorted) await removeTrack(plId, pos);
      this._selectedPositions = new Set(); this._anchorPos = null; this._selPlId = null;
      this._emitSelectionState();
      await this._fetchDetail(plId);
      this._playlists = this._playlists.map(p =>
        p.id === plId ? { ...p, track_count: Math.max(0, p.track_count - sorted.length) } : p
      );
    } finally { this._busy = false; }
  }

  // ---- selection ----

  private _emitSelectionState(): void {
    const detail = this._selPlId ? this._details[this._selPlId] : null;
    const items: QueueItem[] = detail
      ? detail.tracks.filter(t => this._selectedPositions.has(t.position)).map(entryToQueueItem)
      : [];
    playerBus.dispatchEvent(new CustomEvent<SelectionStateEvent>("selection-state", {
      detail: { items, source: "playlists" },
    }));
  }

  private _onTrackClick(e: MouseEvent, plId: string, pos: number): void {
    // Switching to a different playlist clears the previous track selection.
    if (this._selPlId !== plId) {
      this._selectedPositions = new Set(); this._anchorPos = null; this._selPlId = plId;
    }
    const positions = this._details[plId]?.tracks.map(t => t.position) ?? [];
    if (e.shiftKey && this._anchorPos !== null) {
      const lo = Math.min(this._anchorPos, pos);
      const hi = Math.max(this._anchorPos, pos);
      const range = positions.filter(p => p >= lo && p <= hi);
      const next  = e.ctrlKey || e.metaKey ? new Set(this._selectedPositions) : new Set<number>();
      for (const p of range) next.add(p);
      this._selectedPositions = next;
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(this._selectedPositions);
      if (next.has(pos)) next.delete(pos); else next.add(pos);
      this._selectedPositions = next;
      this._anchorPos = pos;
    } else {
      this._selectedPositions = new Set([pos]); this._anchorPos = pos;
    }
    this._selectedPlIds = new Set(); // clear playlist-row selection
    this._emitSelectionState();
  }

  private _onPlClick(e: MouseEvent, pl: Playlist, idx: number): void {
    const filtered = this._filteredPlaylists();
    if (e.shiftKey && this._anchorPlIdx !== null) {
      const lo = Math.min(this._anchorPlIdx, idx);
      const hi = Math.max(this._anchorPlIdx, idx);
      const range = filtered.slice(lo, hi + 1).map(p => p.id);
      const next  = e.ctrlKey || e.metaKey ? new Set(this._selectedPlIds) : new Set<string>();
      for (const id of range) next.add(id);
      this._selectedPlIds = next;
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(this._selectedPlIds);
      if (next.has(pl.id)) next.delete(pl.id); else next.add(pl.id);
      this._selectedPlIds = next; this._anchorPlIdx = idx;
    } else {
      this._selectedPlIds = new Set([pl.id]); this._anchorPlIdx = idx;
    }
    // Track selection belongs to an expanded playlist; clear it when selecting at list level.
    this._selectedPositions = new Set(); this._selPlId = null;
    this._emitSelectionState();
  }

  // ---- drag ----

  private _onTrackDragStart(e: DragEvent, plId: string, position: number): void {
    if (this._selPlId !== plId || !this._selectedPositions.has(position)) {
      this._selPlId = plId;
      this._selectedPositions = new Set([position]); this._anchorPos = position;
      this._emitSelectionState();
    }
    this._dragPos = position; this._dragPlId = plId;
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("playlist-reorder", String(position));
    // Also expose as queue-items-json so queue-panel can accept the drop.
    const detail = this._details[plId];
    if (detail) {
      const items = detail.tracks
        .filter(t => this._selectedPositions.has(t.position))
        .map(entryToQueueItem);
      e.dataTransfer!.setData("queue-items-json", JSON.stringify(items));
    }
  }

  private _onTrackDragEnd(): void {
    this._dragPos = null; this._dragPlId = null;
    this._dropPos = null; this._dropPlId = null;
  }

  private _onTrackDragOver(e: DragEvent, plId: string, position: number): void {
    if (this._dragPos === null || this._dragPlId !== plId) return;
    e.preventDefault();
    if (this._dropPos !== position || this._dropPlId !== plId) {
      this._dropPos = position; this._dropPlId = plId;
    }
  }

  private async _onTrackDrop(e: DragEvent, plId: string, position: number): Promise<void> {
    e.preventDefault();
    const from = this._dragPos; const fromPl = this._dragPlId;
    this._dragPos = null; this._dragPlId = null; this._dropPos = null; this._dropPlId = null;
    if (from === null || fromPl !== plId || from === position) return;
    this._busy = true;
    try {
      await reorderTracks(plId, [from], position);
      await this._fetchDetail(plId);
    } finally { this._busy = false; }
  }

  private _onTrackDragLeave(): void { this._dropPos = null; this._dropPlId = null; }

  private _onPlDragStart(e: DragEvent, pl: Playlist): void {
    const ids = this._selectedPlIds.has(pl.id) ? [...this._selectedPlIds] : [pl.id];
    e.dataTransfer!.effectAllowed = "copy";
    e.dataTransfer!.setData("zik/playlist-ids", JSON.stringify(ids));
  }

  // ---- filtering / sorting ----

  private _filteredPlaylists(): Playlist[] {
    let list = this._playlists;
    const q  = this._search.toLowerCase();
    if (q) list = list.filter(pl => pl.name.toLowerCase().includes(q));
    if (this._sort === "updated") {
      list = [...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    } else if (this._sort === "played") {
      list = [...list].sort((a, b) => {
        if (!a.last_played_at && !b.last_played_at) return 0;
        if (!a.last_played_at) return 1;
        if (!b.last_played_at) return -1;
        return b.last_played_at.localeCompare(a.last_played_at);
      });
    }
    return list;
  }

  // ---- rendering ----

  private _renderArt(entry: PlaylistEntry): TemplateResult {
    return html`
      <div class="track-art">
        <div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#475569;font-size:0.7em">♪</div>
        ${entry.art_url ? html`<img src="${entry.art_url}" alt=""
          @error=${(e: Event) => { (e.target as HTMLImageElement).style.display = "none"; }} />` : nothing}
      </div>`;
  }

  /** Inline expanded track list below a playlist row. */
  private _renderTrackSection(pl: Playlist): TemplateResult {
    const detail  = this._details[pl.id];
    const loading = this._loadingIds.has(pl.id);
    if (loading && !detail) return html`<div class="track-section"><div class="loading">Loading…</div></div>`;
    if (!detail)            return html`<div class="track-section"><div class="loading"></div></div>`;
    const isSelPl = this._selPlId === pl.id;
    return html`
      <div class="track-section">
        ${detail.tracks.length === 0
          ? html`<div class="loading">${t("playlists.no-tracks")}</div>`
          : detail.tracks.map(tr => html`
            <div class="track-row
                        ${isSelPl && this._selectedPositions.has(tr.position) ? "selected" : ""}
                        ${this._dropPlId === pl.id && this._dropPos === tr.position ? "drop-above" : ""}"
                 draggable="true"
                 @click=${(e: MouseEvent) => this._onTrackClick(e, pl.id, tr.position)}
                 @dragstart=${(e: DragEvent) => this._onTrackDragStart(e, pl.id, tr.position)}
                 @dragend=${() => this._onTrackDragEnd()}
                 @dragover=${(e: DragEvent) => { e.stopPropagation(); this._onTrackDragOver(e, pl.id, tr.position); }}
                 @drop=${(e: DragEvent) => { e.stopPropagation(); void this._onTrackDrop(e, pl.id, tr.position); }}
                 @dragleave=${(e: DragEvent) => { e.stopPropagation(); this._onTrackDragLeave(); }}>
              <span class="drag-handle">≡</span>
              <span class="track-num">${tr.position + 1}</span>
              ${this._renderArt(tr)}
              <div class="track-info">
                <span class="track-title">${tr.title || tr.track_id}</span>
                <span class="track-sub">${tr.artist}${tr.album ? ` — ${tr.album}` : ""}</span>
              </div>
              <span class="track-dur">${fmtDur(tr.duration)}</span>
              <button class="del-btn" title="Remove" ?disabled=${this._busy}
                      @click=${(e: MouseEvent) => { e.stopPropagation(); void this._deleteTrack(pl.id, tr.position); }}>🗑</button>
            </div>`)}
        <div class="section-footer">
          <button class="tb-btn active" ?disabled=${detail.tracks.length === 0}
                  @click=${() => void this._playAll(pl.id)}>▶ ${t("playlists.play-all")}</button>
          <button class="tb-btn" ?disabled=${detail.tracks.length === 0}
                  @click=${() => void this._addAll(pl.id)}>⊕ ${t("playlists.add-all")}</button>
          ${this._selPlId === pl.id && this._selectedPositions.size > 0 ? html`
            <button class="tb-btn" style="color:#f87171;margin-left:auto" ?disabled=${this._busy}
                    @click=${() => void this._deleteSelectedTracks(pl.id)}>
              🗑 Remove ${this._selectedPositions.size}
            </button>` : nothing}
        </div>
      </div>`;
  }

  /** Single accordion row + its optional inline track section. */
  private _renderPlaylistRow(pl: Playlist, idx: number): TemplateResult {
    const expanded = this._expandedIds.has(pl.id);
    const renaming = this._renamingId === pl.id;
    const cnt      = `${pl.track_count} track${pl.track_count !== 1 ? "s" : ""}`;
    const isSel    = this._selectedPlIds.has(pl.id);

    return html`
      <div class="pl-row ${isSel ? "selected" : ""} ${expanded ? "expanded" : ""}"
           draggable="true"
           @click=${(e: MouseEvent) => this._onPlClick(e, pl, idx)}
           @dblclick=${(e: MouseEvent) => { e.stopPropagation(); this._toggleExpand(pl.id); }}
           @dragstart=${(e: DragEvent) => this._onPlDragStart(e, pl)}>

        <!-- chevron acts as the fold/unfold button -->
        <button class="pl-chevron"
                title=${expanded ? "Collapse" : "Expand"}
                @click=${(e: MouseEvent) => { e.stopPropagation(); this._toggleExpand(pl.id); }}>
          ${expanded ? "▾" : "▸"}
        </button>
        <span class="pl-icon">♪</span>

        ${renaming ? html`
          <input class="rename-inp" type="text"
                 .value=${live(this._renameName)}
                 @click=${(e: MouseEvent) => e.stopPropagation()}
                 @input=${(e: Event) => { this._renameName = (e.target as HTMLInputElement).value; }}
                 @keydown=${(e: KeyboardEvent) => {
                   e.stopPropagation();
                   if (e.key === "Enter")  void this._commitRename();
                   if (e.key === "Escape") this._renamingId = null;
                 }} />
          <button class="pl-act" ?disabled=${this._busy}
                  @click=${(e: MouseEvent) => { e.stopPropagation(); void this._commitRename(); }}>✓</button>
          <button class="pl-act"
                  @click=${(e: MouseEvent) => { e.stopPropagation(); this._renamingId = null; }}>✕</button>
        ` : html`
          <span class="pl-name" title="${pl.name}">${pl.name}</span>
          <span class="pl-count">${cnt}</span>
          ${expanded ? html`
            <button class="pl-act"        title=${t("playlists.rename")}
                    @click=${(e: MouseEvent) => { e.stopPropagation(); this._startRename(pl); }}>✏</button>
            <button class="pl-act"        title=${t("playlists.export")}
                    @click=${(e: MouseEvent) => { e.stopPropagation(); this._exportPl(pl.id); }}>⬇</button>
          ` : html`
            <button class="pl-act"         title=${t("playlists.add-all")}
                    @click=${(e: MouseEvent) => { e.stopPropagation(); void this._addAll(pl.id); }}>⊕</button>
            <button class="pl-act primary" title=${t("playlists.play-all")}
                    @click=${(e: MouseEvent) => { e.stopPropagation(); void this._playAll(pl.id); }}>▶</button>
          `}
          <button class="pl-act danger" title=${t("playlists.delete")} ?disabled=${this._busy}
                  @click=${(e: MouseEvent) => { e.stopPropagation(); void this._deletePl(pl); }}>🗑</button>
        `}
      </div>
      ${expanded ? this._renderTrackSection(pl) : nothing}`;
  }

  override render(): TemplateResult {
    const list = this._filteredPlaylists();
    return html`
      <div class="panels">
        <div class="left-panel">

          <div class="toolbar">
            <input class="search-inp" type="text" placeholder="Search playlists…"
                   .value=${live(this._search)}
                   @input=${(e: Event) => { this._search = (e.target as HTMLInputElement).value; }} />
            <button class="tb-btn ${this._sort === "name"    ? "active" : ""}"
                    @click=${() => { this._sort = "name"; }}>A–Z</button>
            <button class="tb-btn ${this._sort === "updated" ? "active" : ""}"
                    @click=${() => { this._sort = "updated"; }}>Edited</button>
            <button class="tb-btn ${this._sort === "played"  ? "active" : ""}"
                    @click=${() => { this._sort = "played"; }}>Played</button>
            <button class="tb-btn" @click=${() => { this._creating = !this._creating; }}>+ New</button>
            <button class="tb-btn" title=${t("playlists.import")} ?disabled=${this._busy}
                    @click=${() => this._triggerImport()}>⬆ Import</button>
          </div>

          ${this._creating ? html`
            <div class="new-form">
              <input type="text" placeholder=${t("playlists.new")}
                     .value=${live(this._newName)}
                     @input=${(e: Event) => { this._newName = (e.target as HTMLInputElement).value; }}
                     @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void this._create(); }} />
              <button class="tb-btn" ?disabled=${this._busy || !this._newName.trim()}
                      @click=${() => void this._create()}>Create</button>
              <button class="tb-btn" @click=${() => { this._creating = false; }}>✕</button>
            </div>` : nothing}

          <div class="scroll">
            ${list.length === 0
              ? html`<div class="empty">${t("playlists.empty")}</div>`
              : list.map((pl, idx) => this._renderPlaylistRow(pl, idx))}
          </div>

          ${this._toast ? html`
            <div class="toast ${this._toastErr ? "err" : ""}">
              ${this._toastErr ? "⚠ " : "✓ "}${this._toast}
            </div>` : nothing}
        </div>

        <queue-panel></queue-panel>
      </div>`;
  }
}
