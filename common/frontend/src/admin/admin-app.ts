import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import xtermCss from "@xterm/xterm/css/xterm.css?inline";
import { css, html, nothing, unsafeCSS } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { getCsrfHeaders } from "../csrf.js";
import { t } from "../i18n/i18n.js";
import { PlayerBase } from "../player-base.js";
import { SERVICES } from "../services-list.js";

type AdminTab = "users" | "services" | "network" | "device" | "audit" | "terminal";

const REAUTH_TTL_MS = 60_000;

interface NetworkPolicy {
  wifi_connect_allowed: boolean;
  wifi_add_allowed:     boolean;
}

interface WifiNetwork {
  ssid:        string;
  security:    string;
  system_wide: boolean;
}

interface ServiceInfo {
  id:             string;
  global_enabled: boolean;
  credentials:    Record<string, string>;
  cred_fields:    string[];
}

interface AuditEntry {
  timestamp: number;
  actor:     string;
  action:    string;
  detail:    string;
}

interface LockState {
  locked:       boolean;
  locked_until: number | null;
  active:       boolean;
}

interface UserInfo {
  username:        string;
  disabled:        boolean;
  quota_mb:        number;
  services:        string[];
  bluetooth:       boolean;
  wifi:            boolean;
  wifi_add:        boolean;
  schedule_start:  number | null;
  schedule_end:    number | null;
  daily_limit_min: number | null;
  explicit_filter: boolean;
}

/**
 * Admin interface shell.
 * Tab bar with four sections; Users tab is fully implemented (A3).
 * Re-auth modal gates destructive actions with a 60-second token.
 */
@customElement("admin-app")
export class AdminApp extends PlayerBase {
  static override styles = [unsafeCSS(xtermCss), css`
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

    /* ---- network tab ---- */
    .policy-grid {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 0.5rem 1rem;
      max-width: 480px;
      margin-bottom: 1.5rem;
    }
    .policy-label { font-size: 0.92rem; }
    .policy-note  { font-size: 0.78rem; color: #888; grid-column: 1; margin-top: -0.4rem; }

    .net-list  { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 0.75rem; }
    .net-row   {
      display: flex; align-items: center; gap: 0.6rem;
      padding: 0.4rem 0.75rem;
      border: 1px solid #ddd; border-radius: 5px; background: #fafafa;
    }
    .net-ssid  { font-weight: 600; flex: 1; }
    .net-sec   { font-size: 0.8rem; color: #666; }
    .net-scope { font-size: 0.78rem; color: #888; }
    .net-del   {
      padding: 0.18rem 0.5rem;
      border: 1px solid #c00; border-radius: 4px;
      background: transparent; color: #c00;
      cursor: pointer; font-size: 0.78rem;
    }
    .net-del:hover { background: #c00; color: #fff; }

    .add-net-form {
      display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: flex-end;
      padding: 0.65rem 0.75rem;
      border: 1px dashed #aaa; border-radius: 5px; background: #fafafa;
      margin-bottom: 0.5rem;
    }
    .add-net-form label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.82rem; color: #555; }
    .add-net-form input, .add-net-form select {
      padding: 0.3rem 0.5rem;
      border: 1px solid #bbb; border-radius: 4px; font-size: 0.88rem;
    }
    .add-net-form input { width: 180px; }
    .add-net-form .err  { flex-basis: 100%; color: #c00; font-size: 0.82rem; min-height: 1em; }

    /* ---- device tab ---- */
    .dev-section { margin-bottom: 1.5rem; }
    .dev-section h3 { margin: 0 0 0.6rem; font-size: 0.95rem; color: #555; }
    .dev-info {
      font-size: 0.88rem; color: #555;
      border: 1px solid #ddd; border-radius: 5px;
      padding: 0.6rem 0.9rem; background: #fafafa;
      margin-bottom: 0.5rem;
    }
    .dev-info dt { font-weight: 600; display: inline; }
    .dev-info dd { display: inline; margin: 0 0 0 0.25rem; }
    .dev-info p  { margin: 0.15rem 0; }
    .dev-actions { display: flex; flex-direction: column; gap: 0.4rem; max-width: 320px; }
    .dev-action-row {
      display: flex; align-items: center; gap: 0.75rem;
    }
    .dev-action-btn {
      padding: 0.32rem 0.9rem;
      border: 1px solid #bbb; border-radius: 4px;
      background: #fff; cursor: not-allowed;
      font-size: 0.88rem; color: #aaa;
      min-width: 160px; text-align: left;
    }
    .dev-action-note { font-size: 0.78rem; color: #aaa; font-style: italic; }
    .dev-msg { font-size: 0.82rem; color: #1a7f37; min-height: 1em; }
    .phrase-box {
      font-family: monospace; font-size: 1rem; letter-spacing: 0.03em;
      background: #f0f4ff; border: 1px solid #99b; border-radius: 6px;
      padding: 0.6rem 0.9rem; line-height: 1.7; max-width: 480px;
      word-break: break-word; user-select: all;
    }
    .lock-status {
      display: inline-flex; align-items: center; gap: 0.5rem;
      padding: 0.3rem 0.75rem;
      border-radius: 4px; font-size: 0.88rem;
      margin-bottom: 0.75rem;
    }
    .lock-status.active   { background: #fff3cd; border: 1px solid #9a6700; color: #7a5300; }
    .lock-status.inactive { background: #dafbe1; border: 1px solid #1a7f37; color: #1a5229; }
    .lock-mode-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
    .lock-mode-row label  { font-size: 0.88rem; display: flex; align-items: center; gap: 0.3rem; cursor: pointer; }
    .lock-mode-row input[type="number"],
    .lock-mode-row input[type="datetime-local"] {
      padding: 0.28rem 0.5rem; border: 1px solid #bbb; border-radius: 4px; font-size: 0.88rem;
    }
    .lock-mode-row input[type="number"]        { width: 70px; }
    .lock-mode-row input[type="datetime-local"] { width: 210px; }

    /* ---- audit tab ---- */
    .audit-toolbar { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; }
    .audit-toolbar h3 { margin: 0; font-size: 0.95rem; color: #555; flex: 1; }
    .audit-table {
      width: 100%; border-collapse: collapse; font-size: 0.85rem;
    }
    .audit-table th, .audit-table td {
      border: 1px solid #ddd; padding: 0.3rem 0.6rem;
      text-align: left; white-space: nowrap;
    }
    .audit-table th { background: #f4f4f4; font-weight: 600; }
    .audit-table td.detail-col { white-space: normal; color: #666; }
    .audit-table tr:nth-child(even) { background: #fafafa; }

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

    /* ---- terminal tab ---- */
    .term-info { font-size: 0.88rem; color: #555; margin-bottom: 1rem; }
    .term-meta  { font-size: 0.78rem; color: #888; margin-bottom: 0.75rem; }
    #terminal-container {
      height: 420px;
      background: #000;
      border-radius: 5px;
      overflow: hidden;
    }

    /* ---- backup section ---- */
    .backup-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      margin-bottom: 0.5rem;
    }
    @media (max-width: 600px) { .backup-grid { grid-template-columns: 1fr; } }
    .backup-card {
      border: 1px solid #ddd; border-radius: 6px;
      padding: 0.75rem 1rem; background: #fafafa;
      display: flex; flex-direction: column; gap: 0.5rem;
    }
    .backup-card h4 { margin: 0; font-size: 0.9rem; color: #444; }
    .backup-card input[type="password"] {
      padding: 0.3rem 0.5rem; border: 1px solid #bbb;
      border-radius: 4px; font-size: 0.9rem; width: 100%; box-sizing: border-box;
    }
    .entropy-bar {
      height: 5px; border-radius: 3px; background: #eee;
      overflow: hidden; margin-top: -0.2rem;
    }
    .entropy-fill { height: 100%; transition: width 0.2s, background 0.2s; border-radius: 3px; }
    .entropy-weak   { background: #e53e3e; }
    .entropy-fair   { background: #ed8936; }
    .entropy-good   { background: #ecc94b; }
    .entropy-strong { background: #48bb78; }
    .entropy-label  { font-size: 0.75rem; color: #888; }
    .backup-note  { font-size: 0.78rem; color: #888; }
    .backup-msg   { font-size: 0.82rem; color: #1a7f37; min-height: 1em; }
    .backup-err   { font-size: 0.82rem; color: #c00;    min-height: 1em; }
    .file-input-wrap { position: relative; }
    .file-input-wrap input[type="file"] { font-size: 0.82rem; }
  `];

