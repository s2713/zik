import "./power-bar.js";      // registers <power-bar>
import "./screen-lock.js";    // registers <screen-lock>
import "./user-account.js";   // registers <user-account>
import { SERVICES_CHANGED_EVENT } from "./user-account.js";
import { ensureCsrfToken } from "./csrf.js";
import { USER_CHANGED_EVENT, currentUser, loadSession } from "./session.js";
import {
  SUPPORTED_LANGS,
  getLanguage,
  loadMessages,
  setLanguage,
  t,
} from "./i18n/i18n.js";
import "./services/demo/demo-player-element.js";  // registers <demo-player>
import "./services/files/files-player-element.js"; // registers <files-player>
import "./services/mpd/mpd-player-element.js";        // registers <mpd-player>
import "./services/subsonic/subsonic-player-element.js"; // registers <subsonic-player>
import "./services/spotify/spotify-player-element.js";   // registers <spotify-player>
import "./services/podcasts/podcasts-player-element.js"; // registers <podcasts-player>
import "./services/radio/radio-player-element.js";       // registers <radio-player>

const _SERVICES: Array<{ tag: string; i18nKey: string }> = [
  { tag: "demo-player",     i18nKey: "service.demo"     },
  { tag: "files-player",    i18nKey: "service.files"    },
  { tag: "mpd-player",      i18nKey: "service.mpd"      },
  { tag: "subsonic-player", i18nKey: "service.subsonic" },
  { tag: "spotify-player",  i18nKey: "service.spotify"  },
  { tag: "podcasts-player", i18nKey: "service.podcasts" },
  { tag: "radio-player",    i18nKey: "service.radio"    },
];

/** Per-user localStorage key so each user's service visibility is independent. */
function _visibleKey(): string { return `zik-demo.${currentUser()}.visible-services`; }

function _loadVisible(): Set<string> {
  try {
    const raw = localStorage.getItem(_visibleKey());
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set(_SERVICES.map((s) => s.tag)); // default: all visible
}

function _saveVisible(visible: Set<string>): void {
  localStorage.setItem(_visibleKey(), JSON.stringify([...visible]));
}

function _applyVisibility(visible: Set<string>): void {
  for (const { tag } of _SERVICES) {
    const el = document.querySelector(tag) as HTMLElement | null;
    if (el) el.style.display = visible.has(tag) ? "" : "none";
  }
}

function mountPowerBar(): void {
  // Inserted between lang-bar and service-bar; idempotent.
  if (document.querySelector("power-bar")) return;
  const bar = document.createElement("power-bar");
  const langBar = document.getElementById("lang-bar");
  if (langBar?.nextSibling) {
    document.body.insertBefore(bar, langBar.nextSibling);
  } else {
    document.body.appendChild(bar);
  }
}

function mountScreenLock(): void {
  if (document.querySelector("screen-lock")) return;
  document.body.appendChild(document.createElement("screen-lock"));
}

function mountAccountPanel(): void {
  // Inserted after the service-bar; idempotent.
  if (document.querySelector("user-account")) return;
  const panel = document.createElement("user-account");
  const serviceBar = document.getElementById("service-bar");
  if (serviceBar?.nextSibling) {
    document.body.insertBefore(panel, serviceBar.nextSibling);
  } else {
    document.body.appendChild(panel);
  }
}

async function init(): Promise<void> {
  await loadMessages();
  await ensureCsrfToken();    // fetch CSRF cookie before any POST
  await loadSession();        // initialise currentUser() before any localStorage access
  renderLanguagePicker();
  mountPowerBar();
  mountPlayer();
  renderServiceToggles();
  mountAccountPanel();
  mountScreenLock();
  // Re-render service bar when service visibility or active user changes.
  window.addEventListener(SERVICES_CHANGED_EVENT, () => renderServiceToggles());
  window.addEventListener(USER_CHANGED_EVENT,     () => renderServiceToggles());
  await checkHealth();
}

function renderLanguagePicker(): void {
  let bar = document.getElementById("lang-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "lang-bar";
    document.body.prepend(bar);
  }
  bar.innerHTML = "";
  for (const lang of SUPPORTED_LANGS) {
    const btn = document.createElement("button");
    btn.textContent = t(`lang.${lang}`);
    btn.disabled = lang === getLanguage();
    btn.addEventListener("click", () => {
      setLanguage(lang);
      renderLanguagePicker();
      renderServiceToggles(); // re-render so labels follow language
      void checkHealth();
    });
    bar.appendChild(btn);
  }
}

function renderServiceToggles(): void {
  let bar = document.getElementById("service-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "service-bar";
    bar.style.cssText =
      "display:flex;gap:0.3rem;flex-wrap:wrap;padding:0.4rem 0.5rem;" +
      "background:#f4f4f4;border-bottom:1px solid #ddd;font-size:0.85em;";
    // Insert after lang-bar (which is prepended to body).
    const langBar = document.getElementById("lang-bar");
    if (langBar?.nextSibling) {
      document.body.insertBefore(bar, langBar.nextSibling);
    } else {
      document.body.prepend(bar);
    }
  }
  bar.innerHTML = "";

  const visible = _loadVisible();
  _applyVisibility(visible);

  const label = document.createElement("span");
  label.textContent = t("app.services-label");
  label.style.cssText = "align-self:center;color:#666;";
  bar.appendChild(label);

  for (const { tag, i18nKey } of _SERVICES) {
    const btn = document.createElement("button");
    btn.textContent = t(i18nKey);
    const isVisible = visible.has(tag);
    btn.style.cssText =
      `padding:0.15rem 0.5rem;border-radius:3px;cursor:pointer;border:1px solid #bbb;` +
      (isVisible
        ? "background:#0057b8;color:#fff;border-color:#0057b8;"
        : "background:#fff;color:#555;");
    btn.addEventListener("click", () => {
      if (visible.has(tag)) visible.delete(tag); else visible.add(tag);
      _saveVisible(visible);
      renderServiceToggles(); // re-render buttons to reflect new state
    });
    bar.appendChild(btn);
  }
}

function mountPlayer(): void {
  // Append each service element once; idempotent if called again.
  if (!document.querySelector("demo-player"))
    document.body.appendChild(document.createElement("demo-player"));
  if (!document.querySelector("files-player"))
    document.body.appendChild(document.createElement("files-player"));
  if (!document.querySelector("mpd-player"))
    document.body.appendChild(document.createElement("mpd-player"));
  if (!document.querySelector("subsonic-player"))
    document.body.appendChild(document.createElement("subsonic-player"));
  if (!document.querySelector("spotify-player"))
    document.body.appendChild(document.createElement("spotify-player"));
  if (!document.querySelector("podcasts-player"))
    document.body.appendChild(document.createElement("podcasts-player"));
  if (!document.querySelector("radio-player"))
    document.body.appendChild(document.createElement("radio-player"));
}

async function checkHealth(): Promise<void> {
  const mount = document.getElementById("app");
  if (!mount) return;
  try {
    const response = await fetch("/api/health");
    await response.json();
    mount.textContent = t("health.ok");
  } catch (err) {
    mount.textContent = t("health.error").replace("{error}", (err as Error).message);
  }
}

void init();
