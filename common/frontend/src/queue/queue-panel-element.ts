import { css, html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";

import { PlayerBase } from "../player-base.js";
import { queue } from "./queue-controller.js";
import type { QueueItem, QueueItemEx, QueueStateDetail } from "./queue-item.js";

/** Format seconds as m:ss or h:mm:ss. */
function fmtDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
    : `${m}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Shared cross-service play queue panel.
 * Renders the queue managed by the singleton QueueController.
 * Drop target accepts "queue-items-json" (from search panels) and "queue-indices" (reorder).
 */
@customElement("queue-panel")
export class QueuePanelElement extends PlayerBase {
  static styles = css`
    :host {
      display: flex; flex-direction: column;
      height: 100%; background: #0f172a; color: #f1f5f9;
      font-family: sans-serif; border-left: 1px solid #1e293b;
      overflow: hidden;
    }

    /* ---- controls bar ---- */
    .q-controls {
      flex-shrink: 0; display: flex; align-items: center; gap: 0.3rem;
      flex-wrap: wrap; padding: 0.4rem 0.5rem;
      background: #1e293b; border-bottom: 1px solid #334155;
    }
    .pl-ctrl {
      padding: 0.45em 0.8em; border-radius: 4px; font-size: 0.88em;
      background: #334155; border: none; color: #f1f5f9; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center; line-height: 1;
    }
    .pl-ctrl:hover   { background: #475569; }
    .pl-ctrl.active  { background: #1d4ed8; }
    .pl-ctrl:disabled { opacity: 0.4; cursor: default; }
    .sort-sep { color: #475569; padding: 0 0.1rem; }
    .q-info   { margin-left: auto; font-size: 0.75em; color: #64748b; white-space: nowrap; }

    /* ---- suspended banner ---- */
    .suspended-banner {
      flex-shrink: 0; padding: 0.3rem 0.75rem; font-size: 0.8em;
      background: #1e3a5f; color: #93c5fd; border-bottom: 1px solid #1d4ed8;
    }

    /* ---- track list ---- */
    .q-list { flex: 1; overflow-y: auto; }

    .q-row {
      display: grid;
      grid-template-columns: 2em 32px 1fr auto;
      align-items: center; gap: 0;
      border-bottom: 1px solid #1e293b; font-size: 0.83em;
      cursor: pointer; min-height: 36px;
      background: transparent;
    }
    .q-row:hover             { background: #1e293b; }
    .q-row.playing           { background: rgba(96,165,250,0.18); font-weight: 600; }
    .q-row.selected          { background: rgba(96,165,250,0.10); }
    .q-row.playing.selected  { background: rgba(96,165,250,0.28); }
    .q-row.drop-above        { border-top: 2px solid #3b82f6; }

    /* error states */
    .q-row.err-disconnected  { background: rgba(239,68,68,0.10); }
    .q-row.err-missing       { background: rgba(239,68,68,0.08); }

    .q-num  { padding: 0 0.3rem; color: #475569; font-size: 0.78em; text-align: right; }
    .q-art  {
      width: 32px; height: 32px; object-fit: cover;
      display: block; flex-shrink: 0;
    }
    .q-art-ph {
      width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;
      background: #1e293b; color: #334155; font-size: 1.1em; flex-shrink: 0;
    }

    .q-info-cell {
      padding: 0 0.4rem; overflow: hidden; display: flex; flex-direction: column;
      gap: 0.05rem; min-width: 0;
    }
    .q-title  { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .q-sub    { font-size: 0.78em; color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .q-err-icon { margin-right: 0.25em; font-size: 0.85em; }

    .q-dur { padding: 0 0.4rem; color: #64748b; font-variant-numeric: tabular-nums; font-size: 0.82em; white-space: nowrap; }

    .empty { padding: 1.5rem 1rem; color: #475569; font-size: 0.88em; text-align: center; }
  `;

  // ---- state mirrored from queue singleton ----
  @state() private _items:  QueueItemEx[] = [];
  @state() private _index   = -1;
  @state() private _status  = "stopped";
  @state() private _normOn  = false;
  @state() private _normBlk = false;

  // ---- selection / DnD state (local only) ----
  @state() private _selected:  Set<number> = new Set();
  @state() private _dropIndex: number | null = null;
  private _anchor = -1;

  private readonly _onQueueState = (e: Event): void => {
    const d = (e as CustomEvent<QueueStateDetail>).detail;
    this._items  = d.items;
    this._index  = d.index;
    this._status = d.status;
    this._normOn  = d.normalizeOn;
    this._normBlk = d.normalizeBlocked;
  };

  private readonly _onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (this._selected.size === 0) return;
    const t = e.composedPath()[0];
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    this._removeSelected();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    queue.addEventListener("queue-state", this._onQueueState);
    document.addEventListener("keydown", this._onKeyDown);
    // Initialise from current singleton state.
    this._items  = [...queue.items];
    this._index  = queue.index;
    this._status = queue.status;
    this._normOn  = queue.normalizeOn;
    this._normBlk = queue.normalizeBlocked;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    queue.removeEventListener("queue-state", this._onQueueState);
    document.removeEventListener("keydown", this._onKeyDown);
  }

  // ---- selection ----

  private _onRowClick(e: MouseEvent, i: number): void {
    if (e.shiftKey && this._anchor >= 0) {
      const lo = Math.min(this._anchor, i);
      const hi = Math.max(this._anchor, i);
      const s = new Set<number>();
      for (let j = lo; j <= hi; j++) s.add(j);
      this._selected = s;
    } else if (e.ctrlKey || e.metaKey) {
      const s = new Set(this._selected);
      if (s.has(i)) s.delete(i); else s.add(i);
      this._selected = s;
      this._anchor   = i;
    } else {
      this._selected = new Set([i]);
      this._anchor   = i;
    }
  }

  private _removeSelected(): void {
    queue.remove(this._selected);
    this._selected = new Set();
    this._anchor   = -1;
  }

  // ---- drag-and-drop ----

  private _onRowDragStart(e: DragEvent, i: number): void {
    if (!this._selected.has(i)) this._selected = new Set([i]);
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("queue-indices", JSON.stringify([...this._selected]));
  }

  private _onDragOver(e: DragEvent, i: number): void {
    const types = e.dataTransfer?.types ?? [];
    if (types.includes("queue-indices") || types.includes("queue-items-json")) {
      e.preventDefault();
      if (this._dropIndex !== i) this._dropIndex = i;
    }
  }

  private _onDrop(e: DragEvent, i: number): void {
    e.preventDefault();
    const types = e.dataTransfer?.types ?? [];
    if (types.includes("queue-indices")) {
      const indices: number[] = JSON.parse(e.dataTransfer!.getData("queue-indices"));
      queue.move(indices, i);
    } else if (types.includes("queue-items-json")) {
      // insertAt() preserves playback — no clear/add/playAt needed.
      const items = JSON.parse(e.dataTransfer!.getData("queue-items-json")) as QueueItem[];
      queue.insertAt(items, i);
    }
    this._dropIndex = null;
  }

  private _onDragLeave(): void { this._dropIndex = null; }

  // ---- rendering ----

  private _renderArt(item: QueueItemEx): TemplateResult {
    if (item.artUrl) {
      return html`<img class="q-art" src=${item.artUrl} alt=""
        @error=${(e: Event) => { (e.target as HTMLImageElement).style.display = "none"; }} />`;
    }
    return html`<div class="q-art-ph">♪</div>`;
  }

  private _renderErrIcon(item: QueueItemEx): TemplateResult {
    if (item.state === "error-disconnected")
      return html`<span class="q-err-icon" title="Service disconnected">🔌</span>`;
    if (item.state === "error-missing")
      return html`<span class="q-err-icon" title="Track not found">⚠</span>`;
    return html``;
  }

  override render() {
    const pl      = this._items;
    const hasSel  = this._selected.size > 0;
    const suspended = this._status === "suspended";
    const hasTrack = this._index >= 0;
    const totalDur = pl.reduce((s, it) => s + it.duration, 0);

    return html`
      <!-- control bar -->
      <div class="q-controls">
        <!-- ▶ always plays from index 0 -->
        <button class="pl-ctrl" title="Play from beginning"
                ?disabled=${pl.length === 0}
                @click=${() => queue.playAt(0)}>▶</button>
        <button class="pl-ctrl" title="Remove selected"
                ?disabled=${!hasSel}
                @click=${() => this._removeSelected()}>🗑</button>
        <button class="pl-ctrl" title="Clear queue"
                ?disabled=${pl.length === 0}
                @click=${() => { queue.clear(); this._selected = new Set(); }}>🔥</button>
        <button class="pl-ctrl" title="Shuffle"
                ?disabled=${pl.length < 2}
                @click=${() => queue.shuffle()}>🔀</button>

        <span class="sort-sep">|</span>
        <button class="pl-ctrl" title="Sort by artist → album"
                ?disabled=${pl.length < 2}
                @click=${() => queue.sortBy("artist")}>Artist</button>
        <button class="pl-ctrl" title="Sort by album → artist"
                ?disabled=${pl.length < 2}
                @click=${() => queue.sortBy("album")}>Album</button>
        <button class="pl-ctrl" title="Sort by title"
                ?disabled=${pl.length < 2}
                @click=${() => queue.sortBy("title")}>Title</button>

        <span class="sort-sep">|</span>
        <button class="pl-ctrl ${this._normOn ? "active" : ""}"
                ?disabled=${this._normBlk}
                title=${this._normBlk ? "Normalizer unavailable (cross-origin stream)" : "Volume normalizer"}
                @click=${() => queue.toggleNormalize()}>≈ Norm</button>

        <span class="q-info">
          ${pl.length} track${pl.length !== 1 ? "s" : ""}${pl.length > 0 ? ` · ${fmtDuration(totalDur)}` : ""}
        </span>
      </div>

      <!-- suspended banner -->
      ${suspended ? html`
        <div class="suspended-banner">
          Queue suspended — another service is playing.
          ${hasTrack ? html`<button class="pl-ctrl"
            style="margin-left:0.5rem;padding:0.2em 0.5em;font-size:0.88em;"
            @click=${() => queue.resume()}>Resume queue</button>` : nothing}
        </div>
      ` : nothing}

      <!-- track list -->
      <div class="q-list"
           @dragover=${(e: DragEvent) => this._onDragOver(e, pl.length)}
           @drop=${(e: DragEvent) => this._onDrop(e, pl.length)}
           @dragleave=${() => this._onDragLeave()}>
        ${pl.length === 0
          ? html`<div class="empty">Queue is empty — add tracks from the library using + / ⏭ / ▶</div>`
          : pl.map((item, i) => {
              const isCur  = i === this._index;
              const isSel  = this._selected.has(i);
              const isDrop = this._dropIndex === i;
              const errCls = item.state === "error-disconnected" ? "err-disconnected"
                           : item.state === "error-missing"      ? "err-missing" : "";
              return html`
                <div class="q-row ${isCur ? "playing" : ""} ${isSel ? "selected" : ""} ${isDrop ? "drop-above" : ""} ${errCls}"
                     draggable="true"
                     @click=${(e: MouseEvent) => this._onRowClick(e, i)}
                     @dblclick=${(e: MouseEvent) => { e.stopPropagation(); queue.playAt(i); }}
                     @dragstart=${(e: DragEvent) => this._onRowDragStart(e, i)}
                     @dragover=${(e: DragEvent) => { e.stopPropagation(); this._onDragOver(e, i); }}
                     @drop=${(e: DragEvent) => { e.stopPropagation(); this._onDrop(e, i); }}
                     @dragleave=${(e: DragEvent) => { e.stopPropagation(); this._onDragLeave(); }}>
                  <span class="q-num">${i + 1}</span>
                  ${this._renderArt(item)}
                  <div class="q-info-cell">
                    <span class="q-title">
                      ${this._renderErrIcon(item)}${item.title || item.trackId}
                    </span>
                    <span class="q-sub">${item.artist}${item.album ? ` — ${item.album}` : ""}</span>
                  </div>
                  <span class="q-dur">${fmtDuration(item.duration)}</span>
                </div>
              `;
            })
        }
      </div>
    `;
  }
}