  // ---- tab ----
  @state() private _tab: AdminTab = "users";

  // ---- device tab state ----
  @state() private _devConfig:      { default_quota_mb: number } | null = null;
  @state() private _devQuotaDraft   = "";
  @state() private _devMsg          = "";
  @state() private _lockState:      LockState | null = null;
  @state() private _lockMode:       "indefinite" | "duration" | "until" = "indefinite";
  @state() private _lockMinutes     = "60";
  @state() private _lockUntil       = "";

  // ---- update section state (in device tab) ----
  @state() private _updatePhase: "idle" | "checking" | "ready" | "available" | "installing" | "done" | "error" = "idle";
  @state() private _updateCurrent   = "";
  @state() private _updateLatest    = "";
  @state() private _updateChangelog = "";
  @state() private _updateMsg       = "";

  // ---- backup section state (in device tab) ----
  @state() private _exportPw   = "";
  @state() private _importPw   = "";
  @state() private _backupMsg  = "";
  @state() private _backupErr  = "";
  private _importFile: File | undefined = undefined;

  // ---- recovery phrase state (in device tab) ----
  @state() private _phraseStatus: "unknown" | "set" | "unset" | "revealed" = "unknown";
  @state() private _phraseWords  = "";   // shown once after generation, then cleared
  @state() private _phraseMsg    = "";

  // ---- fsck / reinstall state (in device tab) ----
  @state() private _fsckPhase:      "idle" | "running" | "done" | "error" = "idle";
  @state() private _fsckMsg         = "";
  @state() private _reinstallPhase: "idle" | "running" | "done" | "error" = "idle";
  @state() private _reinstallMsg    = "";

  // ---- audit tab state ----
  @state() private _auditEntries:  AuditEntry[] = [];
  @state() private _auditLoading  = false;

  // ---- terminal tab state ----
  @state() private _termActive = false;
  @state() private _termMsg    = "";
  @query("#terminal-container")
  private _termContainer!: HTMLElement;
  private _xterm:        Terminal | undefined       = undefined;
  private _termWs:       WebSocket | undefined      = undefined;
  private _termFitAddon: FitAddon | undefined       = undefined;

  // ---- network tab state ----
  @state() private _netPolicy:  NetworkPolicy | null = null;
  @state() private _netList:    WifiNetwork[]        = [];
  @state() private _netShowAdd  = false;
  @state() private _netSsid     = "";
  @state() private _netSecurity = "WPA2";
  @state() private _netScope    = true;
  @state() private _netAddErr   = "";

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
  @state() private _pwDraft:       Record<string, string> = {};
  @state() private _quotaDraft:    Record<string, string> = {};
  @state() private _schedStartDraft: Record<string, string> = {};
  @state() private _schedEndDraft:   Record<string, string> = {};
  @state() private _limitDraft:    Record<string, string> = {};
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
    void this._fetchNetwork();
    void this._fetchDeviceConfig();
    void this._fetchLockState();
    void this._fetchAudit();
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

  // ---- device data helpers ----

