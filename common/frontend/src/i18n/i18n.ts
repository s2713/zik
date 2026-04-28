export const SUPPORTED_LANGS = ["en", "fr"] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

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
}

export function getLanguage(): Lang {
  return _lang;
}

/** Return the translation for msgId in the current language, falling back to msgId itself. */
export function t(msgId: string): string {
  return _messages[msgId]?.[_lang] ?? msgId;
}