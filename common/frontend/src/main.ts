import { ensureCsrfToken } from "./csrf.js";
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

async function init(): Promise<void> {
  await loadMessages();
  await ensureCsrfToken(); // fetch CSRF cookie before any POST
  renderLanguagePicker();
  mountPlayer();
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
      void checkHealth();
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