  private async _fetchDeviceConfig(): Promise<void> {
    try {
      const r = await fetch("/api/admin/device");
      if (r.ok) {
        this._devConfig      = await r.json() as { default_quota_mb: number };
        this._devQuotaDraft  = String(this._devConfig.default_quota_mb);
      }
    } catch { /* ignore */ }
  }

  private async _fetchLockState(): Promise<void> {
    try {
      const r = await fetch("/api/admin/lock");
      if (r.ok) this._lockState = await r.json() as LockState;
    } catch { /* ignore */ }
  }

  private async _checkUpdate(): Promise<void> {
    this._updatePhase = "checking";
    this._updateMsg   = "";
    try {
      const r = await fetch("/api/admin/update/check");
      if (!r.ok) { this._updatePhase = "error"; this._updateMsg = t("admin.update.error"); return; }
      const d = await r.json() as {
        current: string; latest: string; up_to_date: boolean; changelog_url: string;
      };
      this._updateCurrent   = d.current;
      this._updateLatest    = d.latest;
      this._updateChangelog = d.changelog_url;
      this._updatePhase     = d.up_to_date ? "ready" : "available";
    } catch {
      this._updatePhase = "error";
      this._updateMsg   = t("admin.update.error");
    }
  }

  private async _installUpdate(): Promise<void> {
    this._updatePhase = "installing";
    this._updateMsg   = "";
    try {
      const r = await fetch("/api/admin/update/start", {
        method: "POST",
        headers: getCsrfHeaders(),
      });
      const d = await r.json() as { ok?: boolean; version?: string; error?: string };
      if (r.ok && d.ok) {
        this._updatePhase = "done";
        this._updateMsg   = t("admin.update.success").replace("{v}", d.version ?? "");
      } else {
        this._updatePhase = "error";
        this._updateMsg   = d.error ?? t("admin.update.error");
      }
    } catch {
      this._updatePhase = "error";
      this._updateMsg   = t("admin.update.error");
    }
  }

  // ---- recovery phrase ---------------------------------------------------------

  private async _checkPhraseStatus(): Promise<void> {
    try {
      const r = await fetch("/api/admin/device/recovery-phrase");
      if (r.ok) {
        const d = await r.json() as { set: boolean };
        this._phraseStatus = d.set ? "set" : "unset";
      }
    } catch { /* ignore — status stays unknown */ }
  }

  private async _generatePhrase(): Promise<void> {
    this._phraseMsg = "";
    try {
      const r = await fetch("/api/admin/device/recovery-phrase", {
        method: "POST",
        headers: getCsrfHeaders(),
      });
      const d = await r.json() as { phrase?: string; error?: string };
      if (r.ok && d.phrase) {
        this._phraseWords  = d.phrase;
        this._phraseStatus = "revealed";
      } else {
        this._phraseMsg = d.error ?? t("admin.phrase.error");
      }
    } catch {
      this._phraseMsg = t("admin.phrase.error");
    }
  }

  // ---- fsck / reinstall --------------------------------------------------------

  private async _runFsck(): Promise<void> {
    this._fsckPhase = "running";
    this._fsckMsg   = "";
    try {
      const r = await fetch("/api/admin/device/fsck", {
        method: "POST",
        headers: getCsrfHeaders(),
      });
      const d = await r.json() as { ok?: boolean; rebooting?: boolean; error?: string };
      if (r.ok && d.ok) {
        this._fsckPhase = "done";
        this._fsckMsg   = d.rebooting ? t("admin.device.fsck-rebooting") : t("admin.device.fsck-done");
      } else {
        this._fsckPhase = "error";
        this._fsckMsg   = d.error === "not-available-in-demo"
          ? t("admin.device.not-in-demo")
          : d.error ?? t("admin.device.fsck-error");
      }
    } catch {
      this._fsckPhase = "error";
      this._fsckMsg   = t("admin.device.fsck-error");
    }
  }

  private async _runReinstall(): Promise<void> {
    this._reinstallPhase = "running";
    this._reinstallMsg   = "";
    try {
      const r = await fetch("/api/admin/device/reinstall", {
        method: "POST",
        headers: getCsrfHeaders(),
      });
      const d = await r.json() as { ok?: boolean; error?: string };
      if (r.ok && d.ok) {
        this._reinstallPhase = "done";
        this._reinstallMsg   = t("admin.device.reinstall-done");
      } else {
        this._reinstallPhase = "error";
        this._reinstallMsg   = d.error === "not-available-in-demo"
          ? t("admin.device.not-in-demo")
          : d.error ?? t("admin.device.reinstall-error");
      }
    } catch {
      this._reinstallPhase = "error";
      this._reinstallMsg   = t("admin.device.reinstall-error");
    }
  }

  private async _fetchAudit(): Promise<void> {
    this._auditLoading = true;
    try {
      const r = await fetch("/api/admin/audit");
      if (r.ok) {
        const d = await r.json() as { entries: AuditEntry[] };
        this._auditEntries = d.entries;
      }
    } catch { /* ignore */ }
    this._auditLoading = false;
  }

