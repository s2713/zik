/** A single entry in the shared cross-service play queue. */
export interface QueueItem {
  serviceId: string;   // "files" | "subsonic" | "podcast" | …
  trackId:   string;   // service-specific identifier
  audioUrl:  string;   // pre-built stream URL (may contain credentials for Subsonic)
  artUrl?:   string;   // album art URL, if available
  title:     string;
  artist:    string;
  album:     string;
  duration:  number;   // seconds
}

/**
 * "ok"                 — playable
 * "error-disconnected" — service auth failure (HTTP 401/403 or cross-origin error)
 * "error-missing"      — file/track not found (HTTP 404 or similar)
 */
export type QueueItemState = "ok" | "error-disconnected" | "error-missing";

/** QueueItem as stored inside the controller — adds runtime-only fields. */
export type QueueItemEx = QueueItem & {
  uid:   number;          // stable client-side key
  state: QueueItemState;
};

/** Payload of the "queue-state" CustomEvent dispatched by QueueController. */
export interface QueueStateDetail {
  items:  QueueItemEx[];
  index:  number;          // -1 when nothing loaded
  status: "playing" | "paused" | "stopped" | "suspended";
  normalizeOn:      boolean;
  normalizeBlocked: boolean;
  volume:           number;
}
