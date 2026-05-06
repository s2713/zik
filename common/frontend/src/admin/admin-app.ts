import { css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

import { getCsrfHeaders } from "../csrf.js";
import { t } from "../i18n/i18n.js";
import { PlayerBase } from "../player-base.js";

type AdminTab = "users" | "services" | "network" | "device";

// Re-auth token lifetime must match backend _REAUTH_TTL (60 s).
const REAUTH_TTL_MS = 60_000;

/**
 * Admin interface shell.
 * Renders four configuration tabs; each tab's content is stubbed for A1.
 * Re-auth dialog gates destructive actions (password re-verified every 60 s).
 */
@customElement("admin-app")
export class AdminApp extends PlayerBase {
  static override styles = css`
    :host {
      display: block;
      font-family: sans-serif;
      max-width: 900px;
      margin: 1rem auto;
      padding: 0 1rem;
    }

    /* ---- tab bar ---- */
    .tabs {
      display: flex;
      gap: 0.25rem;
      border-bottom: 2px solid #ddd;
      margin-bottom: 1.5rem;
    }
    .tab-btn {
      padding: 0.5rem 1.2rem;
      border: 1px solid transparent;
      border-bottom: none;
      border-radius: 5px 5px 0 0;
      background: transparent;
      cursor: pointer;
      font-size: 0.95rem;
      color: #555;
      transition: background 0.15s;
    }
    .tab-btn:hover   { background: #f0f0f0; }
    .tab-btn.active  {
      background: #fff;
      border-color: #ddd;
      color: #111;
      font-weight: 600;
      margin-bottom: -2px;
      border-bottom: 2px solid #fff;
    }

    /* ---- tab content ---- */
    .panel { padding: 0.5rem 0; }
    .stub  { color: #888; font-style: italic; }

    /* ---- re-auth modal ---- */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal {
      background: #fff;
      border-radius: 8px;
      padding: 1.5rem 2rem;
      min-width: 300px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.18);
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .modal h2  { margin: 0; font-size: 1.1rem; }
    .modal p   { margin: 0; color: #555; font-size: 0.9rem; }
    .modal input {
      padding: 0.4rem 0.75rem;
      border: 1px solid #bbb;
      border-radius: 5px;
      font-size: 1rem;
      width: 100%;
      box-sizing: border-box;
    }
    .modal .err     { color: #c00; font-size: 0.85rem; min-height: 1.2em; }
    .modal .actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
    .btn-primary {
      padding: 0.4rem 1rem;
      border: none;
      border-radius: 5px;
      background: #0057b8;
      color: #fff;
      cursor: pointer;
      font-size: 0.95rem;
    }
    .btn-secondary {
      padding: 0.4rem 1rem;
      border: 1px solid #bbb;
      border-radius: 5px;
      background: #fff;
      cursor: pointer;
      font-size: 0.95rem;
    }
  `;

  @state() private _tab: AdminTab = "users";

  // Re-auth state.
  @state() private _reauthVisible = false;
  @state() private _reauthPw      = "";
  @state() private _reauthError   = "";
  private _reauthPending: (() => void) | null = null;
  private _lastReauth = 0;   // ms timestamp of last successful re-auth

  // ---- public API for tab panels ----

  /** Gate an action behind re-auth; calls fn immediately if token is fresh. */
  requireReauth(fn: () => void): void {
    if (Date.now() - this._lastReauth < REAUTH_TTL_MS) {
      fn();
      return;
    }
    this._reauthPending  = fn;
    this._reauthPw       = "";
    this._reauthError    = "";
    this._reauthVisible  = true;
  }

  // ---- re-auth dialog handlers ----

  private async _submitReauth(): Promise<void> {
    this._reauthError = "";
    try {
      const r = await fetch("/api/session/reauth", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({ password: this._reauthPw }),
      });
      if (!r.ok) {
        this._reauthError = t("admin.wrong-password");
        this._reauthPw = "";
        return;
      }
    } catch {
      this._reauthError = t("admin.wrong-password");
      return;
    }
    this._lastReauth    = Date.now();
    this._reauthVisible = false;
    const fn = this._reauthPending;
    this._reauthPending = null;
    fn?.();
  }

  private _cancelReauth(): void {
    this._reauthVisible = false;
    this._reauthPending = null;
  }

  // ---- tab content (stubs for A1) ----

  private _renderUsers()    { return html`<div class="panel"><p class="stub">${t("admin.stub")}</p></div>`; }
  private _renderServices() { return html`<div class="panel"><p class="stub">${t("admin.stub")}</p></div>`; }
  private _renderNetwork()  { return html`<div class="panel"><p class="stub">${t("admin.stub")}</p></div>`; }
  private _renderDevice()   { return html`<div class="panel"><p class="stub">${t("admin.stub")}</p></div>`; }

  // ---- render ----

  override render() {
    return html`
      <!-- Tab bar -->
      <nav class="tabs">
        ${(["users", "services", "network", "device"] as AdminTab[]).map((tab) => html`
          <button class="tab-btn ${this._tab === tab ? "active" : ""}"
                  @click=${() => { this._tab = tab; }}>
            ${t(`admin.tab.${tab}`)}
          </button>
        `)}
      </nav>

      <!-- Active tab panel -->
      ${this._tab === "users"    ? this._renderUsers()    : nothing}
      ${this._tab === "services" ? this._renderServices() : nothing}
      ${this._tab === "network"  ? this._renderNetwork()  : nothing}
      ${this._tab === "device"   ? this._renderDevice()   : nothing}

      <!-- Re-auth modal (portal-style overlay) -->
      ${this._reauthVisible ? html`
        <div class="modal-backdrop" @click=${(e: Event) => { if (e.target === e.currentTarget) this._cancelReauth(); }}>
          <div class="modal">
            <h2>${t("admin.reauth.title")}</h2>
            <p>${t("admin.reauth.reason")}</p>
            <input type="password" .value=${this._reauthPw}
                   placeholder=${t("admin.enter-password")}
                   @input=${(e: Event) => { this._reauthPw = (e.target as HTMLInputElement).value; }}
                   @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void this._submitReauth(); }} />
            <div class="err">${this._reauthError}</div>
            <div class="actions">
              <button class="btn-secondary" @click=${this._cancelReauth}>${t("admin.reauth.cancel")}</button>
              <button class="btn-primary"   @click=${() => void this._submitReauth()}>${t("admin.reauth.confirm")}</button>
            </div>
          </div>
        </div>
      ` : nothing}
    `;
  }
}