  private async _setLock(): Promise<void> {
    const body: Record<string, unknown> = { mode: this._lockMode };
    if (this._lockMode === "duration") body["minutes"] = parseInt(this._lockMinutes, 10) || 60;
    if (this._lockMode === "until")    body["until"]   = new Date(this._lockUntil).getTime() / 1000;
    const r = await fetch("/api/admin/lock", {
      method: "POST",
      headers: { "content-type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const d = await r.json() as { lock: LockState };
      this._lockState = d.lock;
    }
  }

  private async _clearLock(): Promise<void> {
    const r = await fetch("/api/admin/lock", {
      method: "DELETE",
      headers: { ...getCsrfHeaders() },
    });
    if (r.ok) {
      const d = await r.json() as { lock: LockState };
      this._lockState = d.lock;
    }
  }

  private async _saveDefaultQuota(): Promise<void> {
    const mb = parseInt(this._devQuotaDraft, 10);
    if (isNaN(mb) || mb < 0) return;
    const r = await fetch("/api/admin/device", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify({ default_quota_mb: mb }),
    });
    if (r.ok) {
      const d = await r.json() as { config: { default_quota_mb: number } };
      this._devConfig = d.config;
      this._devMsg    = t("admin.device.saved");
      setTimeout(() => { this._devMsg = ""; }, 3000);
    }
  }

  // ---- network data helpers ----

  private async _fetchNetwork(): Promise<void> {
    try {
      const r = await fetch("/api/admin/network");
      if (r.ok) {
        const d = await r.json() as { policy: NetworkPolicy; networks: WifiNetwork[] };
        this._netPolicy = d.policy;
        this._netList   = d.networks;
      }
    } catch { /* ignore */ }
  }

  private async _patchNetPolicy(patch: Partial<NetworkPolicy>): Promise<void> {
    const r = await fetch("/api/admin/network/policy", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify(patch),
    });
    if (r.ok) {
      const d = await r.json() as { policy: NetworkPolicy };
      this._netPolicy = d.policy;
    }
  }

