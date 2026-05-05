/**
 * Client-side session state: tracks which demo user is active.
 * All localStorage keys that are per-user must be scoped with currentUser().
 */

/** Event dispatched on window when the active user changes. */
export const USER_CHANGED_EVENT = "zik-user-changed";

let _currentUser = "guest";

/** Returns the currently active demo username. */
export function currentUser(): string {
  return _currentUser;
}

/** Updates the active user and fires USER_CHANGED_EVENT on window. */
export function setCurrentUser(name: string): void {
  _currentUser = name;
  window.dispatchEvent(new CustomEvent(USER_CHANGED_EVENT, { detail: name }));
}

/** Fetches the current session from the backend and initialises _currentUser. */
export async function loadSession(): Promise<void> {
  try {
    const res = await fetch("/api/session");
    const data = (await res.json()) as { user: string | null };
    _currentUser = data.user ?? "guest";
  } catch {
    _currentUser = "guest";
  }
}

/** Returns the list of available demo users from the backend. */
export async function listUsers(): Promise<string[]> {
  try {
    const res = await fetch("/api/users");
    return (await res.json()) as string[];
  } catch {
    return [];
  }
}
