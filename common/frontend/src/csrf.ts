const CSRF_COOKIE = "__Host-zik-csrf";

/** Scan document.cookie for the double-submit CSRF token. */
function readCsrfCookie(): string | null {
  for (const part of document.cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === CSRF_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/** GET /api/csrf-token if the cookie is absent; idempotent. */
export async function ensureCsrfToken(): Promise<void> {
  if (!readCsrfCookie()) {
    await fetch("/api/csrf-token");
  }
}

/** Return the x-csrf-token header map for use in POST requests. */
export function getCsrfHeaders(): Record<string, string> {
  return { "x-csrf-token": readCsrfCookie() ?? "" };
}