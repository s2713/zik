/**
 * Singleton cross-service play queue.
 * Owns the single HTMLAudioElement used by all queueable services (files, subsonic, podcast…).
 * Non-queueable services (MPD) call suspend() to pause the queue without clearing it.
 *
 * Dispatches:
 *   "queue-state"    on itself        — consumed by <queue-panel>
 *   "playlist-state" on playerBus     — consumed by the footer transport bar
 */

import { getCsrfHeaders } from "../csrf.js";
import { VolumeNormalizer } from "../audio/normalizer.js";
import { playerBus, dispatchPlayerCmd, type PlayerBusCmd, type PlaylistStateEvent } from "../player-bus.js";
import type { QueueItem, QueueItemEx, QueueItemState, QueueStateDetail } from "./queue-item.js";

type QueueStatus = "playing" | "paused" | "stopped" | "suspended";

class QueueController extends EventTarget {
  private _items:  QueueItemEx[] = [];
  private _index   = -1;
  private _status: QueueStatus = "stopped";
  private _volume  = 1.0;
  private _uid     = 0;
  private _normalizeOn      = false;
  private _normalizeBlocked = false;

  private readonly _audio      = new Audio();
  private readonly _normalizer = new VolumeNormalizer();
  private _ticker: ReturnType<typeof setInterval> | null = null;
  private _playIntending       = false;   // true while playAt/resume play() is in flight
  private _unexpectedPauseTimer: ReturnType<typeof setTimeout> | null = null;

  get items():  readonly QueueItemEx[] { return this._items; }
  get index():  number                 { return this._index; }
  get status(): QueueStatus            { return this._status; }
  get volume(): number                 { return this._volume; }
  get normalizeOn():      boolean      { return this._normalizeOn; }
  get normalizeBlocked(): boolean      { return this._normalizeBlocked; }

  constructor() {
    super();
    this._audio.addEventListener("ended",   () => this._onEnded());
    this._audio.addEventListener("error",   () => void this._onAudioError());
    this._audio.addEventListener("playing", () => {
      // Clear any pending unexpected-pause detection and playAt in-flight flag.
      this._playIntending = false;
      if (this._unexpectedPauseTimer !== null) {
        clearTimeout(this._unexpectedPauseTimer);
        this._unexpectedPauseTimer = null;
      }
      this._startTicker();
    });
    this._audio.addEventListener("pause", () => {
      this._stopTicker();
      // _playIntending: src just changed, play() will be called right after — not a real pause.
      if (this._status !== "playing" || this._playIntending) return;
      // Something outside our control paused the element. Confirm after 300 ms
      // (gives the browser time to recover from transient interruptions).
      this._unexpectedPauseTimer = setTimeout(() => {
        this._unexpectedPauseTimer = null;
        if (this._audio.paused && this._status === "playing") {
          this._status = "paused";
          this._emit();
          this._emitPlaylistState();
        }
      }, 300);
    });
    // Handle transport commands from footer bar even when service panels are unmounted.
    playerBus.addEventListener("cmd", (e) => this._onBusCmd(e as CustomEvent<PlayerBusCmd>));
    // Spotify player signals completion here; queue advances to next item.
    playerBus.addEventListener("spotify-track-ended", () => this._onSpotifyTrackEnded());
  }

  // ---- queue mutations ----

  /** Append tracks to the end of the queue. */
  add(items: QueueItem[]): void {
    this._items = [...this._items, ...this._tag(items)];
    this._emit();
  }

  /**
   * Insert items at an arbitrary queue position without disturbing playback.
   * Adjusts the current index if items are inserted before it.
   * Use this for library drop-onto-queue; avoids the clear+add+playAt dance.
   */
  insertAt(items: QueueItem[], position: number): void {
    const pos   = Math.max(0, Math.min(position, this._items.length));
    const before = this._items.slice(0, pos);
    const after  = this._items.slice(pos);
    this._items  = [...before, ...this._tag(items), ...after];
    if (this._index >= pos) this._index += items.length;
    this._emit();
  }

