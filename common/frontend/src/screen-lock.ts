import { css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { t } from "./i18n/i18n.js";
import { PlayerBase } from "./player-base.js";

/** Possible lock states: hidden, showing locking message, fully locked. */
type LockState = "idle" | "locking" | "locked";

/**
 * Full-viewport screen-lock overlay.
 * Mounts on <body>; tracks user activity and locks after `timeout` idle seconds.
 * Click or keydown on the overlay unlocks (demo: no auth; production: M16 login).
 */
@customElement("screen-lock")
export class ScreenLockElement extends PlayerBase {
  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 9999;
      pointer-events: none; /* idle: pass events through */
    }
    .overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #000;
      color: #eee;
      font-family: sans-serif;
      pointer-events: all; /* capture all input when visible */
      opacity: 0;
      transition: opacity 1s ease-in;
      cursor: pointer;
    }
    .overlay.locking,
    .overlay.locked {
      opacity: 1;
    }
    .clock {
      font-size: 4rem;
      font-weight: 300;
      letter-spacing: 0.1em;
      margin-bottom: 1rem;
    }
    .msg {
      font-size: 0.95rem;
      color: #aaa;
    }
  `;

  /** Idle timeout in seconds before locking. */
  @property({ type: Number }) timeout = 300;

  /** When true, auto-lock is disabled (admin override). */
  @property({ type: Boolean }) disabled = false;

  @state() private _lockState: LockState = "idle";
  @state() private _clock = "";

  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _lockTimer: ReturnType<typeof setTimeout> | null = null;
  private _clockInterval: ReturnType<typeof setInterval> | null = null;

  // Arrow-function refs so the same instances are removed in disconnectedCallback.
  private readonly _onActivity = (): void => {
    if (this._lockState === "locked") return;
    if (this._lockState === "locking") { this._unlock(); return; }
    this._resetIdleTimer();
  };
  private readonly _onKeydown = (): void => {
    if (this._lockState === "locked") { this._unlock(); return; }
    this._onActivity();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("mousemove", this._onActivity, { passive: true });
    document.addEventListener("click",     this._onActivity);
    document.addEventListener("touchstart",this._onActivity, { passive: true });
    document.addEventListener("keydown",   this._onKeydown);
    this._resetIdleTimer();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("mousemove",  this._onActivity);
    document.removeEventListener("click",      this._onActivity);
    document.removeEventListener("touchstart", this._onActivity);
    document.removeEventListener("keydown",    this._onKeydown);
    this._clearTimers();
  }

  private _resetIdleTimer(): void {
    if (this.disabled) return;
    if (this._idleTimer !== null) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => void this._startLocking(), this.timeout * 1000);
  }

  private _clearTimers(): void {
    if (this._idleTimer !== null)   { clearTimeout(this._idleTimer);    this._idleTimer   = null; }
    if (this._lockTimer !== null)   { clearTimeout(this._lockTimer);    this._lockTimer   = null; }
    if (this._clockInterval !== null) { clearInterval(this._clockInterval); this._clockInterval = null; }
  }

  private _startLocking(): void {
    this._updateClock();
    this._lockState = "locking";
    // Start clock tick so the time is live when the locked screen shows.
    this._clockInterval = setInterval(() => this._updateClock(), 1000);
    // After 1s fade + 0.5s message read → go fully locked.
    this._lockTimer = setTimeout(() => { this._lockState = "locked"; }, 1500);
    this.dispatchEvent(new CustomEvent("zik-locked", { bubbles: true }));
  }

  private _unlock(): void {
    this._lockState = "idle";
    this._clearTimers();
    this._resetIdleTimer();
    this.dispatchEvent(new CustomEvent("zik-unlocked", { bubbles: true }));
  }

  private _updateClock(): void {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, "0");
    const m = String(now.getMinutes()).padStart(2, "0");
    this._clock = `${h}:${m}`;
  }

  override render() {
    if (this._lockState === "idle") return nothing;

    const msg = this._lockState === "locking"
      ? t("screen.locking")
      : t("screen.click-to-unlock");

    return html`
      <div class="overlay ${this._lockState}" @click=${() => this._unlock()}>
        <div class="clock">${this._clock}</div>
        <div class="msg">${msg}</div>
      </div>
    `;
  }
}