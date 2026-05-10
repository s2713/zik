/** Typed fetch wrappers for the playlists backend API. */

import { getCsrfHeaders } from "../../csrf.js";
import type { QueueItem } from "../../queue/queue-item.js";
import type { Playlist, PlaylistDetail, PlaylistEntry, PlaylistExport } from "./playlist.js";

const BASE = "/api/playlists";

/** Convert a QueueItem (camelCase) to the PlaylistEntry fields expected by the backend (snake_case). */
export function queueItemToEntry(item: QueueItem): Partial<PlaylistEntry> {
  const e: Partial<PlaylistEntry> = {
    service_id: item.serviceId,
    track_id:   item.trackId,
    audio_url:  item.audioUrl,
    title:      item.title,
    artist:     item.artist,
    album:      item.album,
    duration:   item.duration,
  };
  if (item.artUrl) e.art_url = item.artUrl;
  return e;
}

/** Convert a stored PlaylistEntry (snake_case) to the shared QueueItem (camelCase). */
export function entryToQueueItem(e: PlaylistEntry): QueueItem {
  const item: QueueItem = {
    serviceId: e.service_id,
    trackId:   e.track_id,
    audioUrl:  e.audio_url,
    title:     e.title,
    artist:    e.artist,
    album:     e.album,
    duration:  e.duration,
  };
  if (e.art_url) item.artUrl = e.art_url;
  return item;
}

/** List all playlists for the logged-in user. */
export async function listPlaylists(): Promise<Playlist[]> {
  const r = await fetch(BASE);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json() as Promise<Playlist[]>;
}

/** Create a new empty playlist. */
export async function createPlaylist(name: string): Promise<Playlist> {
  const r = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json", ...getCsrfHeaders() },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json() as Promise<Playlist>;
}

/** Fetch one playlist with its full track list. */
export async function getPlaylist(id: string): Promise<PlaylistDetail> {
  const r = await fetch(`${BASE}/${id}`);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json() as Promise<PlaylistDetail>;
}

/** Rename a playlist. */
export async function renamePlaylist(id: string, name: string): Promise<void> {
  await fetch(`${BASE}/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...getCsrfHeaders() },
    body: JSON.stringify({ name }),
  });
}

/** Delete a playlist and all its tracks. */
export async function deletePlaylist(id: string): Promise<void> {
  await fetch(`${BASE}/${id}`, { method: "DELETE", headers: getCsrfHeaders() });
}

/** Append tracks to a playlist; returns new total track count. */
export async function addTracks(
  id: string,
  tracks: Partial<PlaylistEntry>[],
): Promise<number> {
  const r = await fetch(`${BASE}/${id}/tracks`, {
    method: "POST",
    headers: { "content-type": "application/json", ...getCsrfHeaders() },
    body: JSON.stringify(tracks),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  const d = (await r.json()) as { track_count: number };
  return d.track_count;
}

/** Remove the track at *position* (0-based). */
export async function removeTrack(id: string, position: number): Promise<void> {
  await fetch(`${BASE}/${id}/tracks/${position}`, {
    method: "DELETE",
    headers: getCsrfHeaders(),
  });
}

/** Reorder tracks: move fromPositions to just before toPosition. */
export async function reorderTracks(
  id: string,
  fromPositions: number[],
  toPosition: number,
): Promise<void> {
  await fetch(`${BASE}/${id}/reorder`, {
    method: "POST",
    headers: { "content-type": "application/json", ...getCsrfHeaders() },
    body: JSON.stringify({ from_positions: fromPositions, to_position: toPosition }),
  });
}

/** Mark the playlist as played now. */
export async function touchLastPlayed(id: string): Promise<void> {
  await fetch(`${BASE}/${id}/last-played`, {
    method: "POST",
    headers: getCsrfHeaders(),
  });
}

/** Create a playlist from an exported JSON structure. */
export async function importPlaylist(data: PlaylistExport): Promise<Playlist> {
  const r = await fetch(`${BASE}/import`, {
    method: "POST",
    headers: { "content-type": "application/json", ...getCsrfHeaders() },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json() as Promise<Playlist>;
}

/** Return the URL that triggers a browser file download for a playlist export. */
export function exportUrl(id: string): string {
  return `${BASE}/${id}/export`;
}
