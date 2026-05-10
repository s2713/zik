import { css, html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { getCsrfHeaders } from "./csrf.js";
import { isGloballyEnabled } from "./global-services.js";
import { t } from "./i18n/i18n.js";
import { SUPPORTED_LANGS, getLanguage, setLanguage } from "./i18n/i18n.js";
import { dispatchPlayerCmd, playerBus, type PlaylistStateEvent, type SelectionStateEvent } from "./player-bus.js";
import type { QueueItem, QueueItemEx, QueueStateDetail } from "./queue/queue-item.js";
import { queue } from "./queue/queue-controller.js";
import { PlayerBase } from "./player-base.js";
import { LOCK_REQUEST_EVENT } from "./screen-lock.js";
import { SERVICE_ICONS } from "./service-icons.js";
import { SERVICES } from "./services-list.js";
import {
  USER_CHANGED_EVENT, allowedServices, canBluetooth, canWifi,
  currentUser,
} from "./session.js";
import "./services/playlists/playlist-popup-element.js";
import "./services/playlists/playlists-player-element.js";

/** Dispatched on window when service visibility changes, so external listeners can react. */
export const SERVICES_CHANGED_EVENT = "zik-services-changed";

// Battery Status API — not in standard lib typings.
interface BatteryManager extends EventTarget {
  readonly charging: boolean;
  readonly level:    number;
  addEventListener(type: "chargingchange" | "levelchange", cb: () => void): void;
  removeEventListener(type: "chargingchange" | "levelchange", cb: () => void): void;
}
declare global {
  interface Navigator { getBattery?(): Promise<BatteryManager>; }
}

type PowerAction = "poweroff" | "suspend" | "hibernate";

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}
function fmtTotalDur(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
    : `${m}:${sec.toString().padStart(2, "0")}`;
}

interface PlayerStateData {
  status:   "playing" | "paused" | "stopped";
  track:    { title: string; artist: string; duration: number; service: string } | null;
  position: number;
}

// ---- localStorage helpers (per-user) ----
function _visibleKey(): string { return `zik-demo.${currentUser()}.visible-services`; }
function _shareKey():   string { return `zik-demo.${currentUser()}.share-with-admin`; }

