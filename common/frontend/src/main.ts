import {
  SUPPORTED_LANGS,
  getLanguage,
  loadMessages,
  setLanguage,
  t,
} from "./i18n/i18n.js";

async function init(): Promise<void> {
  await loadMessages();
  renderLanguagePicker();
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