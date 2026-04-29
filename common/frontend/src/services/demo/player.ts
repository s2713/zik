/** One fake "track" for the demo service. */
export interface Track {
  id: string;
  title: string;
  freq: number;    // Hz — sine wave frequency played for this track
  duration: number; // seconds
}

export interface PlayerState {
  status: "playing" | "paused" | "stopped";
  trackIndex: number;
  position: number;  // seconds, simulated
  volume: number;    // 0.0 – 1.0
}

export const TRACKS: readonly Track[] = [
  { id: "demo:1", title: "Sine 261 Hz (C4)", freq: 261, duration: 30 },
  { id: "demo:2", title: "Sine 330 Hz (E4)", freq: 330, duration: 30 },
  { id: "demo:3", title: "Sine 392 Hz (G4)", freq: 392, duration: 30 },
];

/**
 * Audio engine for the demo service.
 * Uses Web Audio oscillator + gain node; simulates track position with setInterval.
 * Extends EventTarget and dispatches "statechange" on every state mutation.
 */
export class DemoPlayer extends EventTarget {
  private _ctx: AudioContext | null = null;
  private _osc: OscillatorNode | null = null;
  private _gain: GainNode | null = null;
  private _ticker: ReturnType<typeof setInterval> | null = null;

  private _state: PlayerState = {
    status: "stopped",
    trackIndex: 0,
    position: 0,
    volume: 1.0,
  };

  get state(): Readonly<PlayerState> { return this._state; }
  get currentTrack(): Track { return TRACKS[this._state.trackIndex]; }

  play(): void {
    if (this._state.status === "playing") return;
    this._startOsc();
    this._state = { ...this._state, status: "playing" };
    this._startTicker();
    this._emit();
  }

  pause(): void {
    if (this._state.status !== "playing") return;
    this._stopOsc();
    this._stopTicker();
    this._state = { ...this._state, status: "paused" };
    this._emit();
  }

  stop(): void {
    this._stopOsc();
    this._stopTicker();
    this._state = { ...this._state, status: "stopped", position: 0 };
    this._emit();
  }

  next(): void {
    this._changeTrack((this._state.trackIndex + 1) % TRACKS.length);
  }

  prev(): void {
    this._changeTrack((this._state.trackIndex - 1 + TRACKS.length) % TRACKS.length);
  }

  seek(position: number): void {
    const clamped = Math.max(0, Math.min(TRACKS[this._state.trackIndex].duration, position));
    this._state = { ...this._state, position: clamped };
    this._emit();
  }

  setVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this._state = { ...this._state, volume: clamped };
    if (this._gain) this._gain.gain.value = clamped;
    this._emit();
  }

  // ---- private helpers ----

  private _changeTrack(index: number): void {
    // Preserve playing/stopped status across track change; reset position.
    const wasPlaying = this._state.status === "playing";
    this._stopOsc();
    this._stopTicker();
    this._state = { ...this._state, trackIndex: index, position: 0 };
    if (wasPlaying) {
      this._startOsc();
      this._startTicker();
      this._state = { ...this._state, status: "playing" };
    }
    this._emit();
  }

  private _ensureCtx(): AudioContext {
    if (!this._ctx) this._ctx = new AudioContext();
    return this._ctx;
  }

  private _startOsc(): void {
    this._stopOsc();
    const ctx = this._ensureCtx();
    if (ctx.state === "suspended") void ctx.resume();
    // Gain node controls volume.
    this._gain = ctx.createGain();
    this._gain.gain.value = this._state.volume;
    this._gain.connect(ctx.destination);
    // Oscillator at the current track's frequency.
    this._osc = ctx.createOscillator();
    this._osc.type = "sine";
    this._osc.frequency.value = TRACKS[this._state.trackIndex].freq;
    this._osc.connect(this._gain);
    this._osc.start();
  }

  private _stopOsc(): void {
    try { this._osc?.stop(); } catch { /* already stopped */ }
    this._osc?.disconnect();
    this._gain?.disconnect();
    this._osc = null;
    this._gain = null;
  }

  private _startTicker(): void {
    this._stopTicker();
    this._ticker = setInterval(() => {
      const duration = TRACKS[this._state.trackIndex].duration;
      if (this._state.position >= duration - 1) {
        // Auto-advance when the track ends.
        this.next();
      } else {
        this._state = { ...this._state, position: this._state.position + 1 };
        this._emit();
      }
    }, 1000);
  }

  private _stopTicker(): void {
    if (this._ticker !== null) {
      clearInterval(this._ticker);
      this._ticker = null;
    }
  }

  private _emit(): void {
    // Dispatch a copy so listeners can't mutate internal state.
    this.dispatchEvent(new CustomEvent<PlayerState>("statechange", {
      detail: { ...this._state },
    }));
  }
}
