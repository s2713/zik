/** Track record as returned by GET /api/files/tracks. */
export interface FileTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  duration: number;
  track_number: number | null;
  year: number | null;
}

export interface FilesPlayerState {
  status: "playing" | "paused" | "stopped";
  track: FileTrack | null;
  position: number;   // seconds
  volume: number;     // 0.0 – 1.0
}

/**
 * Audio engine for the files service.
 * Wraps HTMLAudioElement; dispatches "statechange" on every state mutation.
 */
export class FilesPlayer extends EventTarget {
  private readonly _audio = new Audio();
  private _ticker: ReturnType<typeof setInterval> | null = null;

  private _state: FilesPlayerState = {
    status: "stopped",
    track: null,
    position: 0,
    volume: 1.0,
  };

  get state(): Readonly<FilesPlayerState> { return this._state; }

  /** Expose the underlying audio element so callers can attach Web Audio nodes. */
  get audioElement(): HTMLAudioElement { return this._audio; }

  constructor() {
    super();
    // Mirror HTMLAudioElement events into our state machine.
    this._audio.addEventListener("ended",   () => this._onEnded());
    this._audio.addEventListener("pause",   () => this._syncFromAudio());
    this._audio.addEventListener("playing", () => this._syncFromAudio());
  }

  play(track: FileTrack, audioUrl: string): void {
    // Load a new source if the track changed or nothing is loaded.
    if (this._audio.src !== audioUrl) {
      this._audio.src = audioUrl;
      this._audio.load();
    }
    this._state = { ...this._state, track, status: "playing", position: 0 };
    void this._audio.play();
    this._startTicker();
    this._emit();
  }

  pause(): void {
    if (this._state.status !== "playing") return;
    this._audio.pause();
    this._stopTicker();
    this._state = { ...this._state, status: "paused" };
    this._emit();
  }

  resume(): void {
    if (this._state.status !== "paused") return;
    void this._audio.play();
    this._startTicker();
    this._state = { ...this._state, status: "playing" };
    this._emit();
  }

  stop(): void {
    this._audio.pause();
    this._audio.src = "";
    this._stopTicker();
    this._state = { ...this._state, status: "stopped", position: 0 };
    this._emit();
  }

  seek(position: number): void {
    const duration = this._state.track?.duration ?? 0;
    const clamped = Math.max(0, Math.min(duration, position));
    this._audio.currentTime = clamped;
    this._state = { ...this._state, position: clamped };
    this._emit();
  }

  setVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this._audio.volume = clamped;
    this._state = { ...this._state, volume: clamped };
    this._emit();
  }

  // ---- private ----

  private _onEnded(): void {
    this._stopTicker();
    this._state = { ...this._state, status: "stopped", position: 0 };
    this._emit();
  }

  private _syncFromAudio(): void {
    // Keep position in sync after browser-side state changes.
    this._state = {
      ...this._state,
      position: this._audio.currentTime,
    };
    this._emit();
  }

  private _startTicker(): void {
    this._stopTicker();
    // Poll HTMLAudioElement.currentTime every second for position updates.
    this._ticker = setInterval(() => {
      this._state = { ...this._state, position: this._audio.currentTime };
      this._emit();
    }, 1000);
  }

  private _stopTicker(): void {
    if (this._ticker !== null) {
      clearInterval(this._ticker);
      this._ticker = null;
    }
  }

  private _emit(): void {
    this.dispatchEvent(
      new CustomEvent<FilesPlayerState>("statechange", {
        detail: { ...this._state },
      }),
    );
  }
}
