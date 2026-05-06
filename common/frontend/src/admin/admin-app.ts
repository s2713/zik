import { css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { getCsrfHeaders } from "../csrf.js";
import { t } from "../i18n/i18n.js";
import { PlayerBase } from "../player-base.js";
import { SERVICES } from "../services-list.js";

type AdminTab = "users" | "services" | "network" | "device";

const REAUTH_TTL_MS = 60_000;

interface ServiceInfo {
  id:             string;
  global_enabled: boolean;
  credentials:    Record<string, string>;
  cred_fields:    string[];
}

interface UserInfo {
  username:  string;
  disabled:  boolean;
  quota_mb:  number;
  services:  string[];
  bluetooth: boolean;
  wifi:      boolean;
}

/**
 * Admin interface shell.
 * Tab bar with four sections; Users tab is fully implemented (A3).
 * Re-auth modal gates destructive actions with a 60-second token.
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
    .tab-btn:hover  { background: #f0f0f0; }
    .tab-btn.active {
      background: #fff;
      border-color: #ddd;
      color: #111;
      font-weight: 600;
      margin-bottom: -2px;
      border-bottom: 2px solid #fff;
    }

    /* ---- stub panels ---- */
    .stub { color: #888; font-style: italic; }

    /* ---- user list ---- */
    .user-list { display: flex; flex-direction: column; gap: 0.5rem; }

    .user-row {
      border: 1px solid #ddd;
      border-radius: 6px;
      overflow: hidden;
    }
    .user-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.5rem 0.75rem;
      background: #f8f8f8;
      cursor: pointer;
      user-select: none;
    }
    .user-header:hover { background: #f0f0f0; }
    .username  { font-weight: 600; flex: 1; }
    .badge {
      font-size: 0.75rem;
      padding: 0.15rem 0.5rem;
      border-radius: 10px;
      border: 1px solid;
    }
    .badge.active   { color: #1a7f37; border-color: #1a7f37; background: #dafbe1; }
    .badge.disabled { color: #9a6700; border-color: #9a6700; background: #fff3cd; }
    .expand-icon { color: #888; font-size: 0.85rem; }
    .del-btn {
      padding: 0.2rem 0.55rem;
      border: 1px solid #c00;
      border-radius: 4px;
      background: transparent;
      color: #c00;
      cursor: pointer;
      font-size: 0.8rem;
    }
    .del-btn:hover { background: #c00; color: #fff; }

    .user-body {
      padding: 0.75rem 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      border-top: 1px solid #eee;
    }
    .field-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .field-label { min-width: 130px; color: #555; font-size: 0.9rem; }
    .field-row input[type="text"],
    .field-row input[type="password"],
    .field-row input[type="number"] {
      padding: 0.3rem 0.5rem;
      border: 1px solid #bbb;
      border-radius: 4px;
      font-size: 0.9rem;
    }
    .field-row input[type="number"] { width: 80px; }
    .services-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      margin-top: 0.25rem;
    }
    .svc-chip {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.2rem 0.6rem;
      border: 1px solid #bbb;
      border-radius: 12px;
      font-size: 0.82rem;
      cursor: pointer;
      background: #fff;
      transition: background 0.12s;
    }
    .svc-chip.on  { background: #dbeafe; border-color: #3b82f6; color: #1d4ed8; }
    .user-msg { font-size: 0.82rem; color: #1a7f37; min-height: 1.2em; }
    .user-err { font-size: 0.82rem; color: #c00;    min-height: 1.2em; }

    /* ---- add-user form ---- */
    .add-form {
      border: 1px solid #ddd;
      border-radius: 6px;
      padding: 0.75rem 1rem;
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: flex-end;
      background: #fafafa;
      margin-bottom: 0.75rem;
    }
    .add-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: #555; }
    .add-form input {
      padding: 0.35rem 0.5rem;
      border: 1px solid #bbb;
      border-radius: 4px;
      font-size: 0.9rem;
      width: 160px;
    }
    .add-form .err { flex-basis: 100%; color: #c00; font-size: 0.82rem; min-height: 1em; }
    .add-btn { padding: 0.35rem 0.9rem; border-radius: 4px; cursor: pointer; font-size: 0.9rem; }
    .add-btn.primary { background: #0057b8; color: #fff; border: none; }
    .add-btn.primary:hover { background: #004494; }
    .add-btn.secondary { background: #fff; border: 1px solid #bbb; }
    .add-btn.secondary:hover { background: #f0f0f0; }
    .add-open-btn {
      margin-bottom: 0.75rem;
      padding: 0.35rem 0.9rem;
      border: 1px dashed #aaa;
      border-radius: 5px;
      background: transparent;
      cursor: pointer;
      color: #555;
      font-size: 0.9rem;
    }
    .add-open-btn:hover { background: #f0f0f0; }

    /* ---- set-button ---- */
    .set-btn {
      padding: 0.28rem 0.7rem;
      border: 1px solid #0057b8;
      border-radius: 4px;
      background: #0057b8;
      color: #fff;
      cursor: pointer;
      font-size: 0.82rem;
    }
    .set-btn:hover { background: #004494; }

    /* ---- toggle ---- */
    .toggle-btn {
      padding: 0.28rem 0.7rem;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.82rem;
      border: 1px solid #bbb;
    }
    .toggle-btn.on  { background: #dafbe1; border-color: #1a7f37; color: #1a7f37; }
    .toggle-btn.off { background: #fff3cd; border-color: #9a6700; color: #9a6700; }

    /* ---- services tab ---- */
    .svc-list { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1.5rem; }
    .svc-row  {
      border: 1px solid #ddd;
      border-radius: 6px;
      overflow: hidden;
    }
    .svc-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.5rem 0.75rem;
      background: #f8f8f8;
    }
    .svc-name      { font-weight: 600; flex: 1; }
    .svc-cred-btn  {
      padding: 0.25rem 0.6rem;
      border: 1px solid #bbb;
      border-radius: 4px;
      background: #fff;
      cursor: pointer;
      font-size: 0.82rem;
      color: #555;
    }
    .svc-cred-btn:hover { background: #f0f0f0; }
    .svc-cred-form {
      padding: 0.75rem 1rem;
      border-top: 1px solid #eee;
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: flex-end;
      background: #fafafa;
    }
    .svc-cred-form label {
      display: flex; flex-direction: column; gap: 0.2rem;
      font-size: 0.82rem; color: #555;
    }
    .svc-cred-form input {
      padding: 0.3rem 0.5rem;
      border: 1px solid #bbb;
      border-radius: 4px;
      font-size: 0.88rem;
      width: 160px;
    }
    .svc-msg { font-size: 0.8rem; color: #1a7f37; min-height: 1em; flex-basis: 100%; }
    .svc-err { font-size: 0.8rem; color: #c00;    min-height: 1em; flex-basis: 100%; }

    /* ---- user × service matrix ---- */
    .matrix-wrap { overflow-x: auto; }
    .matrix {
      border-collapse: collapse;
      font-size: 0.85rem;
      min-width: 100%;
    }
    .matrix th, .matrix td {
      border: 1px solid #ddd;
      padding: 0.3rem 0.6rem;
      text-align: center;
      white-space: nowrap;
    }
    .matrix th { background: #f4f4f4; font-weight: 600; }
    .matrix td.user-col { text-align: left; font-weight: 500; }
    .matrix .ok   { color: #1a7f37; }
    .matrix .no   { color: #bbb; }
    .matrix .glob-off { color: #999; font-style: italic; }

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
      border: none; border-radius: 5px;
      background: #0057b8; color: #fff;
      cursor: pointer; font-size: 0.95rem;
    }
    .btn-secondary {
      padding: 0.4rem 1rem;
      border: 1px solid #bbb; border-radius: 5px;
      background: #fff; cursor: pointer; font-size: 0.95rem;
    }
  `;

  // ---- tab ----
  @state() private _tab: AdminTab = "users";

  // ---- services tab state ----
  @state() private _services:    ServiceInfo[] = [];
  @state() private _credOpen:    Set<string>   = new Set();
  @state() private _credDraft:   Record<string, Record<string, string>> = {};
  @state() private _svcMsg:      Record<string, string> = {};
  @state() private _svcErr:      Record<string, string> = {};

  // ---- users tab state ----
  @state() private _users:      UserInfo[] = [];
  @state() private _loading     = false;
  @state() private _expanded    = new Set<string>();
  @state() private _showAdd     = false;
  @state() private _addUsername = "";
  @state() private _addPassword = "";
  @state() private _addError    = "";
  // Per-user draft state for fields with an explicit Set button.
  @state() private _pwDraft:    Record<string, string> = {};
  @state() private _quotaDraft: Record<string, string> = {};
  @state() private _userMsg:    Record<string, string> = {};
  @state() private _userErr:    Record<string, string> = {};

  // ---- re-auth ----
  @state() private _reauthVisible = false;
  @state() private _reauthPw      = "";
  @state() private _reauthError   = "";
  private _reauthPending: (() => void) | null = null;
  private _lastReauth = 0;

  // ---- lifecycle ----

  override connectedCallback(): void {
    super.connectedCallback();
    void this._fetchUsers();
    void this._fetchServices();
  }

  // ---- re-auth API (called by action handlers) ----

  requireReauth(fn: () => void): void {
    if (Date.now() - this._lastReauth < REAUTH_TTL_MS) { fn(); return; }
    this._reauthPending = fn;
    this._reauthPw      = "";
    this._reauthError   = "";
    this._reauthVisible = true;
  }

  private async _submitReauth(): Promise<void> {
    this._reauthError = "";
    try {
      const r = await fetch("/api/session/reauth", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({ password: this._reauthPw }),
      });
      if (!r.ok) { this._reauthError = t("admin.wrong-password"); this._reauthPw = ""; return; }
    } catch { this._reauthError = t("admin.wrong-password"); return; }
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

  // ---- services data helpers ----

  private async _fetchServices(): Promise<void> {
    try {
      const r = await fetch("/api/admin/services");
      if (r.ok) {
        this._services = await r.json() as ServiceInfo[];
        // Seed credential drafts from stored values.
        const drafts: Record<string, Record<string, string>> = {};
        for (const s of this._services) drafts[s.id] = { ...s.credentials };
        this._credDraft = drafts;
      }
    } catch { /* ignore */ }
  }

  private async _patchService(id: string, patch: Record<string, unknown>): Promise<void> {
    const r = await fetch(`/api/admin/services/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify(patch),
    });
    const data = await r.json() as { ok?: boolean; service?: ServiceInfo };
    if (r.ok && data.service) {
      this._services = this._services.map((s) => s.id === id ? data.service! : s);
      this._svcMsg = { ...this._svcMsg, [id]: t("admin.services.saved") };
      this._svcErr = { ...this._svcErr, [id]: "" };
    } else {
      this._svcErr = { ...this._svcErr, [id]: t("admin.services.err-failed") };
      this._svcMsg = { ...this._svcMsg, [id]: "" };
    }
  }

  // ---- users data helpers ----

  private async _fetchUsers(): Promise<void> {
    this._loading = true;
    try {
      const r = await fetch("/api/admin/users");
      if (r.ok) this._users = await r.json() as UserInfo[];
    } catch { /* ignore */ }
    this._loading = false;
  }

  private _setMsg(username: string, msg: string, isErr = false): void {
    if (isErr) {
      this._userErr = { ...this._userErr, [username]: msg };
      this._userMsg = { ...this._userMsg, [username]: "" };
    } else {
      this._userMsg = { ...this._userMsg, [username]: msg };
      this._userErr = { ...this._userErr, [username]: "" };
    }
  }

  // ---- user CRUD ----

  private async _createUser(): Promise<void> {
    this._addError = "";
    const r = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify({ username: this._addUsername, password: this._addPassword }),
    });
    const data = await r.json() as { ok?: boolean; error?: string; user?: UserInfo };
    if (!r.ok) {
      this._addError = t(data.error === "already-exists"
        ? "admin.users.err-exists" : "admin.users.err-invalid");
      return;
    }
    if (data.user) this._users = [...this._users, data.user];
    this._addUsername = "";
    this._addPassword = "";
    this._showAdd     = false;
  }

  private _deleteUser(username: string): void {
    this.requireReauth(async () => {
      const r = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, {
        method: "DELETE",
        headers: { ...getCsrfHeaders() },
      });
      if (r.ok) {
        this._users = this._users.filter((u) => u.username !== username);
        const exp = new Set(this._expanded);
        exp.delete(username);
        this._expanded = exp;
      } else {
        this._setMsg(username, t("admin.users.err-failed"), true);
      }
    });
  }

  private async _patchUser(username: string, patch: Record<string, unknown>): Promise<void> {
    const r = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify(patch),
    });
    const data = await r.json() as { ok?: boolean; user?: UserInfo };
    if (r.ok && data.user) {
      this._users = this._users.map((u) => u.username === username ? data.user! : u);
      this._setMsg(username, t("admin.users.saved"));
    } else {
      this._setMsg(username, t("admin.users.err-failed"), true);
    }
  }

  private _toggleService(user: UserInfo, id: string): void {
    const next = user.services.includes(id)
      ? user.services.filter((s) => s !== id)
      : [...user.services, id];
    void this._patchUser(user.username, { services: next });
  }

  // ---- rendering ----

  private _renderUserRow(user: UserInfo) {
    const open = this._expanded.has(user.username);
    const pw   = this._pwDraft[user.username]    ?? "";
    const quota = this._quotaDraft[user.username] ?? String(user.quota_mb);

    return html`
      <div class="user-row">
        <!-- header row (always visible) -->
        <div class="user-header"
             @click=${() => {
               const s = new Set(this._expanded);
               if (open) s.delete(user.username); else s.add(user.username);
               this._expanded = s;
             }}>
          <span class="username">${user.username}</span>
          <span class="badge ${user.disabled ? "disabled" : "active"}">
            ${user.disabled ? t("admin.users.disabled") : t("admin.users.active")}
          </span>
          <span class="expand-icon">${open ? "▲" : "▼"}</span>
          <button class="del-btn"
                  title=${t("admin.users.delete")}
                  @click=${(e: Event) => { e.stopPropagation(); this._deleteUser(user.username); }}>
            ✕
          </button>
        </div>

        <!-- collapsible body -->
        ${open ? html`
          <div class="user-body">

            <!-- enable / disable -->
            <div class="field-row">
              <span class="field-label">${t("admin.users.status")}</span>
              <button class="toggle-btn ${user.disabled ? "off" : "on"}"
                      @click=${() => void this._patchUser(user.username, { disabled: !user.disabled })}>
                ${user.disabled ? t("admin.users.enable") : t("admin.users.disable")}
              </button>
            </div>

            <!-- password -->
            <div class="field-row">
              <span class="field-label">${t("admin.users.new-password")}</span>
              <input type="password" .value=${live(pw)} placeholder="••••••"
                     @input=${(e: Event) => {
                       this._pwDraft = { ...this._pwDraft,
                         [user.username]: (e.target as HTMLInputElement).value };
                     }} />
              <button class="set-btn"
                      @click=${() => {
                        if (pw) void this._patchUser(user.username, { password: pw })
                          .then(() => { this._pwDraft = { ...this._pwDraft, [user.username]: "" }; });
                      }}>
                ${t("admin.users.set")}
              </button>
            </div>

            <!-- quota -->
            <div class="field-row">
              <span class="field-label">${t("admin.users.quota")}</span>
              <input type="number" min="0" step="128"
                     .value=${live(quota)}
                     @input=${(e: Event) => {
                       this._quotaDraft = { ...this._quotaDraft,
                         [user.username]: (e.target as HTMLInputElement).value };
                     }} />
              <button class="set-btn"
                      @click=${() => {
                        const mb = parseInt(quota, 10);
                        if (!isNaN(mb)) void this._patchUser(user.username, { quota_mb: mb });
                      }}>
                ${t("admin.users.set")}
              </button>
            </div>

            <!-- allowed services -->
            <div class="field-row" style="align-items:flex-start">
              <span class="field-label">${t("admin.users.allowed-services")}</span>
              <div class="services-grid">
                ${SERVICES.map((svc) => {
                  const on = user.services.includes(svc.id);
                  return html`
                    <span class="svc-chip ${on ? "on" : ""}"
                          @click=${() => this._toggleService(user, svc.id)}>
                      ${on ? "✓" : "○"} ${t(svc.i18nKey)}
                    </span>`;
                })}
              </div>
            </div>

            <!-- bluetooth / wifi -->
            <div class="field-row">
              <span class="field-label">${t("admin.users.bluetooth")}</span>
              <button class="toggle-btn ${user.bluetooth ? "on" : "off"}"
                      @click=${() => void this._patchUser(user.username, { bluetooth: !user.bluetooth })}>
                ${user.bluetooth ? "✓" : "✗"}
              </button>
              <span class="field-label" style="margin-left:1rem">${t("admin.users.wifi")}</span>
              <button class="toggle-btn ${user.wifi ? "on" : "off"}"
                      @click=${() => void this._patchUser(user.username, { wifi: !user.wifi })}>
                ${user.wifi ? "✓" : "✗"}
              </button>
            </div>

            <!-- per-user status / error line -->
            ${this._userErr[user.username]
              ? html`<div class="user-err">${this._userErr[user.username]}</div>`
              : this._userMsg[user.username]
                ? html`<div class="user-msg">${this._userMsg[user.username]}</div>`
                : nothing}

          </div>
        ` : nothing}
      </div>`;
  }

  private _renderUsers() {
    return html`
      <!-- add-user toggle -->
      ${this._showAdd ? html`
        <div class="add-form">
          <label>
            ${t("admin.users.username")}
            <input type="text" .value=${live(this._addUsername)}
                   @input=${(e: Event) => { this._addUsername = (e.target as HTMLInputElement).value; }}
                   @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void this._createUser(); }} />
          </label>
          <label>
            ${t("admin.users.password")}
            <input type="password" .value=${live(this._addPassword)}
                   @input=${(e: Event) => { this._addPassword = (e.target as HTMLInputElement).value; }}
                   @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void this._createUser(); }} />
          </label>
          <button class="add-btn primary" @click=${() => void this._createUser()}>
            ${t("admin.users.create")}
          </button>
          <button class="add-btn secondary"
                  @click=${() => { this._showAdd = false; this._addError = ""; }}>
            ${t("admin.reauth.cancel")}
          </button>
          ${this._addError ? html`<span class="err">${this._addError}</span>` : nothing}
        </div>
      ` : html`
        <button class="add-open-btn" @click=${() => { this._showAdd = true; }}>
          + ${t("admin.users.add-user")}
        </button>
      `}

      <!-- user list -->
      ${this._loading
        ? html`<p class="stub">${t("admin.stub")}</p>`
        : html`<div class="user-list">
            ${this._users.map((u) => this._renderUserRow(u))}
          </div>`}
    `;
  }

  private _renderServices() {
    const globDisabled = this._services.filter((s) => !s.global_enabled).map((s) => s.id);

    return html`
      <!-- per-service rows -->
      <div class="svc-list">
        ${this._services.map((svc) => {
          const credOpen  = this._credOpen.has(svc.id);
          const draft     = this._credDraft[svc.id] ?? {};
          const hasCreds  = svc.cred_fields.length > 0;

          return html`
            <div class="svc-row">
              <div class="svc-header">
                <span class="svc-name">${t(`service.${svc.id}`)}</span>
                <button class="toggle-btn ${svc.global_enabled ? "on" : "off"}"
                        @click=${() => void this._patchService(svc.id, { global_enabled: !svc.global_enabled })}>
                  ${svc.global_enabled ? t("admin.services.enabled") : t("admin.services.disabled")}
                </button>
                ${hasCreds ? html`
                  <button class="svc-cred-btn"
                          @click=${() => {
                            const s = new Set(this._credOpen);
                            if (credOpen) s.delete(svc.id); else s.add(svc.id);
                            this._credOpen = s;
                          }}>
                    ${t("admin.services.credentials")} ${credOpen ? "▲" : "▼"}
                  </button>
                ` : nothing}
              </div>

              ${(hasCreds && credOpen) ? html`
                <div class="svc-cred-form">
                  ${svc.cred_fields.map((field) => html`
                    <label>
                      ${t(`admin.services.cred.${field}`)}
                      <input type=${field === "password" ? "password" : "text"}
                             .value=${live(draft[field] ?? "")}
                             @input=${(e: Event) => {
                               this._credDraft = {
                                 ...this._credDraft,
                                 [svc.id]: { ...draft, [field]: (e.target as HTMLInputElement).value },
                               };
                             }} />
                    </label>
                  `)}
                  <button class="set-btn"
                          @click=${() => void this._patchService(svc.id, { credentials: this._credDraft[svc.id] ?? {} })}>
                    ${t("admin.users.set")}
                  </button>
                  ${this._svcErr[svc.id]
                    ? html`<span class="svc-err">${this._svcErr[svc.id]}</span>`
                    : this._svcMsg[svc.id]
                      ? html`<span class="svc-msg">${this._svcMsg[svc.id]}</span>`
                      : nothing}
                </div>
              ` : nothing}
            </div>`;
        })}
      </div>

      <!-- user × service access matrix -->
      ${this._users.length > 0 ? html`
        <h3 style="margin:0 0 0.5rem;font-size:0.95rem;color:#555">
          ${t("admin.services.matrix-title")}
        </h3>
        <div class="matrix-wrap">
          <table class="matrix">
            <thead>
              <tr>
                <th></th>
                ${this._services.map((s) => html`<th>${t(`service.${s.id}`)}</th>`)}
              </tr>
            </thead>
            <tbody>
              ${this._users.map((u) => html`
                <tr>
                  <td class="user-col">${u.username}</td>
                  ${this._services.map((s) => {
                    const userHas = u.services.includes(s.id);
                    const globOff = globDisabled.includes(s.id);
                    return html`<td class="${globOff ? "glob-off" : userHas ? "ok" : "no"}">
                      ${globOff ? "—" : userHas ? "✓" : "✗"}
                    </td>`;
                  })}
                </tr>`)}
            </tbody>
          </table>
        </div>
      ` : nothing}
    `;
  }
  private _renderNetwork()  { return html`<p class="stub">${t("admin.stub")}</p>`; }
  private _renderDevice()   { return html`<p class="stub">${t("admin.stub")}</p>`; }

  override render() {
    return html`
      <nav class="tabs">
        ${(["users", "services", "network", "device"] as AdminTab[]).map((tab) => html`
          <button class="tab-btn ${this._tab === tab ? "active" : ""}"
                  @click=${() => { this._tab = tab; }}>
            ${t(`admin.tab.${tab}`)}
          </button>
        `)}
      </nav>

      ${this._tab === "users"    ? this._renderUsers()    : nothing}
      ${this._tab === "services" ? this._renderServices() : nothing}
      ${this._tab === "network"  ? this._renderNetwork()  : nothing}
      ${this._tab === "device"   ? this._renderDevice()   : nothing}

      <!-- re-auth modal -->
      ${this._reauthVisible ? html`
        <div class="modal-backdrop"
             @click=${(e: Event) => { if (e.target === e.currentTarget) this._cancelReauth(); }}>
          <div class="modal">
            <h2>${t("admin.reauth.title")}</h2>
            <p>${t("admin.reauth.reason")}</p>
            <input type="password" .value=${this._reauthPw}
                   placeholder=${t("admin.enter-password")}
                   @input=${(e: Event) => { this._reauthPw = (e.target as HTMLInputElement).value; }}
                   @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void this._submitReauth(); }} />
            <div class="err">${this._reauthError}</div>
            <div class="actions">
              <button class="btn-secondary" @click=${this._cancelReauth}>
                ${t("admin.reauth.cancel")}
              </button>
              <button class="btn-primary" @click=${() => void this._submitReauth()}>
                ${t("admin.reauth.confirm")}
              </button>
            </div>
          </div>
        </div>
      ` : nothing}
    `;
  }
}
