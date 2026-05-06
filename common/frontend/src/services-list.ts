/** Shared service definitions — used by the user shell and the admin UI. */
export interface ServiceDef {
  tag:     string;   // custom-element tag name
  id:      string;   // short key used in backend / localStorage
  i18nKey: string;   // i18n message key for the display label
}

export const SERVICES: ServiceDef[] = [
  { tag: "demo-player",     id: "demo",     i18nKey: "service.demo"     },
  { tag: "files-player",    id: "files",    i18nKey: "service.files"    },
  { tag: "mpd-player",      id: "mpd",      i18nKey: "service.mpd"      },
  { tag: "subsonic-player", id: "subsonic", i18nKey: "service.subsonic" },
  { tag: "spotify-player",  id: "spotify",  i18nKey: "service.spotify"  },
  { tag: "podcasts-player", id: "podcasts", i18nKey: "service.podcasts" },
  { tag: "radio-player",    id: "radio",    i18nKey: "service.radio"    },
];
