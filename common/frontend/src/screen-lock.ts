import { css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { ensureCsrfToken, getCsrfHeaders } from "./csrf.js";
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
    .admin-btn {
      padding: 0.5rem 1.4rem;
      border: 1px solid #555;
      border-radius: 6px;
      background: #1a1a1a;
      color: #aaa;
      font-size: 0.9rem;
      cursor: pointer;
      margin-top: 0.5rem;
      transition: background 0.15s, border-color 0.15s;
    }
    .admin-btn:hover { background: #222; border-color: #888; color: #ddd; }
    .admin-form {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.75rem;
    }
    .admin-form input {
      padding: 0.4rem 0.75rem;
      border: 1px solid #555;
      border-radius: 5px;
      background: #111;
      color: #eee;
      font-size: 1rem;
      width: 220px;
    }
    .admin-form .row { display: flex; gap: 0.5rem; }
    .admin-form .err { color: #f55; font-size: 0.85rem; min-height: 1.2em; }
    .admin-form .submit-btn {
      padding: 0.4rem 1rem;
      border: 1px solid #0057b8;
      border-radius: 5px;
      background: #0057b8;
      color: #fff;
      cursor: pointer;
    }
    .admin-form .back-btn {
      padding: 0.4rem 1rem;
      border: 1px solid #555;
      border-radius: 5px;
      background: transparent;
      color: #aaa;
      cursor: pointer;
    }
  `;

  /** Idle timeout in seconds before locking. */
  @property({ type: Number }) timeout = 300;

  /** When true, auto-lock is disabled (admin override). */
  @property({ type: Boolean }) disabled = false;

  @state() private _lockState: LockState = "idle";
  @state() private _clock = "";
  @state() private _users: string[] = [];
  @state() private _adminMode    = false;   // password form visible
  @state() private _adminPw      = "";
  @state() private _adminError   = "";
  @state() private _deviceLocked = false;   // admin device-lock active

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
    void this._checkDeviceLock();
    // Force login screen if no user has been selected yet (fresh session = "guest").
    if (currentUser() === "guest") {
      this._lockState = "locked";
      this._updateClock();
      this._clockInterval = setInterval(() => this._updateClock(), 1000);
      void listUsers().then((u) => { this._users = u; });
    } else {
      this._resetIdleTimer();
    }
  }

  private async _checkDeviceLock(): Promise<void> {
    try {
      const r = await fetch("/api/lock/status");
      if (r.ok) {
        const d = await r.json() as { locked: boolean };
        this._deviceLocked = d.locked;
        // If the device is admin-locked, force the lock screen immediately.
        if (this._deviceLocked && this._lockState === "idle") {
          this._lockState = "locked";
          this._updateClock();
          this._clockInterval = setInterval(() => this._updateClock(), 1000);
          void listUsers().then((u) => { this._users = u; });
        }
      }
    } catch { /* non-fatal */ }
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

  private async _submitAdmin(): Promise<void> {
    // POST admin login; on success USER_CHANGED_EVENT triggers a page reload.
    this._adminError = "";
    const attempt = async () => fetch("/api/session/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify({ username: "admin", password: this._adminPw }),
    });
    try {
      let r = await attempt();
      // 401 = stale session (backend restarted); refresh and retry once.
      if (r.status === 401) {
        await ensureCsrfToken();
        r = await attempt();
      }
      if (!r.ok) {
        this._adminError = t("admin.wrong-password");
        this._adminPw = "";
        return;
      }
    } catch {
      this._adminError = t("admin.wrong-password");
      return;
    }
    this._deviceLocked = false;
    setCurrentUser("admin");
    this._lockState = "idle";
    this._clearTimers();
    this._resetIdleTimer();
    this.dispatchEvent(new CustomEvent("zik-unlocked", { bubbles: true }));
  }

  private async _selectUser(name: string): Promise<void> {
    const prev = currentUser();
    try {
      const attempt = async () => fetch("/api/session/login", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({ username: name }),
      });
      let r = await attempt();
      // 401 = stale session (backend restarted); refresh CSRF/session and retry once.
      if (r.status === 401) {
        await ensureCsrfToken();
        r = await attempt();
      }
      // 403 with device-locked means admin re-locked while this screen was open.
      if (!r.ok) {
        const d = await r.json() as { error?: string };
        if (d.error === "device-locked") { this._deviceLocked = true; return; }
      }
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

    // Locked: show user-picker or admin password form.
    const active = currentUser();
    return html`
      <div class="overlay locked">
        <div class="clock">${this._clock}</div>

        ${this._adminMode ? html`
          <!-- Admin password form -->
          <div class="admin-form">
            <div class="pick-label">${t("admin.enter-password")}</div>
            <input type="password" .value=${this._adminPw}
                   @input=${(e: Event) => { this._adminPw = (e.target as HTMLInputElement).value; }}
                   @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void this._submitAdmin(); }}
                   autofocus />
            <div class="err">${this._adminError}</div>
            <div class="row">
              ${!this._deviceLocked ? html`
                <button class="back-btn"
                        @click=${() => { this._adminMode = false; this._adminPw = ""; this._adminError = ""; }}>
                  ← ${t("screen.pick-user")}
                </button>
              ` : nothing}
              <button class="submit-btn" @click=${() => void this._submitAdmin()}>
                ${t("admin.login")}
              </button>
            </div>
          </div>
        ` : this._deviceLocked ? html`
          <!-- Device-locked banner — only admin login available -->
          <div class="pick-label">${t("screen.device-locked")}</div>
          <button class="admin-btn" @click=${() => { this._adminMode = true; }}>
            ${t("admin.login")}
          </button>
        ` : html`
          <!-- Regular user picker + admin entry -->
          <div class="pick-label">${t("screen.pick-user")}</div>
          <div class="users">
            ${this._users.map((name) => html`
              <button class="user-btn ${name === active ? "active" : ""}"
                      @click=${() => void this._selectUser(name)}>
                ${name}
              </button>
            `)}
          </div>
          <button class="admin-btn" @click=${() => { this._adminMode = true; }}>
            ${t("admin.login")}
          </button>
        `}
      </div>
    `;
  }
}
