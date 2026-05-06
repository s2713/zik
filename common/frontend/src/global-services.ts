/** Cache of per-service global enable flags fetched from /api/services/global. */
let _enabled: Record<string, boolean> = {};

/** Fetch the global service enable map; called once at startup. */
export async function loadGlobalServices(): Promise<void> {
  try {
    const r = await fetch("/api/services/global");
    _enabled = (await r.json()) as Record<string, boolean>;
  } catch { /* default: all enabled */ }
}

/** True if the service is globally enabled (defaults to true when not loaded). */
export function isGloballyEnabled(serviceId: string): boolean {
  return _enabled[serviceId] !== false;
}
