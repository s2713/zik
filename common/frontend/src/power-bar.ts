import { css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

import { getCsrfHeaders } from "./csrf.js";
import { t } from "./i18n/i18n.js";
import { PlayerBase } from "./player-base.js";
import { LOCK_REQUEST_EVENT } from "./screen-lock.js";
import { USER_CHANGED_EVENT, currentUser } from "./session.js";

type PowerAction = "poweroff" | "suspend" | "hibernate";

// Battery Status API — not in standard lib typings; declare minimally.
interface BatteryManager extends EventTarget {
  readonly charging: boolean;
  readonly level: number;           // 0.0–1.0
  addEventListener(type: "chargingchange" | "levelchange", cb: () => void): void;
  removeEventListener(type: "chargingchange" | "levelchange", cb: () => void): void;
}
declare global {
  interface Navigator { getBattery?(): Promise<BatteryManager>; }
}

/**
 * Power management bar: username display + lock button + battery indicator
 * + poweroff / suspend / hibernate buttons.
 */
@customElement("power-bar")
export class PowerBarElement extends PlayerBase {
  static override styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.2rem 0.5rem;
      background: #f4f4f4;
      border-bottom: 1px solid #ddd;
      font-size: 0.8em;
      font-family: sans-serif;
    }
    .user-label { color: #333; font-weight: 500; }
    .battery {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      color: #555;
    }
    .battery-icon { font-size: 1.1em; }
    button {
      padding: 0.1rem 0.45rem;
      border: 1px solid #bbb;
      border-radius: 3px;
      background: #fff;
      cursor: pointer;
      font-size: inherit;
    }
    button:hover { background: #e8e8e8; }
    button:disabled { opacity: 0.5; cursor: default; }
    .lock-btn { border-color: #888; }
    .toast {
      margin-left: auto;
      color: #0057b8;
      font-style: italic;
    }
    .spacer { flex: 1; }
  `;

  @state() private _charging: boolean | null = null;
  @state() private _level: number | null = null;
  @state() private _toast = "";
  @state() private _busy = false;
  @state() private _user = currentUser();

  private _battery: BatteryManager | null = null;
  private _toastTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _onBatteryChange = (): void => {
    if (!this._battery) return;
    this._charging = this._battery.charging;
    this._level    = this._battery.level;
  };
  private readonly _onUserChanged = (e: Event): void => {
    this._user = (e as CustomEvent<string>).detail;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(USER_CHANGED_EVENT, this._onUserChanged);
    void this._initBattery();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(USER_CHANGED_EVENT, this._onUserChanged);
    if (this._battery) {
      this._battery.removeEventListener("chargingchange", this._onBatteryChange);
      this._battery.removeEventListener("levelchange",    this._onBatteryChange);
    }
    if (this._toastTimer !== null) clearTimeout(this._toastTimer);
  }

  private async _initBattery(): Promise<void> {
    if (!navigator.getBattery) return;
    try {
      this._battery = await navigator.getBattery();
      this._battery.addEventListener("chargingchange", this._onBatteryChange);
      this._battery.addEventListener("levelchange",    this._onBatteryChange);
      this._onBatteryChange();
    } catch {
      // Battery API blocked (permissions policy); degrade silently.
    }
  }

  private _lock(): void {
    // Ask the backend to record the lock, then trigger the screen-lock overlay.
    void fetch("/api/session/lock", { method: "POST", headers: getCsrfHeaders() });
    window.dispatchEvent(new CustomEvent(LOCK_REQUEST_EVENT));
  }

  private async _action(action: PowerAction): Promise<void> {
    if (this._busy) return;
    this._busy = true;
    try {
      const res = await fetch(`/api/power/${action}`, {
        method: "POST",
        headers: getCsrfHeaders(),
      });
      const data = (await res.json()) as { simulated?: boolean };
      if (data.simulated) this._showToast(action);
    } catch {
      this._showToast(action);
    } finally {
      this._busy = false;
    }
  }

  private _showToast(action: PowerAction): void {
    this._toast = t("power.simulated").replace("{action}", t(`power.${action}`));
    if (this._toastTimer !== null) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this._toast = ""; }, 3000);
  }

  private _renderBattery() {
    if (this._level === null) return nothing;
    const pct = Math.round(this._level * 100);
    const icon = this._charging ? "⚡" : pct > 20 ? "🔋" : "🪫";
    return html`<span class="battery"><span class="battery-icon">${icon}</span>${pct}%</span>`;
  }

  override render() {
    return html`
      <span class="user-label">${t("session.logged-in-as").replace("{user}", this._user)}</span>
      ${this._renderBattery()}
      <span class="spacer"></span>
      <button class="lock-btn" @click=${() => this._lock()}>${t("session.lock")}</button>
      <button ?disabled=${this._busy} @click=${() => void this._action("suspend")}>
        ${t("power.suspend")}
      </button>
      <button ?disabled=${this._busy} @click=${() => void this._action("hibernate")}>
        ${t("power.hibernate")}
      </button>
      <button ?disabled=${this._busy} @click=${() => void this._action("poweroff")}>
        ${t("power.poweroff")}
      </button>
      ${this._toast ? html`<span class="toast">${this._toast}</span>` : nothing}
    `;
  }
}
