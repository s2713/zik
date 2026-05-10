/**
 * VolumeNormalizer — Web Audio API RMS-based gain correction.
 *
 * Connects an HTMLAudioElement into an AudioContext graph:
 *   MediaElementSource → AnalyserNode → GainNode → destination
 *
 * On each animation frame it measures the RMS level of the current audio
 * buffer, computes how far it is from the target level (-23 dBFS, matching
 * the EBU R128 loudness target), and nudges the gain toward the correction
 * with a 0.3-second first-order low-pass filter (prevents gain-pumping).
 *
 * Gain is clamped to ±10 dB so the normalizer never amplifies silence into
 * noise or crushes loud transients destructively.
 *
 * CORS caveat: createMediaElementSource() will throw a SecurityError when the
 * audio src is a cross-origin URL without CORS headers (e.g. podcast CDNs,
 * Icecast streams).  connect() catches this and sets blocked = true; callers
 * should then show "Unavailable for this stream".
 */

const TARGET_RMS_DB   = -23;                // EBU R128 target
const MAX_GAIN_DB     =  10;
const MIN_GAIN_DB     = -10;
const SMOOTH_FACTOR   = 0.05;              // per-frame exponential smoothing
const FFT_SIZE        = 2048;
const SILENCE_FLOOR   = 0.0001;           // ignore RMS below this (−80 dBFS)

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function linearToDb(linear: number): number {
  return 20 * Math.log10(Math.max(linear, SILENCE_FLOOR));
}

export class VolumeNormalizer {
  /**
   * Returns true when url is same-origin (or relative/empty).
   * Use this BEFORE calling connect() — createMediaElementSource() internally
   * captures the audio element even when it throws SecurityError, permanently
   * routing its output away from the browser's default audio path (→ silence).
   */
  static isSameOrigin(url: string): boolean {
    if (!url) return true;
    try {
      // Browsers resolve relative URLs into absolute ones when assigning to .src,
      // so url here is always absolute. A relative path can't parse as URL anyway.
      return new URL(url).origin === location.origin;
    } catch {
      return true; // unparseable → treat as same-origin (relative path)
    }
  }


  private _ctx:     AudioContext | null                   = null;
  private _source:  MediaElementAudioSourceNode | null    = null;
  private _analyser: AnalyserNode | null                  = null;
  private _gain:    GainNode | null                       = null;
  private _buf:     Float32Array<ArrayBuffer> | null       = null;
  private _rafId    = 0;
  private _enabled  = false;
  private _blocked  = false;

  /** True when the source URL violated CORS — normalizer unavailable for this stream. */
  get blocked(): boolean { return this._blocked; }

  /** True when normalisation is currently active. */
  get enabled(): boolean { return this._enabled; }

  /**
   * Wire the audio element into the Web Audio graph.
   * Call once before enable(); idempotent (reconnecting the same element is a no-op).
   * Returns false if the element is CORS-blocked or AudioContext creation fails.
   */
  connect(audio: HTMLAudioElement): boolean {
    if (this._source) return !this._blocked;  // already connected

    this._blocked = false;
    try {
      // One AudioContext per page is recommended; reuse if possible.
      this._ctx      = new AudioContext();
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = FFT_SIZE;
      this._buf      = new Float32Array(this._analyser.fftSize);
      this._gain     = this._ctx.createGain();
      this._gain.gain.value = 1.0;

      // createMediaElementSource throws SecurityError on cross-origin audio.
      this._source   = this._ctx.createMediaElementSource(audio);
      this._source.connect(this._analyser);
      this._analyser.connect(this._gain);
      this._gain.connect(this._ctx.destination);
      // Resume immediately — we're always called from a user gesture (click to play).
      // A suspended context silences all audio routed through it.
      void this._ctx.resume();
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === "SecurityError") {
        this._blocked = true;
      } else {
        console.warn("VolumeNormalizer: unexpected error during connect:", err);
        this._blocked = true;
      }
      this._cleanup();
      return false;
    }
  }

  /** Start (or resume) normalisation; no-op if blocked or not connected. */
  enable(): void {
    if (this._blocked || !this._gain) return;
    this._enabled = true;
    // Resume suspended context (browsers suspend AudioContext until user gesture).
    void this._ctx?.resume();
    this._tick();
  }

  /** Resume the AudioContext if the browser auto-suspended it between tracks. */
  resumeContext(): void {
    if (this._ctx?.state === "suspended") void this._ctx.resume();
  }

  /** Stop normalisation and reset gain to unity. */
  disable(): void {
    this._enabled = false;
    cancelAnimationFrame(this._rafId);
    if (this._gain) {
      this._gain.gain.value = 1.0;
    }
  }

  /** Tear down the entire graph (call when element is removed from DOM). */
  disconnect(): void {
    this.disable();
    this._cleanup();
  }

  // ---- private ----

  private _cleanup(): void {
    this._source?.disconnect();
    this._analyser?.disconnect();
    this._gain?.disconnect();
    void this._ctx?.close();
    this._source   = null;
    this._analyser = null;
    this._gain     = null;
    this._buf      = null;
    this._ctx      = null;
  }

  /** RAF loop: measure RMS, compute correction, smooth gain. */
  private _tick(): void {
    if (!this._enabled || !this._analyser || !this._buf || !this._gain) return;

    this._analyser.getFloatTimeDomainData(this._buf);

    // Root Mean Square of the current buffer.
    let sum = 0;
    for (let i = 0; i < this._buf.length; i++) {
      sum += this._buf[i] * this._buf[i];
    }
    const rms = Math.sqrt(sum / this._buf.length);

    if (rms > SILENCE_FLOOR) {
      const rmsDb        = linearToDb(rms);
      const correctionDb = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, TARGET_RMS_DB - rmsDb));
      const target       = dbToLinear(correctionDb);
      // Exponential smoothing toward target gain.
      const current      = this._gain.gain.value;
      this._gain.gain.value = current + (target - current) * SMOOTH_FACTOR;
    }

    this._rafId = requestAnimationFrame(() => { this._tick(); });
  }
}