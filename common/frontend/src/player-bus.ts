/**
 * Singleton event bus between the footer transport bar and service player elements.
 * Footer dispatches; each player filters by serviceId and calls its own methods.
 */

import type { QueueItem } from "./queue/queue-item.js";

export type PlayerBusCmd =
  | { type: "Play" | "Pause" | "Stop" | "Next" | "Previous"; serviceId: string | null }
  | { type: "SetVolume"; volume: number; serviceId: string | null }  // volume: 0.0–1.0
  | { type: "SuspendQueue" }  // non-queueable service (e.g. MPD) is taking over audio
  | { type: "PauseAll" }      // pause every active player regardless of serviceId (user switch)
  | { type: "PlaySpotifyTrack"; uri: string; serviceId: "spotify" };  // queue delegates spotify URI

/** The bus itself; service players subscribe with addEventListener("cmd", …). */
export const playerBus = new EventTarget();

/** Dispatch a command to whichever service player matches serviceId. */
export function dispatchPlayerCmd(cmd: PlayerBusCmd): void {
  playerBus.dispatchEvent(new CustomEvent<PlayerBusCmd>("cmd", { detail: cmd }));
}

/**
 * Dispatched on playerBus (event name "selection-state") whenever the active panel's
 * selection changes.  The footer reads it to know what to add to a playlist.
 */
export interface SelectionStateEvent {
  /** Resolved QueueItem list for the current UI selection (empty = no selection). */
  items:  QueueItem[];
  /** Which panel owns the selection: "files" | "subsonic" | "queue" | "playlists" | "". */
  source: string;
}

/**
 * Service players emit this on playerBus (event name "playlist-state") to give
 * the footer real-time playback and playlist info without going through the backend.
 */
export interface PlaylistStateEvent {
  serviceId: string;
  status: "playing" | "paused" | "stopped" | "suspended";
  index: number;          // 0-based current track index; -1 when nothing loaded
  total: number;          // total tracks in playlist
  totalDuration: number;  // sum of all track durations, seconds
  position: number;       // current playback position, seconds
  duration: number;       // current track duration, seconds
}
