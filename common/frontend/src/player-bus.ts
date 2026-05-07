/**
 * Singleton event bus between the footer transport bar and service player elements.
 * Footer dispatches; each player filters by serviceId and calls its own methods.
 */

export type PlayerBusCmd =
  | { type: "Play" | "Pause" | "Stop" | "Next" | "Previous"; serviceId: string | null }
  | { type: "SetVolume"; volume: number; serviceId: string | null };  // volume: 0.0–1.0

/** The bus itself; service players subscribe with addEventListener("cmd", …). */
export const playerBus = new EventTarget();

/** Dispatch a command to whichever service player matches serviceId. */
export function dispatchPlayerCmd(cmd: PlayerBusCmd): void {
  playerBus.dispatchEvent(new CustomEvent<PlayerBusCmd>("cmd", { detail: cmd }));
}
