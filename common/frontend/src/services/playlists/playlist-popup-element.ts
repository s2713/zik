import { css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { PlayerBase } from "../../player-base.js";
import { queue } from "../../queue/queue-controller.js";
import type { QueueItem } from "../../queue/queue-item.js";
import { t } from "../../i18n/i18n.js";
import {
  listPlaylists, createPlaylist, addTracks, getPlaylist, touchLastPlayed,
  entryToQueueItem, queueItemToEntry,
} from "./playlist-api.js";

/** Fired on window after any playlist mutation so other panels can refresh. */
export const PLAYLISTS_CHANGED_EVENT = "zik-playlists-changed";
import type { Playlist } from "./playlist.js";

/**
 * Modal overlay popup for playlist operations.
 * mode="add"    → lets the user pick/create a playlist and add `items` to it.
 * mode="browse" → lets the user play, queue, or open playlists.
 * Dispatches "close" and "open-service" (CustomEvent, non-bubbling).
 */
@customElement("playlist-popup")
export class PlaylistPopupElement extends PlayerBase {
  static override styles = css`
    /* full-screen dark overlay */
    .overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.65);
      z-index: 400;
      display: flex; align-items: center; justify-content: center;
    }

    /* popup panel */
    .panel {
      background: #1e293b; border: 1px solid #334155; border-radius: 14px;
      width: min(420px, 92vw); max-height: 80vh;
      display: flex; flex-direction: column;
      box-shadow: 0 24px 64px rgba(0,0,0,0.75);
      overflow: hidden;
    }

    .header {
      display: flex; align-items: center; gap: 0.6rem;
      padding: 0.9rem 1rem; border-bottom: 1px solid #334155; flex-shrink: 0;
    }
    .header-title { font-size: 1rem; font-weight: 600; flex: 1; }
    .close-btn {
      width: 34px; height: 34px; border-radius: 8px;
      background: rgba(255,255,255,0.07); border: none;
      color: #f8fafc; cursor: pointer; font-size: 1rem;
      display: flex; align-items: center; justify-content: center;
    }
    .close-btn:hover { background: rgba(255,255,255,0.14); }

    /* toolbar: search + sort */
    .toolbar {
      display: flex; gap: 0.4rem; padding: 0.6rem 0.75rem;
      border-bottom: 1px solid #334155; flex-shrink: 0;
    }
    .search-inp {
      flex: 1; padding: 0.3em 0.5em;
      background: #0f172a; border: 1px solid #475569;
      border-radius: 6px; color: #f1f5f9; font-size: 0.88em;
    }
    .search-inp:focus { outline: none; border-color: #60a5fa; }
    .sort-btn {
      padding: 0.3em 0.65em; border-radius: 6px; font-size: 0.82em;
      background: #334155; border: none; color: #94a3b8; cursor: pointer;
    }
    .sort-btn.active { background: #1d4ed8; color: #f1f5f9; }

    .new-btn {
      padding: 0.3em 0.7em; border-radius: 6px; font-size: 0.82em;
      background: #334155; border: none; color: #f1f5f9; cursor: pointer;
      white-space: nowrap;
    }
    .new-btn:hover { background: #475569; }

    /* new-playlist form */
    .new-form {
      display: flex; gap: 0.4rem; padding: 0.5rem 0.75rem;
      border-bottom: 1px solid #334155; flex-shrink: 0; background: #0f172a;
    }
    .new-form input {
      flex: 1; padding: 0.3em 0.5em;
      background: #1e293b; border: 1px solid #475569;
      border-radius: 6px; color: #f1f5f9; font-size: 0.88em;
    }
    .new-form input:focus { outline: none; border-color: #60a5fa; }
    .new-form button {
      padding: 0.3em 0.7em; border-radius: 6px; font-size: 0.82em;
      background: #1d4ed8; border: none; color: #f1f5f9; cursor: pointer;
    }
    .new-form button:disabled { opacity: 0.5; cursor: default; }

    /* playlist list */
    .list { flex: 1; overflow-y: auto; }
    .pl-row {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.55rem 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .pl-row:hover { background: rgba(255,255,255,0.04); }
    .pl-name { flex: 1; font-size: 0.92em; font-weight: 500; min-width: 0;
               overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pl-count { font-size: 0.78em; color: #64748b; white-space: nowrap; margin-right: 0.2rem; }
    .act-btn {
      padding: 0.3em 0.55em; border-radius: 5px; font-size: 0.82em;
      background: #334155; border: none; color: #f1f5f9; cursor: pointer; flex-shrink: 0;
    }
    .act-btn:hover { background: #475569; }
    .act-btn.primary { background: #1d4ed8; }
    .act-btn.primary:hover { background: #2563eb; }

    /* states */
    .empty    { padding: 2rem 1rem; color: #475569; font-size: 0.88em; text-align: center; }
    .toast    { padding: 0.5rem 1rem; font-size: 0.83em; color: #34d399;
                border-top: 1px solid #334155; text-align: center; flex-shrink: 0; }
    .err-msg  { padding: 0.5rem 1rem; font-size: 0.83em; color: #f87171;
                border-top: 1px solid #334155; text-align: center; flex-shrink: 0; }
  `;

  /** "add" — add items to a chosen playlist; "browse" — manage/play playlists. */
  @property({ type: String }) mode: "add" | "browse" = "add";
  /** Tracks to add (only used in "add" mode). */
  @property({ type: Array }) items: QueueItem[] = [];

  @state() private _playlists: Playlist[] = [];
  @state() private _search  = "";
  @state() private _sort: "name" | "updated" | "played" = "name";
  @state() private _creating = false;
  @state() private _newName  = "";
  @state() private _busy     = false;
  @state() private _toast    = "";
  @state() private _err      = "";
  private _toastTimer: ReturnType<typeof setTimeout> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    void this._load();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._toastTimer !== null) clearTimeout(this._toastTimer);
  }

  private async _load(): Promise<void> {
    try {
      this._playlists = await listPlaylists();
      this._err = "";
    } catch {
      this._err = t("playlists.err-load");
    }
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent("close"));
  }

  private _openService(): void {
    this.dispatchEvent(new CustomEvent("open-service"));
  }

  private _showToast(msg: string): void {
    this._toast = msg;
    if (this._toastTimer !== null) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this._toast = ""; this._close(); }, 1800);
  }

  private async _createAndAdd(): Promise<void> {
    const name = this._newName.trim();
    if (!name) return;
    this._busy = true;
    try {
      const pl = await createPlaylist(name);
      window.dispatchEvent(new CustomEvent(PLAYLISTS_CHANGED_EVENT));
      if (this.mode === "add" && this.items.length > 0) {
        await addTracks(pl.id, this.items.map(queueItemToEntry));
        this._showToast(`${t("playlists.added")} "${pl.name}"`);
      }
      await this._load();
      this._creating = false;
      this._newName  = "";
    } finally {
      this._busy = false;
    }
  }

  private async _addTo(pl: Playlist): Promise<void> {
    this._busy = true;
    try {
      await addTracks(pl.id, this.items.map(queueItemToEntry));
      window.dispatchEvent(new CustomEvent(PLAYLISTS_CHANGED_EVENT));
      this._showToast(`${t("playlists.added")} "${pl.name}"`);
    } finally {
      this._busy = false;
    }
  }

  /** Load playlist tracks and replace queue, start playing from 0. */
  private async _playAll(pl: Playlist): Promise<void> {
    this._busy = true;
    try {
      const detail = await getPlaylist(pl.id);
      const items  = detail.tracks.map(entryToQueueItem);
      queue.clear();
      queue.add(items);
      queue.playAt(0);
      await touchLastPlayed(pl.id);
    } finally {
      this._busy = false;
    }
    this._close();
  }

  /** Append playlist tracks to the queue. */
  private async _queueAll(pl: Playlist): Promise<void> {
    this._busy = true;
    try {
      const detail = await getPlaylist(pl.id);
      const items  = detail.tracks.map(entryToQueueItem);
      queue.add(items);
      await touchLastPlayed(pl.id);
    } finally {
      this._busy = false;
    }
    this._close();
  }

  // ---- filtering / sorting ----

  private _filtered(): Playlist[] {
    let list = this._playlists;
    const q = this._search.toLowerCase();
    if (q) list = list.filter(pl => pl.name.toLowerCase().includes(q));
    if (this._sort === "updated") list = [...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    else if (this._sort === "played") {
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

  private _renderRow(pl: Playlist): TemplateResult {
    const cnt = `${pl.track_count} track${pl.track_count !== 1 ? "s" : ""}`;
    if (this.mode === "add") {
      return html`
        <div class="pl-row">
          <span class="pl-name" title="${pl.name}">♪ ${pl.name}</span>
          <span class="pl-count">${cnt}</span>
          <button class="act-btn primary" ?disabled=${this._busy}
                  @click=${() => void this._addTo(pl)}>+ Add</button>
        </div>`;
    }
    return html`
      <div class="pl-row">
        <span class="pl-name" title="${pl.name}">♪ ${pl.name}</span>
        <span class="pl-count">${cnt}</span>
        <button class="act-btn" ?disabled=${this._busy}
                title=${t("playlists.add-all")}
                @click=${() => void this._queueAll(pl)}>⊕</button>
        <button class="act-btn primary" ?disabled=${this._busy}
                title=${t("playlists.play-all")}
                @click=${() => void this._playAll(pl)}>▶</button>
        <button class="act-btn" title="Open in Playlists service"
                @click=${() => { this._openService(); }}>↗</button>
      </div>`;
  }

  override render(): TemplateResult {
    const filtered = this._filtered();
    const noSel    = this.mode === "add" && this.items.length === 0;
    return html`
      <div class="overlay" @click=${(e: Event) => { if (e.target === e.currentTarget) this._close(); }}>
        <div class="panel" @click=${(e: Event) => e.stopPropagation()}>

          <div class="header">
            <span class="header-title">
              ${this.mode === "add" ? t("playlists.add-to") : t("playlists.browse")}
            </span>
            ${this.mode === "browse" ? html`
              <button class="close-btn" title="Open Playlists service"
                      @click=${() => { this._close(); this._openService(); }}>↗</button>
            ` : nothing}
            <button class="close-btn" @click=${() => this._close()}>✕</button>
          </div>

          ${noSel
            ? html`<div class="empty">${t("playlists.no-selection")}</div>`
            : html`
              <div class="toolbar">
                <input class="search-inp" type="text" placeholder="Search…"
                       .value=${live(this._search)}
                       @input=${(e: Event) => { this._search = (e.target as HTMLInputElement).value; }} />
                <button class="sort-btn ${this._sort === "name"    ? "active" : ""}"
                        @click=${() => { this._sort = "name"; }}>A–Z</button>
                <button class="sort-btn ${this._sort === "updated" ? "active" : ""}"
                        @click=${() => { this._sort = "updated"; }}>Edited</button>
                <button class="sort-btn ${this._sort === "played"  ? "active" : ""}"
                        @click=${() => { this._sort = "played"; }}>Played</button>
                <button class="new-btn" @click=${() => { this._creating = !this._creating; }}>+ New</button>
              </div>

              ${this._creating ? html`
                <div class="new-form">
                  <input type="text" placeholder=${t("playlists.new")}
                         .value=${live(this._newName)}
                         @input=${(e: Event) => { this._newName = (e.target as HTMLInputElement).value; }}
                         @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void this._createAndAdd(); }} />
                  <button ?disabled=${this._busy || !this._newName.trim()}
                          @click=${() => void this._createAndAdd()}>Create</button>
                </div>` : nothing}

              <div class="list">
                ${this._err
                  ? html`<div class="empty">${this._err}</div>`
                  : filtered.length === 0
                    ? html`<div class="empty">${t("playlists.empty")}</div>`
                    : filtered.map(pl => this._renderRow(pl))}
              </div>
            `}

          ${this._toast ? html`<div class="toast">✓ ${this._toast}</div>`  : nothing}
        </div>
      </div>`;
  }
}
