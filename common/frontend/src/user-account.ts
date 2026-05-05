import { css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

import { getCsrfHeaders } from "./csrf.js";
import { t } from "./i18n/i18n.js";
import { PlayerBase } from "./player-base.js";
import { USER_CHANGED_EVENT, currentUser } from "./session.js";

/** Event dispatched on window when service visibility changes from this panel. */
export const SERVICES_CHANGED_EVENT = "zik-services-changed";

/** Matches the service list in main.ts; kept in sync via this constant. */
const _SERVICES: Array<{ tag: string; i18nKey: string }> = [
  { tag: "demo-player",     i18nKey: "service.demo"     },
  { tag: "files-player",    i18nKey: "service.files"    },
  { tag: "mpd-player",      i18nKey: "service.mpd"      },
  { tag: "subsonic-player", i18nKey: "service.subsonic" },
  { tag: "spotify-player",  i18nKey: "service.spotify"  },
  { tag: "podcasts-player", i18nKey: "service.podcasts" },
  { tag: "radio-player",    i18nKey: "service.radio"    },
];

/** Returns per-user localStorage keys so each user's prefs are independent. */
function _visibleKey(): string { return `zik-demo.${currentUser()}.visible-services`; }
function _shareKey():   string { return `zik-demo.${currentUser()}.share-with-admin`; }

function _loadVisible(): Set<string> {
  try {
    const raw = localStorage.getItem(_visibleKey());
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set(_SERVICES.map((s) => s.tag));
}

function _saveVisible(v: Set<string>): void {
  localStorage.setItem(_visibleKey(), JSON.stringify([...v]));
}

function _loadShares(): Set<string> {
  try {
    const raw = localStorage.getItem(_shareKey());
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

function _saveShares(s: Set<string>): void {
  localStorage.setItem(_shareKey(), JSON.stringify([...s]));
}

/**
 * User account panel: service visibility toggles + share-with-admin checkboxes
 * + password change form.  Collapsible via a header button.
 */
@customElement("user-account")
export class UserAccountElement extends PlayerBase {
  static override styles = css`
    :host {
      display: block;
      font-family: sans-serif;
      font-size: 0.85em;
      border-bottom: 1px solid #ddd;
      background: #fafafa;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.3rem 0.5rem;
      cursor: pointer;
      user-select: none;
      background: #f0f0f0;
      border-bottom: 1px solid #ddd;
    }
    .header:hover { background: #e8e8e8; }
    .caret { font-size: 0.7em; transition: transform 0.15s; }
    .caret.open { transform: rotate(90deg); }
    .body {
      display: flex;
      flex-wrap: wrap;
      gap: 1.5rem;
      padding: 0.8rem 1rem;
    }
    section { min-width: 200px; }
    h3 {
      margin: 0 0 0.4rem;
      font-size: 0.9em;
      text-transform: uppercase;
      color: #666;
      letter-spacing: 0.04em;
    }
    .service-row {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      margin-bottom: 0.25rem;
    }
    .service-name { flex: 1; }
    label { display: flex; align-items: center; gap: 0.25rem; cursor: pointer; }
    .pw-form { display: flex; flex-direction: column; gap: 0.35rem; }
    .pw-form input {
      padding: 0.2rem 0.4rem;
      border: 1px solid #ccc;
      border-radius: 3px;
      font-size: inherit;
      width: 16rem;
    }
    .pw-form button {
      align-self: flex-start;
      padding: 0.2rem 0.8rem;
      border: 1px solid #0057b8;
      border-radius: 3px;
      background: #0057b8;
      color: #fff;
      cursor: pointer;
      font-size: inherit;
    }
    .pw-form button:disabled { opacity: 0.5; cursor: default; }
    .feedback { margin-top: 0.25rem; }
    .feedback.ok    { color: #2a7a2a; }
    .feedback.error { color: #b00; }
    .simulated { color: #999; font-style: italic; }
  `;

  @state() private _open = false;
  @state() private _visible: Set<string> = _loadVisible();
  @state() private _shares: Set<string>  = _loadShares();

  // Password form state.
  @state() private _pwCurrent  = "";
  @state() private _pwNew      = "";
  @state() private _pwConfirm  = "";
  @state() private _pwStatus: { ok: boolean; msg: string; simulated?: boolean } | null = null;
  @state() private _pwBusy = false;

  // Reload per-user prefs when the active user changes.
  private readonly _onUserChanged = (): void => {
    this._visible  = _loadVisible();
    this._shares   = _loadShares();
    this._pwStatus = null;
    window.dispatchEvent(new CustomEvent(SERVICES_CHANGED_EVENT));
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(USER_CHANGED_EVENT, this._onUserChanged);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(USER_CHANGED_EVENT, this._onUserChanged);
  }

  private _toggleService(tag: string): void {
    const v = new Set(this._visible);
    if (v.has(tag)) v.delete(tag); else v.add(tag);
    this._visible = v;
    _saveVisible(v);
    // Notify main.ts so the service bar and player visibility update.
    window.dispatchEvent(new CustomEvent(SERVICES_CHANGED_EVENT));
  }

  private _toggleShare(tag: string): void {
    const s = new Set(this._shares);
    if (s.has(tag)) s.delete(tag); else s.add(tag);
    this._shares = s;
    _saveShares(s);
  }

  private async _submitPassword(e: Event): Promise<void> {
    e.preventDefault();
    if (!this._pwNew) {
      this._pwStatus = { ok: false, msg: t("account.password-empty") };
      return;
    }
    if (this._pwNew !== this._pwConfirm) {
      this._pwStatus = { ok: false, msg: t("account.password-mismatch") };
      return;
    }
    this._pwBusy = true;
    this._pwStatus = null;
    try {
      const res = await fetch("/api/user/password", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({
          current_password: this._pwCurrent,
          new_password: this._pwNew,
        }),
      });
      const data = (await res.json()) as { ok: boolean; simulated?: boolean };
      if (data.ok) {
        this._pwStatus = { ok: true, msg: t("account.password-ok"), simulated: data.simulated ?? false };
        this._pwCurrent = ""; this._pwNew = ""; this._pwConfirm = "";
      } else {
        this._pwStatus = { ok: false, msg: t("account.password-error") };
      }
    } catch {
      this._pwStatus = { ok: false, msg: t("account.password-error") };
    } finally {
      this._pwBusy = false;
    }
  }

  // Renders one service row: enable toggle + name + share checkbox.
  private _renderServiceRow(tag: string, i18nKey: string) {
    const visible = this._visible.has(tag);
    const shared  = this._shares.has(tag);
    return html`
      <div class="service-row">
        <label>
          <input type="checkbox" .checked=${visible}
                 @change=${() => this._toggleService(tag)} />
          <span class="service-name">${t(i18nKey)}</span>
        </label>
        <label title=${t("account.share-admin")}>
          <input type="checkbox" .checked=${shared}
                 @change=${() => this._toggleShare(tag)} />
          <span>↗</span>
        </label>
      </div>
    `;
  }

  private _renderFeedback() {
    if (!this._pwStatus) return nothing;
    return html`
      <div class="feedback ${this._pwStatus.ok ? "ok" : "error"}">
        ${this._pwStatus.msg}
        ${this._pwStatus.simulated
          ? html` <span class="simulated">${t("account.simulated")}</span>`
          : nothing}
      </div>
    `;
  }

  override render() {
    return html`
      <div class="header" @click=${() => { this._open = !this._open; }}>
        <span class="caret ${this._open ? "open" : ""}">▶</span>
        <strong>${t("app.account")}</strong>
      </div>

      ${this._open ? html`
        <div class="body">

          <!-- Service visibility + share-with-admin -->
          <section>
            <h3>${t("account.my-services")}</h3>
            ${_SERVICES.map(({ tag, i18nKey }) => this._renderServiceRow(tag, i18nKey))}
          </section>

          <!-- Password change -->
          <section>
            <h3>${t("account.password")}</h3>
            <form class="pw-form" @submit=${this._submitPassword}>
              <input type="password" placeholder=${t("account.current-password")}
                     .value=${this._pwCurrent}
                     @input=${(e: Event) => { this._pwCurrent = (e.target as HTMLInputElement).value; }} />
              <input type="password" placeholder=${t("account.new-password")}
                     .value=${this._pwNew}
                     @input=${(e: Event) => { this._pwNew = (e.target as HTMLInputElement).value; }} />
              <input type="password" placeholder=${t("account.confirm-password")}
                     .value=${this._pwConfirm}
                     @input=${(e: Event) => { this._pwConfirm = (e.target as HTMLInputElement).value; }} />
              <button type="submit" ?disabled=${this._pwBusy}>
                ${t("account.save-password")}
              </button>
              ${this._renderFeedback()}
            </form>
          </section>

        </div>
      ` : nothing}
    `;
  }
}