function _loadVisible(): Set<string> {
  try {
    const raw = localStorage.getItem(_visibleKey());
    if (raw) {
      // Merge stored set with current SERVICES so new services default to visible.
      const stored = new Set(JSON.parse(raw) as string[]);
      const allTags = SERVICES.map((s) => s.tag);
      for (const tag of allTags) stored.add(tag);
      return stored;
    }
  } catch { /* ignore */ }
  return new Set(SERVICES.map((s) => s.tag));
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

// ---- top-bar SVG icons ----
function _svgBack(): TemplateResult {
  return html`<svg viewBox="0 0 24 24" width="20" height="20" fill="none"
      stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="15 18 9 12 15 6"/>
  </svg>`;
}

function _svgWifi(): TemplateResult {
  return html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M1.5 8.5a16 16 0 0 1 21 0"/>
    <path d="M5 12.5a10 10 0 0 1 14 0"/>
    <path d="M8.5 16.5a5 5 0 0 1 7 0"/>
    <circle cx="12" cy="20.5" r="1" fill="currentColor" stroke="none"/>
  </svg>`;
}

function _svgBt(): TemplateResult {
  return html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/>
  </svg>`;
}


function _svgLock(): TemplateResult {
  return html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2"/>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>`;
}

function _svgLogout(): TemplateResult {
  return html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
    <polyline points="16 17 21 12 16 7"/>
    <line x1="21" y1="12" x2="9" y2="12"/>
  </svg>`;
}

/**
 * Main user-facing shell: top bar, home grid, service players, footer transport bar,
 * settings drawer, connectivity stubs, and power confirmation dialog.
 */
@customElement("user-shell")
export class UserShell extends PlayerBase {
  static override styles = css`
    :host {
      display: block;
      min-height: 100vh;
      background: #0f172a;
      color: #f8fafc;
      font-family: system-ui, -apple-system, sans-serif;
      overflow-x: hidden;
    }

    /* ---- top bar ---- */
    .topbar {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 56px;
      background: #1e293b;
      border-bottom: 1px solid #334155;
      display: flex;
      align-items: center;
      padding: 0 0.5rem;
      gap: 0.25rem;
      z-index: 100;
      box-sizing: border-box;
    }
    .topbar-left  { display: flex; align-items: center; gap: 0.4rem; flex: 1; min-width: 0; }
    .topbar-right { display: flex; align-items: center; gap: 0.15rem; flex-shrink: 0; }
    .topbar-brand { font-size: 1.15rem; font-weight: 700; letter-spacing: -0.02em; white-space: nowrap; }
    .topbar-sep   { color: #475569; padding: 0 0.1rem; }
    .topbar-svc   {
      font-size: 0.88rem; color: #94a3b8;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* coloured pill shown when a service is active */
    .topbar-svc-chip {
      color: #fff;
      padding: 0.18rem 0.6rem;
      border-radius: 99px;
      font-weight: 600;
      font-size: 0.82rem;
    }

    /* ---- icon buttons (44 × 44 touch targets) ---- */
    .icon-btn {
      width: 44px; height: 44px;
      border-radius: 10px;
      background: transparent;
      border: none;
      color: #f8fafc;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      font-size: 1.3rem;
      transition: background 0.12s;
      flex-shrink: 0;
    }
    .icon-btn:hover  { background: rgba(255,255,255,0.08); }
    .icon-btn:active { background: rgba(255,255,255,0.14); }
    .icon-btn.active { background: rgba(255,255,255,0.12); color: #7dd3fc; }
    .icon-btn:disabled { opacity: 0.4; cursor: default; }

    /* back button is wider to fit text label */
    .back-btn { width: auto; padding: 0 0.65rem; gap: 0.3rem; font-size: 0.9rem; }
    .back-label { white-space: nowrap; }

    /* language picker (inline text buttons) */
    .lang-btn {
      height: 32px;
      padding: 0 0.5rem;
      border-radius: 6px;
      background: transparent;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      font-size: 0.78rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      transition: background 0.1s, color 0.1s;
    }
    .lang-btn:hover    { background: rgba(255,255,255,0.08); color: #f8fafc; }
    .lang-btn.lang-cur { color: #f8fafc; background: rgba(255,255,255,0.1); }

    /* battery badge */
    .battery { font-size: 0.8rem; color: #94a3b8; padding: 0 0.15rem; white-space: nowrap; }

    /* ---- content area (below topbar, above footer) ---- */
    .content { padding-top: 56px; padding-bottom: 68px; min-height: 100vh; box-sizing: border-box; }

    /* ---- home grid ---- */
    .home {
      padding: 2.5rem 2rem;
      max-width: 960px;
      margin: 0 auto;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
      gap: 1.5rem;
    }
    .card {
      border-radius: 20px;
      padding: 2.25rem 1rem 1.75rem;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 1rem;
      cursor: pointer;
      transition: transform 0.14s ease, box-shadow 0.14s ease;
      box-shadow: 0 4px 18px rgba(0,0,0,0.45);
      user-select: none;
      -webkit-tap-highlight-color: transparent;
      outline: none;
    }
    .card:hover  { transform: translateY(-4px); box-shadow: 0 12px 30px rgba(0,0,0,0.55); }
    .card:active { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0,0,0,0.50); }
    .card:focus-visible { outline: 3px solid #7dd3fc; outline-offset: 2px; }
    .card svg { width: 76px; height: 76px; }
    .card-name {
      font-size: 1rem; font-weight: 600;
      color: rgba(255,255,255,0.95);
      text-align: center;
      text-shadow: 0 1px 4px rgba(0,0,0,0.45);
    }
    .no-services { color: #64748b; font-size: 1rem; text-align: center; padding: 5rem 2rem; }

    /* ---- service players ---- */
    .player-off { display: none; }

    /* ---- footer — three equal columns ---- */
    .footer {
      position: fixed; bottom: 0; left: 0; right: 0;
      height: 76px;
      background: #1e293b;
      border-top: 1px solid #334155;
      display: grid; grid-template-columns: 1fr 1fr 1fr;
      align-items: stretch;
      z-index: 100;
    }

    /* left column: transport + now-playing */
    .footer-left {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0 0.75rem; min-width: 0;
    }
    .footer-controls { display: flex; align-items: center; gap: 0.4rem; flex-shrink: 0; }
    .ctrl-btn {
      width: 40px; height: 40px;
      border-radius: 50%;
      background: rgba(255,255,255,0.07);
      border: none; color: #f8fafc;
      cursor: pointer; font-size: 1.1rem;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.12s;
      flex-shrink: 0;
    }
    .ctrl-btn:hover { background: rgba(255,255,255,0.14); }
    .ctrl-btn.play-btn {
      width: 46px; height: 46px;
      background: rgba(255,255,255,0.16); font-size: 1.2rem;
    }
    .ctrl-btn.play-btn:hover { background: rgba(255,255,255,0.24); }
    .footer-track {
      flex: 1; min-width: 0; padding: 0 0.25rem;
      display: flex; flex-direction: column; justify-content: center; gap: 3px;
    }
    .track-title { font-size: 0.9rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .track-sub   { font-size: 0.82em; color: #94a3b8; font-weight: 400; }
    .track-progress-row { display: flex; align-items: center; gap: 0.4rem; }
    .track-bar {
      flex: 1; height: 3px; background: #334155;
      border-radius: 2px; overflow: hidden;
    }
    .track-fill {
      height: 100%; background: #60a5fa; border-radius: 2px;
      transition: width 0.9s linear;
    }
    .track-time {
      font-size: 0.72rem; color: #64748b; white-space: nowrap;
      flex-shrink: 0; font-variant-numeric: tabular-nums;
    }
    .footer-stats {
      display: flex; flex-direction: column; align-items: flex-end;
      font-size: 0.72rem; color: #64748b; white-space: nowrap;
      flex-shrink: 0; padding: 0 0.1rem; gap: 2px;
    }
    .footer-stats-bold { font-size: 0.78rem; color: #94a3b8; }

    /* middle column: queue mini-panel */
    .footer-mid {
      display: flex; align-items: center; justify-content: center;
      padding: 0 0.6rem; min-width: 0; overflow: hidden;
      border-left: 1px solid #334155; border-right: 1px solid #334155;
      cursor: pointer; user-select: none;
    }
    .footer-mid:hover { background: rgba(255,255,255,0.04); }
    .q-next {
      display: flex; align-items: center; gap: 0.4rem; min-width: 0; overflow: hidden;
      font-size: 0.8rem; color: #94a3b8; pointer-events: none;
    }
    .q-next-arrow { flex-shrink: 0; color: #475569; font-size: 0.75rem; }
    .q-next-count { flex-shrink: 0; font-size: 0.72rem; color: #64748b;
                    background: #334155; border-radius: 10px; padding: 0.1em 0.45em; }
    .q-next-label { flex-shrink: 0; }
    .q-next-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #f1f5f9; }

    /* queue dropdown — fixed above footer, aligned to middle column */
    .q-backdrop  { position: fixed; inset: 0; z-index: 150; }
    .q-dropdown  {
      position: fixed; bottom: 76px; left: 33.333%; right: 33.333%;
      background: #1e293b; border: 1px solid #334155; border-bottom: none;
      max-height: 50vh; display: flex; flex-direction: column;
      z-index: 151; overflow: hidden;
    }
    .q-drop-header {
      display: flex; align-items: center; gap: 0.4rem;
      padding: 0.4rem 0.6rem; border-bottom: 1px solid #334155; flex-shrink: 0;
    }
    .q-drop-title { font-size: 0.8rem; color: #94a3b8; flex: 1; }
    .q-drop-clear {
      padding: 0.2em 0.55em; font-size: 0.78rem; border: none; border-radius: 4px;
      cursor: pointer; background: #334155; color: #f1f5f9; transition: background 0.12s;
    }
    .q-drop-clear:hover:not(:disabled) { background: #ef4444; }
    .q-drop-clear:disabled { opacity: 0.4; cursor: default; }
    .q-drop-clear.confirm { background: #dc2626; }
    .q-drop-clear.confirm:hover { background: #b91c1c; }
    .q-drop-list { overflow-y: auto; flex: 1; }
    .q-drop-row {
      display: grid; grid-template-columns: 1.8em 1fr auto;
      align-items: center; font-size: 0.82rem;
      padding: 0.2rem 0.5rem; cursor: pointer; min-height: 30px;
      border-bottom: 1px solid #0f172a;
    }
    .q-drop-row:hover   { background: #334155; }
    .q-drop-row.playing { background: rgba(96,165,250,0.15); font-weight: 600; }
    .q-drop-num  { color: #475569; font-size: 0.75rem; text-align: right; padding-right: 0.35rem; }
    .q-drop-info { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .q-drop-sub  { color: #94a3b8; }
    .q-drop-dur  { color: #64748b; font-size: 0.75rem; font-variant-numeric: tabular-nums; padding-left: 0.5rem; }

    /* volume button + popup (lives in footer-left, far-left position) */
    .vol-wrap { flex-shrink: 0; }
    .vol-btn {
      width: 36px; height: 36px; border-radius: 50%;
      background: transparent; border: none;
      color: #f8fafc; cursor: pointer; font-size: 1.1rem;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.12s;
    }
    .vol-btn:hover { background: rgba(255,255,255,0.1); }
    .vol-btn.muted { color: #94a3b8; }
    /* fixed so no ancestor overflow or stacking-context can clip it */
    .vol-popup {
      position: fixed; bottom: 76px; left: 0;
      background: #1e293b; border: 1px solid #334155; border-radius: 0 8px 0 0;
      padding: 0.5rem; display: flex; flex-direction: column;
      align-items: center; gap: 0.3rem; z-index: 200;
    }
    .vol-slider-v {
      writing-mode: vertical-lr; direction: rtl;
      height: 100px; width: 24px;
      accent-color: #60a5fa; cursor: pointer;
    }
    .vol-pct { font-size: 0.72rem; color: #64748b; font-variant-numeric: tabular-nums; }

    /* right column: playlist buttons only, fill the column */
    .footer-right { display: flex; align-items: stretch; }

    /* ---- overlay + drawer ---- */
    .overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.55);
      z-index: 200;
      animation: fade-in 0.18s ease;
    }
    @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }

    .drawer {
      position: fixed; top: 0; right: 0; bottom: 0;
      width: min(380px, 92vw);
      background: #1e293b;
      border-left: 1px solid #334155;
      z-index: 201;
      overflow-y: auto;
      display: flex; flex-direction: column; gap: 1.5rem;
      padding: 1.25rem 1.5rem 2rem;
      box-shadow: -6px 0 28px rgba(0,0,0,0.55);
      box-sizing: border-box;
      animation: slide-in 0.2s ease;
    }
    @keyframes slide-in { from { transform: translateX(100%); } to { transform: translateX(0); } }

    .drawer-header {
      display: flex; align-items: center; gap: 0.75rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid #334155;
      flex-shrink: 0;
    }
    .drawer-title { font-size: 1.05rem; font-weight: 600; flex: 1; }
    .drawer-close {
      width: 36px; height: 36px; border-radius: 8px;
      background: rgba(255,255,255,0.07); border: none;
      color: #f8fafc; cursor: pointer; font-size: 1rem;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .drawer-close:hover { background: rgba(255,255,255,0.14); }

    .drawer-section h3 {
      font-size: 0.78rem; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.07em;
      color: #94a3b8; margin: 0 0 0.75rem;
    }

    /* service rows in settings */
    .svc-row {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.45rem 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .svc-row-toggle { display: flex; align-items: center; gap: 0.5rem; flex: 1; cursor: pointer; }
    .svc-row-name   { font-size: 0.9rem; }
    .svc-share-lbl  { display: flex; align-items: center; gap: 0.25rem; font-size: 0.78rem; color: #64748b; cursor: pointer; }

    /* password form */
    .pw-form { display: flex; flex-direction: column; gap: 0.55rem; }
    .pw-form input {
      background: #0f172a; border: 1px solid #334155; border-radius: 8px;
      color: #f8fafc; font-size: 0.92rem; padding: 0.5rem 0.75rem;
      outline: none; width: 100%; box-sizing: border-box;
    }
    .pw-form input:focus { border-color: #60a5fa; }
    .pw-form .submit-btn {
      background: #2563eb; border: none; border-radius: 8px;
      color: white; font-size: 0.92rem; padding: 0.5rem 1rem;
      cursor: pointer; align-self: flex-start;
    }
    .pw-form .submit-btn:disabled { opacity: 0.5; cursor: default; }
    .pw-ok  { color: #34d399; font-size: 0.82rem; }
    .pw-err { color: #f87171; font-size: 0.82rem; }

    /* connectivity stub */
    .conn-stub { color: #64748b; font-size: 0.88rem; font-style: italic; margin: 0; }

    /* ---- power confirm dialog ---- */
    .dialog-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.65);
      z-index: 300;
      display: flex; align-items: center; justify-content: center;
    }
    .dialog {
      background: #1e293b; border: 1px solid #334155; border-radius: 18px;
      padding: 2rem; max-width: 340px; width: 90%;
      display: flex; flex-direction: column; gap: 1.25rem;
      box-shadow: 0 24px 64px rgba(0,0,0,0.75);
    }
    .dialog-title { font-size: 1.15rem; font-weight: 600; }
    .dialog-msg   { color: #94a3b8; font-size: 0.92rem; margin: 0; }
    .dialog-btns  { display: flex; gap: 0.75rem; justify-content: flex-end; }
    .btn-cancel {
      background: rgba(255,255,255,0.08); border: none; border-radius: 9px;
      color: #f8fafc; padding: 0.5rem 1.25rem; cursor: pointer; font-size: 0.92rem;
    }
    .btn-cancel:hover { background: rgba(255,255,255,0.14); }
    .btn-danger {
      background: #dc2626; border: none; border-radius: 9px;
      color: white; padding: 0.5rem 1.25rem; cursor: pointer; font-size: 0.92rem;
    }
    .btn-danger:hover    { background: #b91c1c; }
    .btn-danger:disabled { opacity: 0.5; cursor: default; }

    /* ---- playlist footer buttons ---- */
    .pl-btns { display: flex; flex: 1; align-self: stretch; }
    .pl-btn {
      flex: 1 1 0; min-width: 0;
      display: flex; align-items: center; justify-content: center;
      padding: 0 0.9em; border-radius: 0; font-size: 0.8rem;
      border: none; cursor: pointer; white-space: nowrap;
      transition: background 0.12s;
    }
    .pl-btn-add  { background: #0f766e; color: #f0fdfa; }
    .pl-btn-add:hover  { background: #0d9488; }
    .pl-btn-add.drag-over { background: #0d9488; outline: 2px solid #5eead4; }
    .pl-btn-browse { background: #334155; color: #f1f5f9; }
    .pl-btn-browse:hover { background: #475569; }

    /* ---- toast ---- */
    .toast {
      position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
      background: #334155; border: 1px solid #475569; border-radius: 10px;
      padding: 0.5rem 1.1rem; font-size: 0.85rem; color: #f8fafc;
      z-index: 400; pointer-events: none; white-space: nowrap;
    }
  `;

  // ---- navigation ----
  @state() private _activeId: string | null = null;

  // ---- panels ----
  @state() private _settingsOpen = false;
  @state() private _connWifiOpen = false;
  @state() private _connBtOpen   = false;
  @state() private _powerConfirm = false;

  // ---- power ----
  @state() private _powerBusy  = false;
  @state() private _powerToast = "";

  // ---- battery ----
  @state() private _charging: boolean | null = null;
  @state() private _level:    number | null  = null;

  // ---- user (displayed in top bar; updated by _onUserChanged) ----
  @state() private _user = currentUser();

  // ---- service visibility prefs ----
  @state() private _visible: Set<string> = _loadVisible();
  @state() private _shares:  Set<string> = _loadShares();

  // ---- password form ----
  @state() private _pwCurrent = "";
  @state() private _pwNew     = "";
  @state() private _pwConfirm = "";
  @state() private _pwStatus: { ok: boolean; msg: string; sim?: boolean } | null = null;
  @state() private _pwBusy = false;

  // ---- player state (polled for footer display) ----
  @state() private _playerState:  PlayerStateData   | null = null;
  // ---- live playlist state pushed by the active service player ----
  @state() private _playlistState: PlaylistStateEvent | null = null;

  // ---- playlist popup ----
  @state() private _playlistPopup: "add" | "browse" | null = null;
  @state() private _selectionItems: QueueItem[] = [];
  @state() private _addBtnDragOver = false;

  // ---- volume popup (footer left column) ----
  @state() private _volOpen = false;

  // ---- queue mini-panel (footer middle column) ----
  @state() private _queueOpen         = false;
  @state() private _queueItems:       QueueItemEx[] = [];
  @state() private _queueIdx          = -1;
  @state() private _queueClearConfirm = false;

  // ---- volume / mute ----
  @state() private _volume = 80;   // desired level 0–100 (persisted across mute)
  @state() private _muted  = false;

  private _battery:    BatteryManager | null = null;
  private _toastTimer: ReturnType<typeof setTimeout>  | null = null;
  private _pollTimer:  ReturnType<typeof setInterval> | null = null;

  private readonly _onPlaylistState = (e: Event): void => {
    this._playlistState = (e as CustomEvent<PlaylistStateEvent>).detail;
  };

  private readonly _onSelectionState = (e: Event): void => {
    this._selectionItems = (e as CustomEvent<SelectionStateEvent>).detail.items;
  };

  private readonly _onQueueState = (e: Event): void => {
    const d = (e as CustomEvent<QueueStateDetail>).detail;
    this._queueItems = d.items;
    this._queueIdx   = d.index;
  };

  private readonly _onUserChanged = (e: Event): void => {
    this._user    = (e as CustomEvent<string>).detail;
    this._visible = _loadVisible();
    this._shares  = _loadShares();
    this._pwStatus = null;
    window.dispatchEvent(new CustomEvent(SERVICES_CHANGED_EVENT));
  };

  private readonly _onBatteryChange = (): void => {
    if (!this._battery) return;
    this._charging = this._battery.charging;
    this._level    = this._battery.level;
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(USER_CHANGED_EVENT, this._onUserChanged);
    playerBus.addEventListener("playlist-state", this._onPlaylistState);
    playerBus.addEventListener("selection-state", this._onSelectionState);
    queue.addEventListener("queue-state", this._onQueueState);
    // Initialise from current queue singleton state.
    this._queueItems = [...queue.items];
    this._queueIdx   = queue.index;
    void this._initBattery();
    this._pollTimer = setInterval(() => void this._pollPlayer(), 2000);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(USER_CHANGED_EVENT, this._onUserChanged);
    playerBus.removeEventListener("playlist-state", this._onPlaylistState);
    playerBus.removeEventListener("selection-state", this._onSelectionState);
    queue.removeEventListener("queue-state", this._onQueueState);
    if (this._battery) {
      this._battery.removeEventListener("chargingchange", this._onBatteryChange);
      this._battery.removeEventListener("levelchange",    this._onBatteryChange);
    }
    if (this._toastTimer !== null) clearTimeout(this._toastTimer);
    if (this._pollTimer  !== null) clearInterval(this._pollTimer);
  }

  private async _initBattery(): Promise<void> {
    if (!navigator.getBattery) return;
    try {
      this._battery = await navigator.getBattery();
      this._battery.addEventListener("chargingchange", this._onBatteryChange);
      this._battery.addEventListener("levelchange",    this._onBatteryChange);
      this._onBatteryChange();
    } catch { /* Battery API blocked by permissions policy — degrade silently */ }
  }

  private async _pollPlayer(): Promise<void> {
    if (this._activeId === null) return;
    try {
      const r = await fetch("/api/player/state");
      this._playerState = (await r.json()) as PlayerStateData;
    } catch { /* ignore — backend may not be serving player state for all services */ }
  }

  // ---- navigation ----
  private _openService(id: string): void {
    this._activeId     = id;
    this._settingsOpen = false;
    this._connWifiOpen = false;
    this._connBtOpen   = false;
  }

  private _goHome(): void { this._activeId = null; }

  // ---- service visibility ----
  private _toggleVisible(tag: string): void {
    const v = new Set(this._visible);
    if (v.has(tag)) v.delete(tag); else v.add(tag);
    this._visible = v;
    _saveVisible(v);
    window.dispatchEvent(new CustomEvent(SERVICES_CHANGED_EVENT));
  }

  private _toggleShare(tag: string): void {
    const s = new Set(this._shares);
    if (s.has(tag)) s.delete(tag); else s.add(tag);
    this._shares = s;
    _saveShares(s);
  }

  // ---- power ----
  private _lock(): void {
    void fetch("/api/session/lock", { method: "POST", headers: getCsrfHeaders() });
    window.dispatchEvent(new CustomEvent(LOCK_REQUEST_EVENT));
  }

  private async _doPower(action: PowerAction): Promise<void> {
    this._powerConfirm = false;
    this._powerBusy    = true;
    try {
      const r = await fetch(`/api/power/${action}`, {
        method: "POST", headers: getCsrfHeaders(),
      });
      const d = (await r.json()) as { simulated?: boolean };
      if (d.simulated) this._showToast(action);
    } catch { this._showToast(action); }
    finally  { this._powerBusy = false; }
  }

  private _showToast(action: PowerAction): void {
    this._powerToast = t("power.simulated").replace("{action}", t(`power.${action}`));
    if (this._toastTimer !== null) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this._powerToast = ""; }, 3000);
  }

  // ---- footer transport ----

  /**
   * Id of the service currently playing.
   * Prefer live queue state (zero lag); fall back to backend poll for non-queue services (MPD).
   */
  private get _playingId(): string | null {
    const qStatus = this._playlistState?.status;
    if (qStatus && qStatus !== "stopped") return this._playlistState!.serviceId || null;
    return this._playerState?.track?.service ?? this._activeId;
  }

  private _cmd(command: string): void {
    const MAP: Record<string, "Play" | "Pause" | "Stop" | "Next" | "Previous"> = {
      play: "Play", pause: "Pause", stop: "Stop", next: "Next", prev: "Previous",
    };
    const type = MAP[command];
    if (!type) return;
    dispatchPlayerCmd({ type, serviceId: this._playingId });
  }

  private _setVolume(v: number): void {
    this._volume = v;
    this._muted  = v === 0;
    dispatchPlayerCmd({ type: "SetVolume", volume: v / 100, serviceId: this._playingId });
  }

  private _toggleMute(): void {
    this._muted = !this._muted;
    const effective = this._muted ? 0 : this._volume;
    dispatchPlayerCmd({ type: "SetVolume", volume: effective / 100, serviceId: this._playingId });
  }

  // ---- password change ----
  private async _submitPw(e: Event): Promise<void> {
    e.preventDefault();
    if (!this._pwNew) {
      this._pwStatus = { ok: false, msg: t("account.password-empty") };
      return;
    }
    if (this._pwNew !== this._pwConfirm) {
      this._pwStatus = { ok: false, msg: t("account.password-mismatch") };
      return;
    }
    this._pwBusy = true; this._pwStatus = null;
    try {
      const r = await fetch("/api/user/password", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({ current_password: this._pwCurrent, new_password: this._pwNew }),
      });
      const d = (await r.json()) as { ok: boolean; simulated?: boolean };
      if (d.ok) {
        this._pwStatus  = { ok: true, msg: t("account.password-ok"), sim: d.simulated ?? false };
        this._pwCurrent = ""; this._pwNew = ""; this._pwConfirm = "";
      } else {
        this._pwStatus = { ok: false, msg: t("account.password-error") };
      }
    } catch {
      this._pwStatus = { ok: false, msg: t("account.password-error") };
    } finally { this._pwBusy = false; }
  }

  // ---- helpers ----
  private _svcAllowed(id: string): boolean {
    if (!isGloballyEnabled(id)) return false;
    const a = allowedServices();
    return a === null || a.includes(id);
  }

  private _playerClass(id: string): string {
    return (this._svcAllowed(id) && this._activeId === id) ? "" : "player-off";
  }

  private _activeSvcLabel(): string {
    return SERVICES.find((s) => s.id === this._activeId)?.i18nKey
      ? t(SERVICES.find((s) => s.id === this._activeId)!.i18nKey)
      : "";
  }

  // ---- render: battery ----
  private _renderBattery(): TemplateResult {
    if (this._level === null) return html``;
    const pct  = Math.round(this._level * 100);
    const icon = this._charging ? "⚡" : pct > 20 ? "🔋" : "🪫";
    return html`<span class="battery" title="${pct}%">${icon} ${pct}%</span>`;
  }

  // ---- render: top bar ----
  private _renderTopBar(): TemplateResult {
    const inSvc = this._activeId !== null;
    const lang  = getLanguage();
    return html`
      <header class="topbar">

        <div class="topbar-left">
          ${inSvc ? html`
            <button class="icon-btn back-btn" @click=${() => this._goHome()}
                    aria-label=${t("shell.back")}>
              ${_svgBack()}
              <span class="back-label">${t("shell.back")}</span>
            </button>
            <span class="topbar-sep">·</span>
          ` : nothing}
          <span class="topbar-brand">zik</span>
          <span class="topbar-sep">·</span>
          <span class="topbar-svc ${inSvc ? "topbar-svc-chip" : ""}"
                style=${inSvc && this._activeId
                  ? `background:${SERVICE_ICONS[this._activeId]?.color ?? "#334155"}`
                  : ""}>
            ${inSvc ? this._activeSvcLabel() : this._user}
          </span>
        </div>

        <div class="topbar-right">
          <!-- language picker -->
          ${SUPPORTED_LANGS.map((l) => html`
            <button class="lang-btn ${l === lang ? "lang-cur" : ""}"
                    ?disabled=${l === lang}
                    @click=${() => { setLanguage(l); this.requestUpdate(); }}>
              ${t(`lang.${l}`)}
            </button>`)}

          <!-- connectivity (only shown when admin grants permission) -->
          ${canWifi() ? html`
            <button class="icon-btn ${this._connWifiOpen ? "active" : ""}"
                    title=${t("shell.connectivity.wifi")}
                    aria-label=${t("shell.connectivity.wifi")}
                    @click=${() => {
                      this._connWifiOpen = !this._connWifiOpen;
                      this._connBtOpen = false; this._settingsOpen = false;
                    }}>
              ${_svgWifi()}
            </button>` : nothing}

          ${canBluetooth() ? html`
            <button class="icon-btn ${this._connBtOpen ? "active" : ""}"
                    title=${t("shell.connectivity.bt")}
                    aria-label=${t("shell.connectivity.bt")}
                    @click=${() => {
                      this._connBtOpen = !this._connBtOpen;
                      this._connWifiOpen = false; this._settingsOpen = false;
                    }}>
              ${_svgBt()}
            </button>` : nothing}

          <!-- settings -->
          <button class="icon-btn ${this._settingsOpen ? "active" : ""}"
                  title=${t("shell.settings")}
                  aria-label=${t("shell.settings")}
                  @click=${() => {
                    this._settingsOpen = !this._settingsOpen;
                    this._connWifiOpen = false; this._connBtOpen = false;
                  }}>
            ⚙
          </button>

          <!-- lock screen -->
          <button class="icon-btn"
                  title=${t("session.lock")}
                  aria-label=${t("session.lock")}
                  @click=${() => this._lock()}>
            ${_svgLock()}
          </button>

          <!-- log out / switch user (fires lock-screen overlay) -->
          <button class="icon-btn"
                  title=${t("shell.logout")}
                  aria-label=${t("shell.logout")}
                  @click=${() => this._lock()}>
            ${_svgLogout()}
          </button>

          <!-- power off -->
          <button class="icon-btn"
                  title=${t("power.poweroff")}
                  aria-label=${t("power.poweroff")}
                  ?disabled=${this._powerBusy}
                  @click=${() => { this._powerConfirm = true; }}>
            ⏻
          </button>

          ${this._renderBattery()}
        </div>

      </header>
    `;
  }

  // ---- render: home grid ----
  private _renderHomeGrid(): TemplateResult {
    const cards = SERVICES.filter(({ tag, id }) =>
      this._svcAllowed(id) && this._visible.has(tag));
    return html`
      <div class="home">
        ${cards.length === 0
          ? html`<p class="no-services">${t("shell.no-services")}</p>`
          : html`
            <div class="grid">
              ${cards.map(({ id, i18nKey }) => {
                const icon = SERVICE_ICONS[id] ?? SERVICE_ICONS["demo"];
                return html`
                  <div class="card"
                       style="background:${icon.color}"
                       role="button" tabindex="0"
                       @click=${() => this._openService(id)}
                       @keydown=${(e: KeyboardEvent) => {
                         if (e.key === "Enter" || e.key === " ") this._openService(id);
                       }}>
                    ${icon.svg}
                    <span class="card-name">${t(i18nKey)}</span>
                  </div>`;
              })}
            </div>`}
      </div>
    `;
  }

  // ---- render: service players (all allowed services mounted; active one visible) ----
  private _renderPlayers(): TemplateResult {
    return html`
      <div>
        <div class="${this._playerClass("demo")}"><demo-player></demo-player></div>
        <div class="${this._playerClass("files")}"><files-player></files-player></div>
        <div class="${this._playerClass("mpd")}"><mpd-player></mpd-player></div>
        <div class="${this._playerClass("subsonic")}"><subsonic-player></subsonic-player></div>
        <div class="${this._playerClass("spotify")}"><spotify-player></spotify-player></div>
        <div class="${this._playerClass("podcasts")}"><podcasts-player></podcasts-player></div>
        <div class="${this._playerClass("radio")}"><radio-player></radio-player></div>
        <div class="${this._playerClass("playlists")}"><playlists-player></playlists-player></div>
      </div>
    `;
  }

  // ---- render: persistent footer transport bar ----
  // ---- queue mini-panel helpers ----

  /** Toggle queue dropdown open/closed; resets confirm state on close. */
  private _toggleQueue(): void {
    this._queueOpen = !this._queueOpen;
    if (!this._queueOpen) this._queueClearConfirm = false;
  }

  /** Close queue dropdown and reset confirm state. */
  private _closeQueue(): void {
    this._queueOpen = false;
    this._queueClearConfirm = false;
  }

  /** Inline "Next: <title>" label shown in the middle footer column. */
  private _renderQueueNext(): TemplateResult {
    const items = this._queueItems;
    const idx   = this._queueIdx;
    const arrow = this._queueOpen ? "▼" : "▲";
    if (items.length === 0) {
      return html`<span class="q-next">
        <span class="q-next-arrow">${arrow}</span>
        <span style="color:#475569">Queue empty</span>
      </span>`;
    }
    const next = idx >= 0 ? items[idx + 1] : items[0];
    return html`<span class="q-next">
      <span class="q-next-arrow">${arrow}</span>
      <span class="q-next-count">${items.length}</span>
      ${next ? html`<span class="q-next-label">Next:</span>
                    <span class="q-next-title">${next.title || next.trackId}</span>`
             : html`<span class="q-next-title">${items.length} track${items.length !== 1 ? "s" : ""}</span>`}
    </span>`;
  }

  /** Dropdown panel rendered above the middle footer column. */
  private _renderQueueDropdown(): TemplateResult {
    const items = this._queueItems;
    return html`
      <div class="q-dropdown" @click=${(e: Event) => e.stopPropagation()}>
        <div class="q-drop-header">
          <span class="q-drop-title">${items.length} track${items.length !== 1 ? "s" : ""} in queue</span>
          ${this._queueClearConfirm ? html`
            <button class="q-drop-clear confirm"
                    @click=${() => { queue.clear(); this._closeQueue(); }}>Confirm</button>
            <button class="q-drop-clear"
                    @click=${() => { this._queueClearConfirm = false; }}>Cancel</button>
          ` : html`
            <button class="q-drop-clear" ?disabled=${items.length === 0}
                    @click=${() => { this._queueClearConfirm = true; }}>Clear</button>
          `}
        </div>
        <div class="q-drop-list">
          ${items.map((item, i) => html`
            <div class="q-drop-row ${i === this._queueIdx ? "playing" : ""}"
                 @click=${() => { queue.playAt(i); this._closeQueue(); }}>
              <span class="q-drop-num">${i + 1}</span>
              <span class="q-drop-info">
                ${item.title || item.trackId}
                ${item.artist ? html`<span class="q-drop-sub"> · ${item.artist}</span>` : nothing}
              </span>
              <span class="q-drop-dur">${fmtTotalDur(item.duration)}</span>
            </div>
          `)}
        </div>
      </div>
    `;
  }

  private _renderFooter(): TemplateResult {
    const ps      = this._playerState;
    // Use live queue status when available — more accurate than 2s backend poll.
    // _playlistState is emitted by QueueController on every status change.
    const pl      = this._playlistState;
    const playing = pl ? pl.status === "playing" : ps?.status === "playing";
    const title   = ps?.track?.title  ?? "";
    const artist  = ps?.track?.artist ?? "";
    const vol     = this._muted ? 0 : this._volume;
    const muteIcon = this._muted || this._volume === 0 ? "🔇"
      : this._volume < 40 ? "🔈" : this._volume < 75 ? "🔉" : "🔊";

    // Prefer live position from queue controller (1 s resolution); fall back to backend poll.
    const pos = pl?.position ?? ps?.position ?? 0;
    const dur = pl?.duration ?? ps?.track?.duration ?? 0;
    const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;

    return html`
      <footer class="footer">

        <!-- left: volume button (far-left) + transport controls + now-playing -->
        <div class="footer-left">

          <!-- volume toggle — far left; popup is fixed above footer-left edge -->
          <div class="vol-wrap">
            <button class="vol-btn ${this._muted ? "muted" : ""}"
                    aria-label="Volume"
                    @click=${() => { this._volOpen = !this._volOpen; }}>
              ${muteIcon}
            </button>
            ${this._volOpen ? html`
              <div class="vol-popup">
                <input type="range" class="vol-slider-v"
                       min="0" max="100" .value=${String(vol)}
                       aria-label="Volume"
                       @input=${(e: Event) => this._setVolume(
                         Number((e.target as HTMLInputElement).value)
                       )} />
                <span class="vol-pct">${vol}%</span>
                <button class="vol-btn ${this._muted ? "muted" : ""}"
                        style="width:28px;height:28px;font-size:0.9rem"
                        aria-label=${this._muted ? "Unmute" : "Mute"}
                        @click=${() => this._toggleMute()}>
                  ${muteIcon}
                </button>
              </div>
            ` : nothing}
          </div>

          <div class="footer-controls">
            <button class="ctrl-btn" @click=${() => this._cmd("prev")} aria-label="Previous">⏮</button>
            <button class="ctrl-btn play-btn"
                    @click=${() => this._cmd(playing ? "pause" : "play")}
                    aria-label=${playing ? "Pause" : "Play"}>
              ${playing ? "⏸" : "▶"}
            </button>
            <button class="ctrl-btn" @click=${() => this._cmd("stop")} aria-label="Stop">⏹</button>
            <button class="ctrl-btn" @click=${() => this._cmd("next")} aria-label="Next">⏭</button>
          </div>

          <div class="footer-track">
            ${title ? html`
              <div class="track-title">
                ${title}${artist ? html`<span class="track-sub"> · ${artist}</span>` : nothing}
              </div>
              <div class="track-progress-row">
                <span class="track-time">${fmtTime(pos)}</span>
                <div class="track-bar">
                  <div class="track-fill" style="width:${pct}%"></div>
                </div>
                ${dur > 0 ? html`<span class="track-time">${fmtTime(dur)}</span>` : nothing}
              </div>
            ` : nothing}
          </div>

          ${pl && pl.total > 0 ? html`
            <div class="footer-stats">
              <span class="footer-stats-bold">
                ${pl.index >= 0 ? `${pl.index + 1} / ${pl.total}` : `– / ${pl.total}`}
              </span>
              <span>${fmtTotalDur(pl.totalDuration)}</span>
            </div>
          ` : nothing}
        </div>

        <!-- middle: queue panel -->
        <div class="footer-mid" @click=${() => this._toggleQueue()}>
          ${this._renderQueueNext()}
        </div>

        <!-- right: playlist buttons fill the full column -->
        <div class="footer-right">
          <div class="pl-btns">
            <button class="pl-btn pl-btn-add ${this._addBtnDragOver ? "drag-over" : ""}"
                    title=${t("playlists.add-to")}
                    @click=${() => { this._playlistPopup = "add"; }}
                    @dragover=${(e: DragEvent) => {
                      if (e.dataTransfer?.types.includes("queue-items-json")) {
                        e.preventDefault(); this._addBtnDragOver = true;
                      }
                    }}
                    @dragleave=${() => { this._addBtnDragOver = false; }}
                    @drop=${(e: DragEvent) => {
                      e.preventDefault(); this._addBtnDragOver = false;
                      const raw = e.dataTransfer?.getData("queue-items-json");
                      if (raw) {
                        try { this._selectionItems = JSON.parse(raw) as QueueItem[]; } catch { /* ignore */ }
                      }
                      this._playlistPopup = "add";
                    }}>
              ♪+ ${t("playlists.add-to")}
            </button>
            <button class="pl-btn pl-btn-browse"
                    title=${t("playlists.browse")}
                    @click=${() => { this._playlistPopup = "browse"; }}>
              ♪ ${t("playlists.browse")}
            </button>
          </div>
        </div>

      </footer>

      ${this._queueOpen ? html`
        <div class="q-backdrop" @click=${() => this._closeQueue()}></div>
        ${this._renderQueueDropdown()}
      ` : nothing}
    `;
  }

  // ---- render: settings drawer ----
  private _renderSettings(): TemplateResult {
    return html`
      <div class="overlay" @click=${() => { this._settingsOpen = false; }}></div>
      <div class="drawer" role="dialog" aria-label=${t("shell.settings")}>

        <div class="drawer-header">
          <span class="drawer-title">${t("shell.settings")}</span>
          <button class="drawer-close" @click=${() => { this._settingsOpen = false; }}>✕</button>
        </div>

        <!-- service visibility -->
        <div class="drawer-section">
          <h3>${t("account.my-services")}</h3>
          ${SERVICES
            .filter(({ id }) => this._svcAllowed(id))
            .map(({ tag, i18nKey }) => html`
              <div class="svc-row">
                <label class="svc-row-toggle">
                  <input type="checkbox" .checked=${live(this._visible.has(tag))}
                         @change=${() => this._toggleVisible(tag)} />
                  <span class="svc-row-name">${t(i18nKey)}</span>
                </label>
                <label class="svc-share-lbl" title=${t("account.share-admin")}>
                  <input type="checkbox" .checked=${live(this._shares.has(tag))}
                         @change=${() => this._toggleShare(tag)} />
                  <span>↗ ${t("account.share-admin")}</span>
                </label>
              </div>`)}
        </div>

        <!-- password change -->
        <div class="drawer-section">
          <h3>${t("account.password")}</h3>
          <form class="pw-form" @submit=${(e: Event) => void this._submitPw(e)}>
            <input type="password" placeholder=${t("account.current-password")}
                   .value=${live(this._pwCurrent)}
                   @input=${(e: Event) => { this._pwCurrent = (e.target as HTMLInputElement).value; }} />
            <input type="password" placeholder=${t("account.new-password")}
                   .value=${live(this._pwNew)}
                   @input=${(e: Event) => { this._pwNew = (e.target as HTMLInputElement).value; }} />
            <input type="password" placeholder=${t("account.confirm-password")}
                   .value=${live(this._pwConfirm)}
                   @input=${(e: Event) => { this._pwConfirm = (e.target as HTMLInputElement).value; }} />
            <button type="submit" class="submit-btn" ?disabled=${this._pwBusy}>
              ${t("account.save-password")}
            </button>
            ${this._pwStatus ? html`
              <div class="${this._pwStatus.ok ? "pw-ok" : "pw-err"}">
                ${this._pwStatus.msg}
                ${this._pwStatus.sim ? html` <em>${t("account.simulated")}</em>` : nothing}
              </div>` : nothing}
          </form>
        </div>

      </div>
    `;
  }

  // ---- render: wifi panel (stub — connectivity not yet configurable) ----
  private _renderWifi(): TemplateResult {
    return html`
      <div class="overlay" @click=${() => { this._connWifiOpen = false; }}></div>
      <div class="drawer" role="dialog" aria-label=${t("shell.connectivity.wifi")}>
        <div class="drawer-header">
          <span class="drawer-title">${t("shell.connectivity.wifi")}</span>
          <button class="drawer-close" @click=${() => { this._connWifiOpen = false; }}>✕</button>
        </div>
        <div class="drawer-section">
          <p class="conn-stub">${t("shell.connectivity.stub")}</p>
        </div>
      </div>
    `;
  }

  // ---- render: bluetooth panel (stub) ----
  private _renderBt(): TemplateResult {
    return html`
      <div class="overlay" @click=${() => { this._connBtOpen = false; }}></div>
      <div class="drawer" role="dialog" aria-label=${t("shell.connectivity.bt")}>
        <div class="drawer-header">
          <span class="drawer-title">${t("shell.connectivity.bt")}</span>
          <button class="drawer-close" @click=${() => { this._connBtOpen = false; }}>✕</button>
        </div>
        <div class="drawer-section">
          <p class="conn-stub">${t("shell.connectivity.stub")}</p>
        </div>
      </div>
    `;
  }

  // ---- render: power confirmation dialog ----
  private _renderPowerDialog(): TemplateResult {
    return html`
      <div class="dialog-overlay">
        <div class="dialog" role="alertdialog">
          <div class="dialog-title">⏻ ${t("power.poweroff")}</div>
          <p class="dialog-msg">${t("shell.power-confirm")}</p>
          <div class="dialog-btns">
            <button class="btn-cancel" @click=${() => { this._powerConfirm = false; }}>
              ${t("shell.cancel")}
            </button>
            <button class="btn-danger" ?disabled=${this._powerBusy}
                    @click=${() => void this._doPower("poweroff")}>
              ${t("power.poweroff")}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    return html`
      ${this._renderTopBar()}
      <div class="content">
        ${this._activeId === null ? this._renderHomeGrid() : nothing}
        ${this._renderPlayers()}
      </div>
      ${this._renderFooter()}
      ${this._settingsOpen ? this._renderSettings()  : nothing}
      ${this._connWifiOpen ? this._renderWifi()      : nothing}
      ${this._connBtOpen   ? this._renderBt()        : nothing}
      ${this._powerConfirm ? this._renderPowerDialog() : nothing}
      ${this._powerToast   ? html`<div class="toast">${this._powerToast}</div>` : nothing}
      ${this._playlistPopup !== null ? html`
        <playlist-popup
          .mode=${this._playlistPopup}
          .items=${this._playlistPopup === "add" ? this._selectionItems : []}
          @close=${() => { this._playlistPopup = null; }}
          @open-service=${() => { this._playlistPopup = null; this._openService("playlists"); }}>
        </playlist-popup>` : nothing}
    `;
  }
}
