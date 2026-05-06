export const SUPPORTED_LANGS = ["en", "fr"] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

/** Fired on window whenever the active language changes. */
export const LANG_CHANGE_EVENT = "zik-lang-changed";

type Messages = Record<string, Record<string, string>>;

let _messages: Messages = {};
let _lang: Lang = (localStorage.getItem("zik-lang") as Lang | null) ?? "en";

export async function loadMessages(): Promise<void> {
  try {
    const response = await fetch("/api/i18n/messages");
    _messages = (await response.json()) as Messages;
  } catch {
    _messages = {};
  }
}

export function setLanguage(lang: Lang): void {
  _lang = lang;
  localStorage.setItem("zik-lang", lang);
  window.dispatchEvent(new CustomEvent(LANG_CHANGE_EVENT, { detail: lang }));
}

export function getLanguage(): Lang {
  return _lang;
}

/** Return the translation for msgId in the current language, falling back to fallback or msgId. */
export function t(msgId: string, fallback?: string): string {
  return _messages[msgId]?.[_lang] ?? fallback ?? msgId;
}