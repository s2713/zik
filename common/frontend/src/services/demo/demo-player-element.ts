import { css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { getCsrfHeaders } from "../../csrf.js";
import { t } from "../../i18n/i18n.js";
import { PlayerBase } from "../../player-base.js";
import { DemoPlayer, type PlayerState, TRACKS } from "./player.js";

/**
 * Demo service player element.
 * Renders controls for a Web Audio sine-wave player and syncs state to the backend.
 */
@customElement("demo-player")
export class DemoPlayerElement extends PlayerBase {
  static styles = css`
    :host { display: block; font-family: sans-serif; padding: 1rem; max-width: 500px; }
    .track  { font-weight: bold; margin-bottom: 0.25rem; }
    .time   { font-variant-numeric: tabular-nums; margin-bottom: 0.5rem; color: #555; }
    .seek   { width: 100%; margin-bottom: 0.75rem; }
    .ctrls  { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
    .vol    { display: flex; align-items: center; gap: 0.5rem; }
    .vol input { width: 120px; }
  `;

  private readonly _player = new DemoPlayer();

  // Arrow-function reference so the same instance is removed in disconnectedCallback.
  private readonly _onStateChange = (e: Event): void => {
    this._ps = (e as CustomEvent<PlayerState>).detail;
  };

  @state() private _ps: PlayerState = { ...this._player.state };

  override connectedCallback(): void {
    super.connectedCallback();
    this._player.addEventListener("statechange", this._onStateChange);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._player.removeEventListener("statechange", this._onStateChange);
    this._player.stop();
  }

  // ---- control handlers (fire local action + notify backend) ----

  private _play(): void    { this._player.play();  void this._post("Play");     }
  private _pause(): void   { this._player.pause(); void this._post("Pause");    }
  private _stop(): void    { this._player.stop();  void this._post("Stop");     }
  private _next(): void    { this._player.next();  void this._post("Next");     }
  private _prev(): void    { this._player.prev();  void this._post("Previous"); }

  private _onSeek(e: Event): void {
    this._player.seek(Number((e.target as HTMLInputElement).value));
    void this._post("Seek");
  }

  private _onVolume(e: Event): void {
    this._player.setVolume(Number((e.target as HTMLInputElement).value) / 100);
    void this._post("SetVolume");
  }

  // ---- backend sync ----

  private async _post(type: string): Promise<void> {
    // Read state from the player directly (already mutated by the action above).
    const ps = this._player.state;
    const track = this._player.currentTrack;
    try {
      await fetch("/api/player/command", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({
          type,
          service:   "demo",
          track_id:  track.id,
          title:     track.title,
          duration:  track.duration,
          position:  ps.position,
          volume:    ps.volume,
        }),
      });
    } catch {
      // Backend unavailable; UI continues playing locally.
    }
  }

  // ---- rendering ----

  private _fmt(seconds: number): string {
    const m = String(Math.floor(seconds / 60)).padStart(2, "0");
    const s = String(Math.floor(seconds % 60)).padStart(2, "0");
    return `${m}:${s}`;
  }

  override render() {
    const ps = this._ps;
    const track = TRACKS[ps.trackIndex];
    const playing = ps.status === "playing";

    return html`
      <div class="track">${t("service.demo")} — ${track.title}</div>
      <div class="time">${this._fmt(ps.position)} / ${this._fmt(track.duration)}</div>

      <!-- live() prevents the seek bar from jumping during user drag -->
      <input class="seek" type="range" min="0" max="${track.duration}"
             .value=${live(ps.position)} @change=${this._onSeek} />

      <div class="ctrls">
        <button @click=${this._prev}>${t("player.prev")}</button>
        <button @click=${playing ? this._pause : this._play}>
          ${playing ? t("player.pause") : t("player.play")}
        </button>
        <button @click=${this._stop}>${t("player.stop")}</button>
        <button @click=${this._next}>${t("player.next")}</button>
      </div>

      <div class="vol">
        <span>${t("player.volume")}</span>
        <input type="range" min="0" max="100"
               .value=${live(Math.round(ps.volume * 100))} @input=${this._onVolume} />
      </div>
    `;
  }
}