  /** Insert tracks immediately after the current position. */
  insertNext(items: QueueItem[]): void {
    const ins = this._index + 1;
    this._items = [
      ...this._items.slice(0, ins),
      ...this._tag(items),
      ...this._items.slice(ins),
    ];
    this._emit();
  }

  /** Insert tracks after current position and immediately start playing the first one. */
  playNow(items: QueueItem[]): void {
    const ins = this._index + 1;
    this._items = [
      ...this._items.slice(0, ins),
      ...this._tag(items),
      ...this._items.slice(ins),
    ];
    this.playAt(ins);
  }

  /** Start playing the item at the given index. */
  playAt(index: number): void {
    if (index < 0 || index >= this._items.length) return;
    this._index  = index;
    this._status = "playing";
    const item = this._items[index];
    // Spotify tracks: delegate to the Spotify player element via playerBus; audio element
    // is not used. The player fires "spotify-track-ended" when the track finishes.
    if (item.serviceId === "spotify") {
      dispatchPlayerCmd({ type: "PlaySpotifyTrack", uri: item.audioUrl, serviceId: "spotify" });
      void this._notifyMpris("Play", item);
      this._emit();
      this._emitPlaylistState();
      return;
    }
    // Signal that the imminent "pause" event (from src reassignment) is expected.
    this._playIntending = true;
    this._audio.src    = item.audioUrl;
    this._audio.volume = this._volume;
    this._audio.play().catch(err => {
      // AbortError: a subsequent playAt() interrupted this one — harmless.
      this._playIntending = false;
      if (err instanceof DOMException && err.name === "AbortError") return;
      this._status = "paused";
      this._emit();
      this._emitPlaylistState();
    });
    this._connectNormalizer();
    void this._notifyMpris("Play", item);
    this._emit();
    this._emitPlaylistState();
  }

  /** Remove items by index set; adjusts current index. */
  remove(indices: Set<number>): void {
    const before = (n: number) => [...indices].filter(i => i < n).length;
    const newItems = this._items.filter((_, i) => !indices.has(i));
    if (indices.has(this._index)) {
      this._stopAudio();
      this._status = "stopped";
      this._index  = Math.min(this._index - before(this._index), newItems.length - 1);
    } else {
      this._index -= before(this._index);
    }
    this._items = newItems;
    this._emit();
    this._emitPlaylistState();
  }

  /** Clear the queue and stop playback. */
  clear(): void {
    this._stopAudio();
    this._status = "stopped";
    // Emit playlist-state BEFORE wiping items/index so the footer sees "stopped"
    // immediately; _emitPlaylistState() early-returns on an already-empty queue.
    this._emitPlaylistState();
    this._items  = [];
    this._index  = -1;
    this._emit();
  }

  /** Randomise queue order; keeps the currently playing track at its new position. */
  shuffle(): void {
    const uid = this._currentUid();
    const shuffled = [...this._items].sort(() => Math.random() - 0.5);
    this._items = shuffled;
    this._index = uid !== null ? shuffled.findIndex(i => i.uid === uid) : -1;
    this._emit();
  }

  /** Sort queue by a track field; keeps current track at its new position. */
  sortBy(key: "artist" | "album" | "title" | "duration"): void {
    const uid = this._currentUid();
    const sorted = [...this._items].sort((a, b) => {
      const va = key === "duration" ? a.duration : String(a[key]).toLowerCase();
      const vb = key === "duration" ? b.duration : String(b[key]).toLowerCase();
      return va < vb ? -1 : va > vb ? 1 : 0;
    });
    this._items = sorted;
    this._index = uid !== null ? sorted.findIndex(i => i.uid === uid) : -1;
    this._emit();
  }

  /** Reorder: move items at fromIndices to just before toIndex. */
  move(fromIndices: number[], toIndex: number): void {
    const uid     = this._currentUid();
    const fromSet = new Set(fromIndices);
    const moved   = fromIndices.slice().sort((a, b) => a - b).map(i => this._items[i]);
    const rest    = this._items.filter((_, i) => !fromSet.has(i));
    const adj     = fromIndices.filter(i => i < toIndex).length;
    const ins     = Math.max(0, Math.min(toIndex - adj, rest.length));
    const result  = [...rest.slice(0, ins), ...moved, ...rest.slice(ins)];
    this._items   = result;
    this._index   = uid !== null ? result.findIndex(i => i.uid === uid) : -1;
    this._emit();
  }

