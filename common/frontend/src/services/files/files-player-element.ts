import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { getCsrfHeaders } from "../../csrf.js";
import { t } from "../../i18n/i18n.js";
import { FilesPlayer, type FileTrack, type FilesPlayerState } from "./files-player.js";

type SortKey = "artist" | "album" | "title" | "genre" | "year";
const SORT_KEYS: SortKey[] = ["artist", "album", "title", "genre", "year"];

/**
 * Files service player element.
 * Shows a sortable library list and a now-playing strip with seek/volume controls.
 */
@customElement("files-player")
export class FilesPlayerElement extends LitElement {
  static styles = css`
    :host { display: block; font-family: sans-serif; padding: 1rem; max-width: 700px; }
    h3 { margin: 0 0 0.5rem; }
    .toolbar { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.5rem; }
    .sort-label { font-size: 0.85em; color: #555; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9em; margin-bottom: 1rem; }
    th { text-align: left; border-bottom: 2px solid #ccc; padding: 0.25rem 0.4rem; }
    td { padding: 0.2rem 0.4rem; border-bottom: 1px solid #eee; }
    tr.playing td { background: #e8f4ff; font-weight: bold; }
    tr:hover td { background: #f5f5f5; cursor: pointer; }
    .empty { color: #888; font-size: 0.9em; margin: 1rem 0; }
    .now-playing { border-top: 2px solid #ccc; padding-top: 0.75rem; }
    .np-title { font-weight: bold; margin-bottom: 0.2rem; }
    .np-sub { font-size: 0.85em; color: #555; margin-bottom: 0.4rem; }
    .seek { width: 100%; margin-bottom: 0.5rem; }
    .ctrls { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
    .vol { display: flex; align-items: center; gap: 0.5rem; }
    .vol input { width: 120px; }
    .time { font-size: 0.8em; color: #555; font-variant-numeric: tabular-nums; }
  `;

  private readonly _player = new FilesPlayer();

  private readonly _onStateChange = (e: Event): void => {
    this._ps = (e as CustomEvent<FilesPlayerState>).detail;
  };

  @state() private _ps: FilesPlayerState = { ...this._player.state };
  @state() private _tracks: FileTrack[] = [];
  @state() private _sort: SortKey = "artist";

  override connectedCallback(): void {
    super.connectedCallback();
    this._player.addEventListener("statechange", this._onStateChange);
    void this._fetchTracks();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._player.removeEventListener("statechange", this._onStateChange);
    this._player.stop();
  }

  // ---- control handlers ----

  private _playTrack(track: FileTrack): void {
    const url = `/api/files/audio/${track.id}`;
    this._player.play(track, url);
    void this._postCommand("Play", track);
  }

  private _pause(): void {
    this._player.pause();
    void this._postCommand("Pause");
  }

  private _resume(): void {
    this._player.resume();
    void this._postCommand("Play");
  }

  private _stop(): void {
    this._player.stop();
    void this._postCommand("Stop");
  }

  private _onSeek(e: Event): void {
    this._player.seek(Number((e.target as HTMLInputElement).value));
    void this._postCommand("Seek");
  }

  private _onVolume(e: Event): void {
    this._player.setVolume(Number((e.target as HTMLInputElement).value) / 100);
    void this._postCommand("SetVolume");
  }

  private async _scan(): Promise<void> {
    try {
      await fetch("/api/files/scan", {
        method: "POST",
        headers: { ...getCsrfHeaders() },
      });
      // Small delay so the background task can finish before we re-fetch.
      await new Promise((r) => setTimeout(r, 300));
      await this._fetchTracks();
    } catch { /* backend unavailable */ }
  }

  private async _fetchTracks(): Promise<void> {
    try {
      const r = await fetch(`/api/files/tracks?sort=${this._sort}`);
      this._tracks = await r.json() as FileTrack[];
    } catch { /* backend unavailable */ }
  }

  private async _setSort(sort: SortKey): Promise<void> {
    this._sort = sort;
    await this._fetchTracks();
  }

  // ---- backend sync ----

  private async _postCommand(type: string, track?: FileTrack): Promise<void> {
    const ps = this._player.state;
    const t2 = track ?? ps.track;
    try {
      await fetch("/api/player/command", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({
          type,
          track_id:  t2?.id       ?? "",
          title:     t2?.title    ?? "",
          duration:  t2?.duration ?? 0,
          position:  ps.position,
          volume:    ps.volume,
        }),
      });
    } catch { /* backend unavailable */ }
  }

  // ---- helpers ----

  private _fmt(seconds: number): string {
    const m = String(Math.floor(seconds / 60)).padStart(2, "0");
    const s = String(Math.floor(seconds % 60)).padStart(2, "0");
    return `${m}:${s}`;
  }

  // ---- rendering ----

  override render() {
    const ps = this._ps;
    const playing = ps.status === "playing";
    const active = ps.status !== "stopped";

    return html`
      <h3>${t("service.files")}</h3>

      <div class="toolbar">
        <button @click=${this._scan}>${t("files.scan")}</button>
        <span class="sort-label">${t("files.sort.artist")}:</span>
        ${SORT_KEYS.map((k) => html`
          <button ?disabled=${this._sort === k} @click=${() => void this._setSort(k)}>
            ${t(`files.sort.${k}`)}
          </button>
        `)}
      </div>

      ${this._tracks.length === 0
        ? html`<p class="empty">${t("files.no-tracks")}</p>`
        : html`
          <table>
            <thead>
              <tr>
                <th>${t("files.sort.title")}</th>
                <th>${t("files.sort.artist")}</th>
                <th>${t("files.sort.album")}</th>
                <th>${t("files.sort.year")}</th>
                <th class="time">—</th>
              </tr>
            </thead>
            <tbody>
              ${this._tracks.map((tr) => {
                const isCurrent = ps.track?.id === tr.id;
                return html`
                  <tr class=${isCurrent && active ? "playing" : ""}
                      @click=${() => this._playTrack(tr)}>
                    <td>${tr.title}</td>
                    <td>${tr.artist}</td>
                    <td>${tr.album}</td>
                    <td>${tr.year ?? ""}</td>
                    <td class="time">${this._fmt(tr.duration)}</td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
        `}

      ${active ? html`
        <div class="now-playing">
          <div class="np-title">${t("files.now-playing")}: ${ps.track?.title ?? ""}</div>
          <div class="np-sub">${ps.track?.artist ?? ""} — ${ps.track?.album ?? ""}</div>
          <input class="seek" type="range" min="0" max="${ps.track?.duration ?? 0}"
                 .value=${live(ps.position)} @change=${this._onSeek} />
          <div class="ctrls">
            <button @click=${playing ? this._pause : this._resume}>
              ${playing ? t("player.pause") : t("player.play")}
            </button>
            <button @click=${this._stop}>${t("player.stop")}</button>
          </div>
          <div class="vol">
            <span>${t("player.volume")}</span>
            <input type="range" min="0" max="100"
                   .value=${live(Math.round(ps.volume * 100))} @input=${this._onVolume} />
          </div>
        </div>
      ` : nothing}
    `;
  }
}
