/**
 * Client-side session state: tracks which demo user is active and whether
 * the current user is admin. All localStorage keys that are per-user must
 * be scoped with currentUser().
 */

/** Event dispatched on window when the active user changes. */
export const USER_CHANGED_EVENT = "zik-user-changed";

let _currentUser = "guest";
let _isAdmin     = false;

/** Returns the currently active demo username. */
export function currentUser(): string {
  return _currentUser;
}

/** Returns true if the current session belongs to the admin. */
export function isAdmin(): boolean {
  return _isAdmin;
}

/** Updates the active user and fires USER_CHANGED_EVENT on window. */
export function setCurrentUser(name: string): void {
  _currentUser = name;
  window.dispatchEvent(new CustomEvent(USER_CHANGED_EVENT, { detail: name }));
}

/** Fetches the current session from the backend and initialises module state. */
export async function loadSession(): Promise<void> {
  try {
    const res  = await fetch("/api/session");
    const data = (await res.json()) as { user: string | null; is_admin: boolean };
    _currentUser = data.user     ?? "guest";
    _isAdmin     = data.is_admin ?? false;
  } catch {
    _currentUser = "guest";
    _isAdmin     = false;
  }
}

/** Returns the list of available demo users from the backend (excludes admin). */
export async function listUsers(): Promise<string[]> {
  try {
    const res = await fetch("/api/users");
    return (await res.json()) as string[];
  } catch {
    return [];
  }
}