  private async _addNetwork(): Promise<void> {
    this._netAddErr = "";
    const r = await fetch("/api/admin/network/wifi", {
      method: "POST",
      headers: { "content-type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify({
        ssid: this._netSsid, security: this._netSecurity, system_wide: this._netScope,
      }),
    });
    const d = await r.json() as { ok?: boolean; error?: string; network?: WifiNetwork };
    if (!r.ok) {
      this._netAddErr = t(d.error === "already-exists"
        ? "admin.network.err-exists" : "admin.network.err-invalid-ssid");
      return;
    }
    if (d.network) this._netList = [...this._netList, d.network];
    this._netSsid = ""; this._netShowAdd = false;
  }

  private async _deleteNetwork(ssid: string): Promise<void> {
    const r = await fetch(`/api/admin/network/wifi/${encodeURIComponent(ssid)}`, {
      method: "DELETE",
      headers: { ...getCsrfHeaders() },
    });
    if (r.ok) this._netList = this._netList.filter((n) => n.ssid !== ssid);
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

  // ---- backup helpers ----

  /** Estimate passphrase strength as bits of entropy (charset × length). */
  private _entropy(pw: string): number {
    let pool = 0;
    if (/[a-z]/.test(pw)) pool += 26;
    if (/[A-Z]/.test(pw)) pool += 26;
    if (/[0-9]/.test(pw)) pool += 10;
    if (/[^a-zA-Z0-9]/.test(pw)) pool += 32;
    return pw.length > 0 && pool > 0 ? Math.floor(pw.length * Math.log2(pool)) : 0;
  }

  private _entropyLevel(bits: number): "weak" | "fair" | "good" | "strong" {
    if (bits >= 80) return "strong";
    if (bits >= 60) return "good";
    if (bits >= 40) return "fair";
    return "weak";
  }

  private _renderEntropyBar(pw: string) {
    const bits  = this._entropy(pw);
    const level = this._entropyLevel(bits);
    const pct   = Math.min(100, Math.round(bits / 100 * 100));
    return html`
      <div class="entropy-bar">
        <div class="entropy-fill entropy-${level}" style="width:${pct}%"></div>
      </div>
      ${pw.length > 0 ? html`<span class="entropy-label">${t(`admin.backup.strength-${level}`)} (${bits} bits)</span>` : nothing}
    `;
  }

  private async _exportBackup(): Promise<void> {
    this._backupErr = "";
    this._backupMsg = "";
    const r = await fetch("/api/admin/backup/export", {
      method: "POST",
      headers: { "content-type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify({ passphrase: this._exportPw }),
    });
    if (!r.ok) {
      const d = await r.json() as { error?: string };
      this._backupErr = t(d.error === "passphrase-too-short"
        ? "admin.backup.err-short" : "admin.backup.err-export");
      return;
    }
    // Trigger a browser download from the response blob.
    const blob = await r.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = "zik-backup.json";
    a.click();
    URL.revokeObjectURL(url);
    this._backupMsg  = t("admin.backup.exported");
    this._exportPw   = "";
  }

  private async _importBackup(): Promise<void> {
    this._backupErr = "";
    this._backupMsg = "";
    if (!this._importFile) { this._backupErr = t("admin.backup.err-no-file"); return; }
    let blob: unknown;
    try {
      blob = JSON.parse(await this._importFile.text());
    } catch {
      this._backupErr = t("admin.backup.err-parse"); return;
    }
    const r = await fetch("/api/admin/backup/import", {
      method: "POST",
      headers: { "content-type": "application/json", ...getCsrfHeaders() },
      body: JSON.stringify({ passphrase: this._importPw, data: blob }),
    });
    const d = await r.json() as { ok?: boolean; error?: string };
    if (!r.ok) {
      this._backupErr = t(d.error === "decrypt-failed"
        ? "admin.backup.err-decrypt" : "admin.backup.err-restore");
      return;
    }
    this._backupMsg  = t("admin.backup.imported");
    this._importPw   = "";
    this._importFile = undefined;
    // Reload all admin state from backend now that stores are restored.
    void this._fetchUsers();
    void this._fetchServices();
    void this._fetchNetwork();
    void this._fetchDeviceConfig();
    void this._fetchLockState();
  }

  // ---- terminal methods ----

  private async _openTerminal(): Promise<void> {
    this._termMsg    = "";
    this._termActive = true;
    await this.updateComplete;   // wait for #terminal-container to enter the DOM

    const container = this._termContainer;
    if (!container) { this._termActive = false; return; }

    this._xterm = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "monospace",
      theme: { background: "#000000" },
    });
    this._termFitAddon = new FitAddon();
    this._xterm.loadAddon(this._termFitAddon);
    this._xterm.open(container);
    this._termFitAddon.fit();

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    this._termWs = new WebSocket(`${proto}//${window.location.host}/api/ws/admin/terminal`);
    this._termWs.binaryType = "arraybuffer";

    this._termWs.onopen = () => { this._termFitAddon?.fit(); };

    this._termWs.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) {
        this._xterm?.write(new Uint8Array(e.data));
      }
    };

    this._termWs.onclose = () => { this._closeTerminal(); };

    this._xterm.onData((data: string) => {
      if (this._termWs?.readyState === WebSocket.OPEN) {
        this._termWs.send(new TextEncoder().encode(data));
      }
    });

    this._xterm.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (this._termWs?.readyState === WebSocket.OPEN) {
        this._termWs.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    // Keep terminal sized to its container.
    new ResizeObserver(() => this._termFitAddon?.fit()).observe(container);
  }

  private _closeTerminal(): void {
    this._termWs?.close();
    this._termWs      = undefined;
    this._xterm?.dispose();
    this._xterm       = undefined;
    this._termFitAddon = undefined;
    this._termActive   = false;
    this._termMsg      = t("admin.terminal.closed");
  }

  // ---- rendering ----

  private _renderUserRow(user: UserInfo) {
    const open  = this._expanded.has(user.username);
    const pw    = this._pwDraft[user.username]       ?? "";
    const quota = this._quotaDraft[user.username]    ?? String(user.quota_mb);
    const schedStart = this._schedStartDraft[user.username]
      ?? (user.schedule_start !== null ? String(user.schedule_start) : "");
    const schedEnd   = this._schedEndDraft[user.username]
      ?? (user.schedule_end   !== null ? String(user.schedule_end)   : "");
    const limit = this._limitDraft[user.username]
      ?? (user.daily_limit_min !== null ? String(user.daily_limit_min) : "");

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
              <span class="field-label" style="margin-left:1rem">${t("admin.users.wifi-add")}</span>
              <button class="toggle-btn ${user.wifi_add ? "on" : "off"}"
                      @click=${() => void this._patchUser(user.username, { wifi_add: !user.wifi_add })}>
                ${user.wifi_add ? "✓" : "✗"}
              </button>
            </div>

            <!-- parental controls -->
            <div class="field-row">
              <span class="field-label">${t("admin.users.parental.explicit-filter")}</span>
              <button class="toggle-btn ${user.explicit_filter ? "on" : "off"}"
                      @click=${() => void this._patchUser(user.username, { explicit_filter: !user.explicit_filter })}>
                ${user.explicit_filter ? "✓" : "✗"}
              </button>
            </div>
            <div class="field-row">
              <span class="field-label">${t("admin.users.parental.schedule")}</span>
              <input type="number" min="0" max="23" style="width:3.5rem"
                     .value=${live(schedStart)}
                     placeholder="0"
                     @input=${(e: Event) => {
                       this._schedStartDraft = { ...this._schedStartDraft,
                         [user.username]: (e.target as HTMLInputElement).value };
                     }} />
              <span style="margin:0 0.25rem">–</span>
              <input type="number" min="0" max="23" style="width:3.5rem"
                     .value=${live(schedEnd)}
                     placeholder="23"
                     @input=${(e: Event) => {
                       this._schedEndDraft = { ...this._schedEndDraft,
                         [user.username]: (e.target as HTMLInputElement).value };
                     }} />
              <button class="set-btn"
                      @click=${() => {
                        const s = parseInt(schedStart, 10);
                        const e = parseInt(schedEnd,   10);
                        if (!isNaN(s) && !isNaN(e))
                          void this._patchUser(user.username, { schedule_start: s, schedule_end: e });
                      }}>
                ${t("admin.users.set")}
              </button>
              <button class="set-btn"
                      @click=${() => {
                        this._schedStartDraft = { ...this._schedStartDraft, [user.username]: "" };
                        this._schedEndDraft   = { ...this._schedEndDraft,   [user.username]: "" };
                        void this._patchUser(user.username, { schedule_start: null, schedule_end: null });
                      }}>
                ${t("admin.users.parental.clear")}
              </button>
            </div>
            <div class="field-row">
              <span class="field-label">${t("admin.users.parental.daily-limit")}</span>
              <input type="number" min="1" style="width:5rem"
                     .value=${live(limit)}
                     placeholder="—"
                     @input=${(e: Event) => {
                       this._limitDraft = { ...this._limitDraft,
                         [user.username]: (e.target as HTMLInputElement).value };
                     }} />
              <button class="set-btn"
                      @click=${() => {
                        const m = parseInt(limit, 10);
                        if (!isNaN(m) && m > 0)
                          void this._patchUser(user.username, { daily_limit_min: m });
                      }}>
                ${t("admin.users.set")}
              </button>
              <button class="set-btn"
                      @click=${() => {
                        this._limitDraft = { ...this._limitDraft, [user.username]: "" };
                        void this._patchUser(user.username, { daily_limit_min: null });
                      }}>
                ${t("admin.users.parental.clear")}
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
  private _renderNetwork() {
    const p = this._netPolicy;
    if (!p) return html`<p class="stub">${t("admin.stub")}</p>`;

    return html`
      <!-- global Wi-Fi policy -->
      <h3 style="margin:0 0 0.75rem;font-size:0.95rem;color:#555">${t("admin.network.policy-title")}</h3>
      <div class="policy-grid">
        <span class="policy-label">${t("admin.network.wifi-connect")}</span>
        <button class="toggle-btn ${p.wifi_connect_allowed ? "on" : "off"}"
                @click=${() => void this._patchNetPolicy({ wifi_connect_allowed: !p.wifi_connect_allowed })}>
          ${p.wifi_connect_allowed ? t("admin.services.enabled") : t("admin.services.disabled")}
        </button>
        <span class="policy-note">${t("admin.network.wifi-connect-note")}</span>

        <span class="policy-label">${t("admin.network.wifi-add")}</span>
        <button class="toggle-btn ${p.wifi_add_allowed ? "on" : "off"}"
                @click=${() => void this._patchNetPolicy({ wifi_add_allowed: !p.wifi_add_allowed })}>
          ${p.wifi_add_allowed ? t("admin.services.enabled") : t("admin.services.disabled")}
        </button>
        <span class="policy-note">${t("admin.network.wifi-add-note")}</span>
      </div>

      <!-- per-user effective Wi-Fi access matrix -->
      ${this._users.length > 0 ? html`
        <h3 style="margin:0 0 0.5rem;font-size:0.95rem;color:#555">${t("admin.network.user-access")}</h3>
        <div class="matrix-wrap" style="margin-bottom:1.5rem">
          <table class="matrix">
            <thead>
              <tr>
                <th></th>
                <th>${t("admin.network.col-connect")}</th>
                <th>${t("admin.network.col-add")}</th>
              </tr>
            </thead>
            <tbody>
              ${this._users.map((u) => {
                const canConnect = p.wifi_connect_allowed && u.wifi;
                const canAdd     = p.wifi_add_allowed     && u.wifi_add;
                return html`
                  <tr>
                    <td class="user-col">${u.username}</td>
                    <td class="${canConnect ? "ok" : "no"}">${canConnect ? "✓" : "✗"}</td>
                    <td class="${canAdd     ? "ok" : "no"}">${canAdd     ? "✓" : "✗"}</td>
                  </tr>`;
              })}
            </tbody>
          </table>
        </div>
      ` : nothing}

      <!-- system Wi-Fi network list -->
      <h3 style="margin:0 0 0.5rem;font-size:0.95rem;color:#555">${t("admin.network.networks-title")}</h3>
      <div class="net-list">
        ${this._netList.length === 0
          ? html`<p class="stub">${t("admin.network.no-networks")}</p>`
          : this._netList.map((net) => html`
              <div class="net-row">
                <span class="net-ssid">${net.ssid}</span>
                <span class="net-sec">${net.security}</span>
                <span class="net-scope">
                  ${net.system_wide ? t("admin.network.scope-system") : t("admin.network.scope-admin")}
                </span>
                <button class="net-del"
                        @click=${() => void this._deleteNetwork(net.ssid)}>✕</button>
              </div>`)}
      </div>

      <!-- add network form -->
      ${this._netShowAdd ? html`
        <div class="add-net-form">
          <label>
            ${t("admin.network.ssid")}
            <input type="text" .value=${live(this._netSsid)}
                   @input=${(e: Event) => { this._netSsid = (e.target as HTMLInputElement).value; }}
                   @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void this._addNetwork(); }} />
          </label>
          <label>
            ${t("admin.network.security")}
            <select .value=${live(this._netSecurity)}
                    @change=${(e: Event) => { this._netSecurity = (e.target as HTMLSelectElement).value; }}>
              <option>WPA2</option>
              <option>WPA3</option>
              <option>WPA2/WPA3</option>
              <option>Open</option>
            </select>
          </label>
          <label>
            ${t("admin.network.scope")}
            <select @change=${(e: Event) => { this._netScope = (e.target as HTMLSelectElement).value === "system"; }}>
              <option value="system" ?selected=${this._netScope}>${t("admin.network.scope-system")}</option>
              <option value="admin"  ?selected=${!this._netScope}>${t("admin.network.scope-admin")}</option>
            </select>
          </label>
          <button class="add-btn primary" @click=${() => void this._addNetwork()}>
            ${t("admin.users.create")}
          </button>
          <button class="add-btn secondary"
                  @click=${() => { this._netShowAdd = false; this._netAddErr = ""; }}>
            ${t("admin.reauth.cancel")}
          </button>
          ${this._netAddErr ? html`<span class="err">${this._netAddErr}</span>` : nothing}
        </div>
      ` : html`
        <button class="add-open-btn" @click=${() => { this._netShowAdd = true; }}>
          + ${t("admin.network.add-network")}
        </button>
      `}
    `;
  }
  private _renderDevice() {
    return html`
      <!-- device info -->
      <div class="dev-section">
        <h3>${t("admin.device.info-title")}</h3>
        <div class="dev-info">
          <p><dt>${t("admin.device.target")}</dt>
             <dd>${t("admin.device.target-demo")}</dd></p>
          <p><dt>${t("admin.device.note")}</dt>
             <dd>${t("admin.device.note-text")}</dd></p>
        </div>
      </div>

      <!-- default quota -->
      <div class="dev-section">
        <h3>${t("admin.device.default-quota-title")}</h3>
        <div class="field-row">
          <span class="field-label">${t("admin.users.quota")}</span>
          <input type="number" min="0" step="128"
                 .value=${live(this._devQuotaDraft)}
                 @input=${(e: Event) => {
                   this._devQuotaDraft = (e.target as HTMLInputElement).value;
                 }} />
          <button class="set-btn" @click=${() => void this._saveDefaultQuota()}>
            ${t("admin.users.set")}
          </button>
        </div>
        <div class="dev-msg">${this._devMsg}</div>
      </div>

      <!-- device lock -->
      <div class="dev-section">
        <h3>${t("admin.device.lock-title")}</h3>

        <!-- current status badge -->
        <div class="lock-status ${this._lockState?.active ? "active" : "inactive"}">
          ${this._lockState?.active ? t("admin.device.lock-active") : t("admin.device.lock-inactive")}
          ${(this._lockState?.active && this._lockState.locked_until != null) ? html`
            &nbsp;— ${t("admin.device.lock-until")}
            ${new Date(this._lockState.locked_until * 1000).toLocaleString()}
          ` : nothing}
        </div>

        <!-- mode selector + lock button (shown when unlocked) -->
        ${!this._lockState?.active ? html`
          <div class="lock-mode-row">
            <label>
              <input type="radio" name="lock-mode" value="indefinite"
                     ?checked=${this._lockMode === "indefinite"}
                     @change=${() => { this._lockMode = "indefinite"; }} />
              ${t("admin.device.lock-mode-indefinite")}
            </label>
            <label>
              <input type="radio" name="lock-mode" value="duration"
                     ?checked=${this._lockMode === "duration"}
                     @change=${() => { this._lockMode = "duration"; }} />
              ${t("admin.device.lock-mode-duration")}
            </label>
            ${this._lockMode === "duration" ? html`
              <input type="number" min="1"
                     .value=${live(this._lockMinutes)}
                     @input=${(e: Event) => { this._lockMinutes = (e.target as HTMLInputElement).value; }} />
              ${t("admin.device.lock-minutes")}
            ` : nothing}
            <label>
              <input type="radio" name="lock-mode" value="until"
                     ?checked=${this._lockMode === "until"}
                     @change=${() => { this._lockMode = "until"; }} />
              ${t("admin.device.lock-mode-until")}
            </label>
            ${this._lockMode === "until" ? html`
              <input type="datetime-local"
                     .value=${live(this._lockUntil)}
                     @input=${(e: Event) => { this._lockUntil = (e.target as HTMLInputElement).value; }} />
            ` : nothing}
          </div>
          <button class="set-btn" @click=${() => void this._setLock()}>
            ${t("admin.device.lock-btn")}
          </button>
        ` : html`
          <button class="set-btn" style="background:#c00;border-color:#c00"
                  @click=${() => void this._clearLock()}>
            ${t("admin.device.unlock-btn")}
          </button>
        `}
      </div>

      <!-- config backup / restore -->
      <div class="dev-section">
        <h3>${t("admin.backup.title")}</h3>
        <p class="backup-note">${t("admin.backup.note")}</p>

        <div class="backup-grid">
          <!-- export card -->
          <div class="backup-card">
            <h4>${t("admin.backup.export-title")}</h4>
            <input type="password" placeholder=${t("admin.backup.passphrase-placeholder")}
                   .value=${live(this._exportPw)}
                   @input=${(e: Event) => { this._exportPw = (e.target as HTMLInputElement).value; }} />
            ${this._renderEntropyBar(this._exportPw)}
            <button class="set-btn"
                    @click=${() => this.requireReauth(() => void this._exportBackup())}>
              ${t("admin.backup.export-btn")}
            </button>
          </div>

          <!-- import card -->
          <div class="backup-card">
            <h4>${t("admin.backup.import-title")}</h4>
            <div class="file-input-wrap">
              <input type="file" accept=".json"
                     @change=${(e: Event) => {
                       this._importFile = (e.target as HTMLInputElement).files?.[0];
                     }} />
            </div>
            <input type="password" placeholder=${t("admin.backup.passphrase-placeholder")}
                   .value=${live(this._importPw)}
                   @input=${(e: Event) => { this._importPw = (e.target as HTMLInputElement).value; }} />
            <button class="set-btn"
                    @click=${() => this.requireReauth(() => void this._importBackup())}>
              ${t("admin.backup.import-btn")}
            </button>
          </div>
        </div>

        ${this._backupErr ? html`<div class="backup-err">${this._backupErr}</div>` : nothing}
        ${this._backupMsg ? html`<div class="backup-msg">${this._backupMsg}</div>` : nothing}
      </div>

      <!-- app update section -->
      <div class="dev-section">
        <h3>${t("admin.update.title")}</h3>
        <div class="dev-actions">
          <div class="dev-action-row">
            <button class="dev-action-btn"
                    ?disabled=${this._updatePhase === "checking" || this._updatePhase === "installing"}
                    @click=${() => void this._checkUpdate()}>
              ${this._updatePhase === "checking"
                ? t("admin.update.checking")
                : t("admin.update.check")}
            </button>
            ${this._updatePhase === "ready" ? html`
              <span>${t("admin.update.up-to-date")} (${this._updateCurrent})</span>
            ` : this._updatePhase === "available" ? html`
              <span>
                ${t("admin.update.available")} <strong>${this._updateLatest}</strong>
                ${this._updateChangelog ? html`
                  — <a href=${this._updateChangelog} target="_blank" rel="noopener">
                      ${t("admin.update.changelog")}
                    </a>` : nothing}
              </span>
            ` : this._updateCurrent ? html`
              <span>${t("admin.update.current-version")}: ${this._updateCurrent}</span>
            ` : nothing}
          </div>
          ${this._updatePhase === "available" ? html`
            <div class="dev-action-row">
              <button class="dev-action-btn"
                      @click=${() => void this._installUpdate()}>
                ${t("admin.update.install")} ${this._updateLatest}
              </button>
            </div>
          ` : this._updatePhase === "installing" ? html`
            <div class="dev-action-row">
              <span>${t("admin.update.installing")}</span>
            </div>
          ` : nothing}
          ${this._updateMsg ? html`
            <div class="dev-action-row">
              <span class="${this._updatePhase === "error" ? "set-err" : "set-msg"}">
                ${this._updateMsg}
              </span>
            </div>
          ` : nothing}
        </div>
      </div>

      <!-- recovery phrase -->
      <div class="dev-section">
        <h3>${t("admin.phrase.title")}</h3>
        <p class="dev-action-note" style="margin:0 0 0.5rem">${t("admin.phrase.desc")}</p>

        ${this._phraseStatus === "set" ? html`
          <div class="set-msg" style="margin-bottom:0.4rem">✓ ${t("admin.phrase.configured")}</div>
          <button class="dev-action-btn"
                  @click=${() => { if (confirm(t("admin.phrase.replace-confirm"))) void this._generatePhrase(); }}>
            ${t("admin.phrase.regenerate")}
          </button>
        ` : this._phraseStatus === "revealed" ? html`
          <!-- shown once; admin must copy before dismissing -->
          <p class="set-err" style="margin:0 0 0.4rem">${t("admin.phrase.save-now")}</p>
          <div class="phrase-box">${this._phraseWords}</div>
          <button class="dev-action-btn" style="margin-top:0.5rem"
                  @click=${() => {
                    void navigator.clipboard?.writeText(this._phraseWords);
                    this._phraseMsg = t("admin.phrase.copied");
                  }}>
            ${t("admin.phrase.copy")}
          </button>
          <button class="set-btn" style="margin-top:0.5rem; margin-left:0.4rem"
                  @click=${() => { this._phraseWords = ""; this._phraseStatus = "set"; }}>
            ${t("admin.phrase.saved-it")}
          </button>
        ` : this._phraseStatus === "unset" ? html`
          <button class="dev-action-btn"
                  @click=${() => void this._generatePhrase()}>
            ${t("admin.phrase.generate")}
          </button>
        ` : html`
          <span class="dev-action-note">${t("admin.phrase.checking")}</span>
        `}
        ${this._phraseMsg ? html`<div class="set-msg" style="margin-top:0.4rem">${this._phraseMsg}</div>` : nothing}
      </div>

      <!-- fsck + reinstall -->
      <div class="dev-section">
        <h3>${t("admin.device.actions-title")}</h3>
        <div class="dev-actions">

          <!-- format drive: still a stub -->
          <div class="dev-action-row">
            <button class="dev-action-btn" disabled>${t("admin.device.action-format-drive")}</button>
            <span class="dev-action-note">${t("admin.device.not-in-demo")}</span>
          </div>

          <!-- fsck -->
          <div class="dev-action-row">
            <button class="dev-action-btn"
                    ?disabled=${this._fsckPhase === "running"}
                    @click=${() => {
                      if (confirm(t("admin.device.fsck-confirm"))) void this._runFsck();
                    }}>
              ${this._fsckPhase === "running"
                ? t("admin.device.fsck-running")
                : t("admin.device.action-fsck")}
            </button>
            ${this._fsckMsg ? html`
              <span class="${this._fsckPhase === "error" ? "set-err" : "set-msg"}">
                ${this._fsckMsg}
              </span>` : nothing}
          </div>

          <!-- reinstall -->
          <div class="dev-action-row">
            <button class="dev-action-btn"
                    ?disabled=${this._reinstallPhase === "running"}
                    @click=${() => {
                      if (confirm(t("admin.device.reinstall-confirm"))) void this._runReinstall();
                    }}>
              ${this._reinstallPhase === "running"
                ? t("admin.device.reinstall-running")
                : t("admin.device.action-reinstall")}
            </button>
            ${this._reinstallMsg ? html`
              <span class="${this._reinstallPhase === "error" ? "set-err" : "set-msg"}">
                ${this._reinstallMsg}
              </span>` : nothing}
          </div>
        </div>
      </div>
    `;
  }

  private _renderAudit() {
    return html`
      <div class="audit-toolbar">
        <h3>${t("admin.audit.title")}</h3>
        <button class="set-btn" @click=${() => void this._fetchAudit()}>
          ${t("admin.audit.refresh")}
        </button>
      </div>

      ${this._auditLoading ? html`<p class="stub">${t("admin.stub")}</p>` :
        this._auditEntries.length === 0 ? html`<p class="stub">${t("admin.audit.empty")}</p>` :
        html`
          <div style="overflow-x:auto">
            <table class="audit-table">
              <thead>
                <tr>
                  <th>${t("admin.audit.col-time")}</th>
                  <th>${t("admin.audit.col-actor")}</th>
                  <th>${t("admin.audit.col-action")}</th>
                  <th>${t("admin.audit.col-detail")}</th>
                </tr>
              </thead>
              <tbody>
                ${this._auditEntries.map((e) => html`
                  <tr>
                    <td>${new Date(e.timestamp * 1000).toLocaleString()}</td>
                    <td>${e.actor}</td>
                    <td>${t(`admin.audit.action.${e.action}`, e.action)}</td>
                    <td class="detail-col">${e.detail}</td>
                  </tr>`)}
              </tbody>
            </table>
          </div>`}
    `;
  }

  private _renderTerminal() {
    return html`
      <p class="term-info">${t("admin.terminal.info")}</p>
      <p class="term-meta">${t("admin.terminal.meta")}</p>

      ${this._termMsg ? html`<p class="stub">${this._termMsg}</p>` : nothing}

      ${!this._termActive ? html`
        <button class="set-btn"
                @click=${() => this.requireReauth(() => void this._openTerminal())}>
          ${t("admin.terminal.open")}
        </button>
      ` : html`
        <button class="add-btn secondary" style="margin-bottom:0.5rem"
                @click=${() => this._closeTerminal()}>
          ${t("admin.terminal.close")}
        </button>
        <div id="terminal-container"></div>
      `}
    `;
  }

  override render() {
    return html`
      <nav class="tabs">
        ${(["users", "services", "network", "device", "audit", "terminal"] as AdminTab[]).map((tab) => html`
          <button class="tab-btn ${this._tab === tab ? "active" : ""}"
                  @click=${() => {
                    this._tab = tab;
                    if (tab === "audit")  void this._fetchAudit();
                    if (tab === "device" && this._phraseStatus === "unknown")
                      void this._checkPhraseStatus();
                  }}>
            ${t(`admin.tab.${tab}`)}
          </button>
        `)}
      </nav>

      ${this._tab === "users"    ? this._renderUsers()    : nothing}
      ${this._tab === "services" ? this._renderServices() : nothing}
      ${this._tab === "network"  ? this._renderNetwork()  : nothing}
      ${this._tab === "device"   ? this._renderDevice()   : nothing}
      ${this._tab === "audit"    ? this._renderAudit()    : nothing}
      ${this._tab === "terminal" ? this._renderTerminal() : nothing}

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
