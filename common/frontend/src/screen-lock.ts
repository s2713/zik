import { css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { getCsrfHeaders } from "./csrf.js";
import { t } from "./i18n/i18n.js";
import { PlayerBase } from "./player-base.js";
import { USER_CHANGED_EVENT, currentUser, listUsers, setCurrentUser } from "./session.js";

/** Possible lock states: hidden, showing locking message, fully locked. */
type LockState = "idle" | "locking" | "locked";

/** Custom event name for triggering a lock from outside (e.g. the power bar Lock button). */
export const LOCK_REQUEST_EVENT = "zik-lock-request";

/**
 * Full-viewport screen-lock overlay.
 * In locked state renders a user-picker; selecting a different user switches sessions.
 * Selecting the same user unlocks directly.
 */
@customElement("screen-lock")
export class ScreenLockElement extends PlayerBase {
  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 9999;
      pointer-events: none;
    }
    .overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1.5rem;
      background: #000;
      color: #eee;
      font-family: sans-serif;
      pointer-events: all;
      opacity: 0;
      transition: opacity 1s ease-in;
    }
    .overlay.locking,
    .overlay.locked { opacity: 1; }
    .clock {
      font-size: 4rem;
      font-weight: 300;
      letter-spacing: 0.1em;
    }
    .locking-msg { font-size: 0.95rem; color: #aaa; }
    .pick-label  { font-size: 0.85rem; color: #888; letter-spacing: 0.05em; text-transform: uppercase; }
    .users {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      justify-content: center;
    }
    .user-btn {
      padding: 0.5rem 1.4rem;
      border: 1px solid #444;
      border-radius: 6px;
      background: #111;
      color: #ddd;
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    .user-btn:hover  { background: #222; border-color: #777; }
    .user-btn.active { border-color: #0057b8; color: #fff; }
  `;

  /** Idle timeout in seconds before locking. */
  @property({ type: Number }) timeout = 300;

  /** When true, auto-lock is disabled (admin override). */
  @property({ type: Boolean }) disabled = false;

  @state() private _lockState: LockState = "idle";
  @state() private _clock = "";
  @state() private _users: string[] = [];

  private _idleTimer:     ReturnType<typeof setTimeout>  | null = null;
  private _lockTimer:     ReturnType<typeof setTimeout>  | null = null;
  private _clockInterval: ReturnType<typeof setInterval> | null = null;
  // Suppresses _onActivity for one event-loop tick after a programmatic lock
  // request, so the click that triggered the Lock button doesn't immediately
  // cancel the lock via the document click listener.
  private _lockProgrammatic = false;

  private readonly _onActivity = (): void => {
    if (this._lockProgrammatic)        return;
    if (this._lockState === "locked")  return;
    if (this._lockState === "locking") { this._cancelLock(); return; }
    this._resetIdleTimer();
  };
  private readonly _onKeydown = (): void => {
    // Keydown does not unlock in locked state — user must click a name button.
    if (this._lockState !== "locked") this._onActivity();
  };
  private readonly _onLockRequest = (): void => {
    this._lockProgrammatic = true;
    void this._startLocking();
    // Clear after the current event loop so the triggering click doesn't cancel.
    setTimeout(() => { this._lockProgrammatic = false; }, 0);
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("mousemove",  this._onActivity,    { passive: true });
    document.addEventListener("click",      this._onActivity);
    document.addEventListener("touchstart", this._onActivity,    { passive: true });
    document.addEventListener("keydown",    this._onKeydown);
    window.addEventListener(LOCK_REQUEST_EVENT, this._onLockRequest);
    this._resetIdleTimer();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("mousemove",  this._onActivity);
    document.removeEventListener("click",      this._onActivity);
    document.removeEventListener("touchstart", this._onActivity);
    document.removeEventListener("keydown",    this._onKeydown);
    window.removeEventListener(LOCK_REQUEST_EVENT, this._onLockRequest);
    this._clearTimers();
  }

  private _resetIdleTimer(): void {
    if (this.disabled) return;
    if (this._idleTimer !== null) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => void this._startLocking(), this.timeout * 1000);
  }

  private _clearTimers(): void {
    if (this._idleTimer     !== null) { clearTimeout(this._idleTimer);      this._idleTimer     = null; }
    if (this._lockTimer     !== null) { clearTimeout(this._lockTimer);      this._lockTimer     = null; }
    if (this._clockInterval !== null) { clearInterval(this._clockInterval); this._clockInterval = null; }
  }

  private async _startLocking(): Promise<void> {
    this._updateClock();
    this._lockState = "locking";
    this._clockInterval = setInterval(() => this._updateClock(), 1000);
    this._lockTimer = setTimeout(() => void this._goLocked(), 1500);
    this.dispatchEvent(new CustomEvent("zik-locked", { bubbles: true }));
  }

  private async _goLocked(): Promise<void> {
    this._users = await listUsers();
    this._lockState = "locked";
  }

  private _cancelLock(): void {
    // Abort a lock that is still in the fade-in animation.
    this._lockState = "idle";
    this._clearTimers();
    this._resetIdleTimer();
  }

  private async _selectUser(name: string): Promise<void> {
    const prev = currentUser();
    try {
      await fetch("/api/session/login", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({ username: name }),
      });
    } catch { /* ignore; local state still updates */ }
    setCurrentUser(name);
    if (name !== prev) {
      // Different user — fire USER_CHANGED_EVENT (already done by setCurrentUser)
      // so main.ts and user-account re-render for the new user.
      window.dispatchEvent(new CustomEvent(USER_CHANGED_EVENT, { detail: name }));
    }
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

    if (this._lockState === "locking") {
      return html`
        <div class="overlay locking">
          <div class="clock">${this._clock}</div>
          <div class="locking-msg">${t("screen.locking")}</div>
        </div>
      `;
    }

    // Locked: show user-picker.
    const active = currentUser();
    return html`
      <div class="overlay locked">
        <div class="clock">${this._clock}</div>
        <div class="pick-label">${t("screen.pick-user")}</div>
        <div class="users">
          ${this._users.map((name) => html`
            <button class="user-btn ${name === active ? "active" : ""}"
                    @click=${() => void this._selectUser(name)}>
              ${name}
            </button>
          `)}
        </div>
      </div>
    `;
  }
}
