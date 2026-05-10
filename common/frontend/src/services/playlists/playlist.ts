/** Data types for the cross-service playlists feature. */

export interface Playlist {
  id:             string;
  name:           string;
  owner:          string;
  created_at:     string;
  updated_at:     string;
  last_played_at: string | null;
  track_count:    number;
}

export interface PlaylistEntry {
  playlist_id: string;
  position:    number;
  service_id:  string;
  track_id:    string;
  audio_url:   string;
  art_url:     string;
  title:       string;
  artist:      string;
  album:       string;
  duration:    number;
  added_at:    string;
}

export interface PlaylistDetail extends Playlist {
  tracks: PlaylistEntry[];
}

/** Portable export/import format (version 1). */
export interface PlaylistExport {
  version:     1;
  name:        string;
  exported_at: string;
  tracks:      Omit<PlaylistEntry, "playlist_id" | "position" | "added_at">[];
}
