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

/**
 * Service players emit this on playerBus (event name "playlist-state") to give
 * the footer real-time playback and playlist info without going through the backend.
 */
export interface PlaylistStateEvent {
  serviceId: string;
  index: number;          // 0-based current track index; -1 when nothing loaded
  total: number;          // total tracks in playlist
  totalDuration: number;  // sum of all track durations, seconds
  position: number;       // current playback position, seconds
  duration: number;       // current track duration, seconds
}
