import "./screen-lock.js";                              // registers <screen-lock>
import "./user-shell.js";                               // registers <user-shell>
import "./admin/admin-app.js";                          // registers <admin-app>
import "./services/demo/demo-player-element.js";        // registers <demo-player>
import "./services/files/files-player-element.js";      // registers <files-player>
import "./services/mpd/mpd-player-element.js";          // registers <mpd-player>
import "./services/subsonic/subsonic-player-element.js"; // registers <subsonic-player>
import "./services/spotify/spotify-player-element.js";  // registers <spotify-player>
import "./services/podcasts/podcasts-player-element.js"; // registers <podcasts-player>
import "./services/radio/radio-player-element.js";      // registers <radio-player>

import { ensureCsrfToken } from "./csrf.js";
import { loadGlobalServices } from "./global-services.js";
import { loadMessages } from "./i18n/i18n.js";
import { USER_CHANGED_EVENT, isAdmin, loadSession } from "./session.js";

async function init(): Promise<void> {
  await loadMessages();
  await ensureCsrfToken();
  await loadSession();
  await loadGlobalServices();

  // Screen-lock overlay is always present (handles lock screen + user switching).
  if (!document.querySelector("screen-lock"))
    document.body.appendChild(document.createElement("screen-lock"));

  if (isAdmin()) {
    if (!document.querySelector("admin-app"))
      document.body.appendChild(document.createElement("admin-app"));
  } else {
    if (!document.querySelector("user-shell"))
      document.body.appendChild(document.createElement("user-shell"));
  }

  // Any role switch (user ↔ admin) requires a full re-init.
  window.addEventListener(USER_CHANGED_EVENT, (e) => {
    const newUser  = (e as CustomEvent<string>).detail;
    const wasAdmin = isAdmin();
    if (newUser === "admin" || wasAdmin) window.location.reload();
  });
}

void init();