  // ---- playback control ----

  pause(): void {
    if (this._status !== "playing") return;
    // Set state FIRST — prevents re-entrant loop when the Pause bus cmd comes back through _onBusCmd.
    this._status = "paused";
    const cur = this._items[this._index];
    if (cur?.serviceId === "spotify") {
      dispatchPlayerCmd({ type: "Pause", serviceId: "spotify" });
    } else {
      this._audio.pause();
    }
    void this._notifyMpris("Pause");
    this._emit();
    this._emitPlaylistState();
  }

  /** Resume a paused or suspended queue. Does not auto-resume after suspend — caller decides. */
  resume(): void {
    if (this._status !== "paused" && this._status !== "suspended") return;
    if (this._index < 0 || this._index >= this._items.length) return;
    this._status = "playing";
    const cur = this._items[this._index];
    if (cur?.serviceId === "spotify") {
      // Resume (no uri) — Spotify continues from paused position.
      dispatchPlayerCmd({ type: "Play", serviceId: "spotify" });
      void this._notifyMpris("Play");
      this._emit();
      this._emitPlaylistState();
      return;
    }
    this._connectNormalizer();  // also resumes AudioContext if auto-suspended
    this._audio.play().catch(err => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      this._status = "paused";
      this._emit();
      this._emitPlaylistState();
    });
    void this._notifyMpris("Play");
    this._emit();
    this._emitPlaylistState();
  }

  /**
   * Suspend playback (non-queueable service is taking over).
   * Pauses audio but preserves queue state and index.
   * Resume is NOT automatic — the user must explicitly click play in the queue panel.
   */
  suspend(): void {
    if (this._status !== "playing" && this._status !== "paused") return;
    // Set state FIRST — prevents re-entrant loop if the Pause bus cmd bounces back.
    this._status = "suspended";
    const cur = this._items[this._index];
    if (cur?.serviceId === "spotify") {
      dispatchPlayerCmd({ type: "Pause", serviceId: "spotify" });
    } else {
      this._audio.pause();
    }
    this._stopTicker();
    this._emit();
    this._emitPlaylistState();
  }

  next(): void { this._advance(this._index + 1); }
  prev(): void { if (this._index > 0) this.playAt(this._index - 1); }

  setVolume(vol: number): void {
    this._volume       = Math.max(0, Math.min(1, vol));
    this._audio.volume = this._volume;
    this._emit();
  }

  toggleNormalize(): void {
    if (this._normalizeBlocked) return;
    this._normalizeOn = !this._normalizeOn;
    if (this._normalizeOn) {
      this._connectNormalizer();
      this._normalizer.enable();
    } else {
      this._normalizer.disable();
    }
    this._emit();
  }

  // ---- bus command handler ----

  /** Handle footer transport commands for the queue's currently-playing service. */
  private _onBusCmd(e: CustomEvent<PlayerBusCmd>): void {
    const cmd = e.detail;
    if (cmd.type === "SuspendQueue") { this.suspend(); return; }
    // Only handle commands targeting the current item's service.
    const cur = this._items[this._index];
    if (!cur || cmd.serviceId !== cur.serviceId) return;
    switch (cmd.type) {
      case "Play":      this.resume();           break;
      case "Pause":     this.pause();            break;
      case "Stop":      this.pause();            break;
      case "Next":      this.next();             break;
      case "Previous":  this.prev();             break;
      case "SetVolume": this.setVolume(cmd.volume); break;
    }
  }

  // ---- private helpers ----

  private _tag(items: QueueItem[]): QueueItemEx[] {
    return items.map(item => ({ ...item, uid: this._uid++, state: "ok" as const }));
  }

  private _currentUid(): number | null {
    return this._items[this._index]?.uid ?? null;
  }

  private _stopAudio(): void {
    this._audio.pause();
    this._audio.src = "";
    this._stopTicker();
  }

  private _connectNormalizer(): void {
    if (!VolumeNormalizer.isSameOrigin(this._audio.src)) {
      this._normalizeBlocked = true; this._normalizer.disable();
    } else if (this._normalizer.blocked) {
      this._normalizeBlocked = true;
    } else {
      const ok = this._normalizer.connect(this._audio);
      this._normalizeBlocked = !ok;
      if (ok && this._normalizeOn) this._normalizer.enable();
      // connect() is idempotent and skips resume() on subsequent calls;
      // call resumeContext() explicitly so the AudioContext never stays suspended.
      if (ok) this._normalizer.resumeContext();
    }
  }

  private _onEnded(): void { this._advance(this._index + 1); }

  /** Called when the Spotify player reports the delegated track has finished. */
  private _onSpotifyTrackEnded(): void {
    const cur = this._items[this._index];
    if (cur?.serviceId === "spotify" && this._status === "playing") {
      this._advance(this._index + 1);
    }
  }

  /** Skip forward from `from`, skipping already-errored items. */
  private _advance(from: number): void {
    for (let i = from; i < this._items.length; i++) {
      if (this._items[i].state === "ok") { this.playAt(i); return; }
    }
    this._status = "stopped";
    this._stopTicker();
    this._emit();
    this._emitPlaylistState();
    void this._notifyMpris("Stop");
  }

  private async _onAudioError(): Promise<void> {
    const item = this._items[this._index];
    if (!item) return;
    const errorState = await this._probeErrorType(item.audioUrl);
    this._items = this._items.map((it, i) =>
      i === this._index ? { ...it, state: errorState } : it
    );
    this._emit();
    this._advance(this._index + 1);
  }

  /**
   * Probe the URL with a HEAD request to distinguish auth failure from missing file.
   * For cross-origin URLs (Subsonic direct), CORS will throw — treat as disconnected.
   */
  private async _probeErrorType(url: string): Promise<QueueItemState> {
    try {
      const r = await fetch(url, { method: "HEAD" });
      return (r.status === 401 || r.status === 403) ? "error-disconnected" : "error-missing";
    } catch {
      return "error-disconnected";  // network error or CORS block
    }
  }

  private _startTicker(): void {
    this._stopTicker();
    this._ticker = setInterval(() => { this._emitPlaylistState(); }, 1000);
  }

  private _stopTicker(): void {
    if (this._ticker !== null) { clearInterval(this._ticker); this._ticker = null; }
  }

  private _emit(): void {
    const detail: QueueStateDetail = {
      items:            [...this._items],
      index:            this._index,
      status:           this._status,
      normalizeOn:      this._normalizeOn,
      normalizeBlocked: this._normalizeBlocked,
      volume:           this._volume,
    };
    this.dispatchEvent(new CustomEvent<QueueStateDetail>("queue-state", { detail }));
  }

  private _emitPlaylistState(): void {
    if (this._index < 0 && this._items.length === 0) return;
    const item = this._items[this._index];
    playerBus.dispatchEvent(
      new CustomEvent<PlaylistStateEvent>("playlist-state", {
        detail: {
          serviceId:     item?.serviceId ?? "",
          status:        this._status,
          index:         this._index,
          total:         this._items.length,
          totalDuration: this._items.reduce((s, it) => s + it.duration, 0),
          position:      this._audio.currentTime,
          duration:      item?.duration ?? 0,
        },
      }),
    );
  }

  private async _notifyMpris(type: string, item?: QueueItemEx): Promise<void> {
    const cur = item ?? this._items[this._index];
    if (!cur) return;
    try {
      await fetch("/api/player/command", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({
          type,
          service:  cur.serviceId,
          track_id: cur.trackId,
          title:    cur.title,
          artist:   cur.artist,
          album:    cur.album,
          duration: cur.duration,
          position: this._audio.currentTime,
          volume:   this._volume,
        }),
      });
    } catch { /* backend unavailable */ }
  }
}

/** Singleton cross-service play queue. Import and use anywhere in the frontend. */
export const queue = new QueueController();
