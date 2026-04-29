import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { getCsrfHeaders } from "../../csrf.js";
import { t } from "../../i18n/i18n.js";
import { FilesPlayer, type FileTrack, type FilesPlayerState } from "./files-player.js";

type SortKey = "artist" | "album" | "title" | "genre" | "year";
const SORT_KEYS: SortKey[] = ["artist", "album", "title", "genre", "year"];

interface Source {
  id: string;
  label: string;
  kind: string;
  mounted: boolean;
  config?: Record<string, string>;
}

interface LanForm {
  label: string;
  server: string;
  share: string;
  subpath: string;
  username: string;
  password: string;
}

/**
 * Files service player element.
 * Shows a sources strip (mount/unmount/add LAN), a sortable library table, and a now-playing panel.
 */
@customElement("files-player")
export class FilesPlayerElement extends LitElement {
  static styles = css`
    :host { display: block; font-family: sans-serif; padding: 1rem; max-width: 700px; }
    h3 { margin: 0 0 0.5rem; }

    /* sources strip */
    .sources { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.4rem;
               padding: 0.5rem; background: #f8f8f8; border-radius: 4px; }
    .source { display: flex; align-items: center; gap: 0.4rem; font-size: 0.88em; }
    .source-label { font-weight: 500; }
    .badge { font-size: 0.75em; padding: 0.1em 0.4em; border-radius: 3px; }
    .badge.mounted   { background: #d4edda; color: #155724; }
    .badge.unmounted { background: #f8d7da; color: #721c24; }
    .src-removable { font-size: 0.7em; padding: 0.1em 0.35em; border-radius: 3px;
                     background: #fff3cd; color: #856404; vertical-align: middle; }
    .src-smb { font-size: 0.7em; padding: 0.1em 0.35em; border-radius: 3px;
               background: #cce5ff; color: #004085; vertical-align: middle; }
    .add-lan-btn { font-size: 0.8em; }

    /* add-LAN form */
    .lan-form { background: #f0f8ff; border: 1px solid #b8d4f0; border-radius: 4px;
                padding: 0.75rem; margin-bottom: 0.75rem; }
    .lan-form h4 { margin: 0 0 0.5rem; font-size: 0.9em; }
    .lan-form .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem 0.75rem; }
    .lan-form label { display: flex; flex-direction: column; font-size: 0.82em; gap: 0.15rem; }
    .lan-form input { font-size: 0.9em; padding: 0.2em 0.3em; border: 1px solid #bbb; border-radius: 3px; }
    .lan-form .form-actions { margin-top: 0.5rem; display: flex; gap: 0.4rem; }

    /* toolbar */
    .toolbar { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;
               margin-bottom: 0.5rem; }
    .sort-label { font-size: 0.85em; color: #555; }

    /* track table */
    table { width: 100%; border-collapse: collapse; font-size: 0.9em; margin-bottom: 1rem; }
    th { text-align: left; border-bottom: 2px solid #ccc; padding: 0.25rem 0.4rem; }
    td { padding: 0.2rem 0.4rem; border-bottom: 1px solid #eee; }
    tr.playing td { background: #e8f4ff; font-weight: bold; }
    tr:hover td { background: #f5f5f5; cursor: pointer; }
    .empty { color: #888; font-size: 0.9em; margin: 1rem 0; }
    .time { font-size: 0.8em; color: #555; font-variant-numeric: tabular-nums; }

    /* now-playing panel */
    .now-playing { border-top: 2px solid #ccc; padding-top: 0.75rem; }
    .np-title { font-weight: bold; margin-bottom: 0.2rem; }
    .np-sub { font-size: 0.85em; color: #555; margin-bottom: 0.4rem; }
    .seek { width: 100%; margin-bottom: 0.5rem; }
    .ctrls { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
    .vol { display: flex; align-items: center; gap: 0.5rem; }
    .vol input { width: 120px; }
  `;

  private readonly _player = new FilesPlayer();

  private readonly _onStateChange = (e: Event): void => {
    this._ps = (e as CustomEvent<FilesPlayerState>).detail;
  };

  @state() private _ps: FilesPlayerState = { ...this._player.state };
  @state() private _tracks: FileTrack[] = [];
  @state() private _sort: SortKey = "artist";
  @state() private _sources: Source[] = [];
  @state() private _showAddLan = false;
  @state() private _lanForm: LanForm = {
    label: "", server: "", share: "", subpath: "", username: "", password: "",
  };

  override connectedCallback(): void {
    super.connectedCallback();
    this._player.addEventListener("statechange", this._onStateChange);
    void this._fetchSources();
    void this._fetchTracks();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._player.removeEventListener("statechange", this._onStateChange);
    this._player.stop();
  }

  // ---- source handlers ----

  private async _mount(sourceId: string): Promise<void> {
    try {
      await fetch(`/api/files/sources/${sourceId}/mount`, {
        method: "POST",
        headers: { ...getCsrfHeaders() },
      });
      // Background scan runs server-side; wait briefly then refresh.
      await new Promise((r) => setTimeout(r, 400));
      await this._fetchSources();
      await this._fetchTracks();
    } catch { /* backend unavailable */ }
  }

  private async _unmount(sourceId: string): Promise<void> {
    try {
      await fetch(`/api/files/sources/${sourceId}/unmount`, {
        method: "POST",
        headers: { ...getCsrfHeaders() },
      });
      await this._fetchSources();
      await this._fetchTracks();
    } catch { /* backend unavailable */ }
  }

  private async _addLanSource(): Promise<void> {
    const f = this._lanForm;
    try {
      const r = await fetch("/api/files/lan", {
        method: "POST",
        headers: { "content-type": "application/json", ...getCsrfHeaders() },
        body: JSON.stringify({
          label: f.label, server: f.server, share: f.share,
          subpath: f.subpath, username: f.username, password: f.password,
        }),
      });
      if (r.ok) {
        this._showAddLan = false;
        this._lanForm = { label: "", server: "", share: "", subpath: "", username: "", password: "" };
        await this._fetchSources();
      }
    } catch { /* backend unavailable */ }
  }

  private async _removeLanSource(sourceId: string): Promise<void> {
    try {
      await fetch(`/api/files/lan/${sourceId}`, {
        method: "DELETE",
        headers: { ...getCsrfHeaders() },
      });
      await this._fetchSources();
      await this._fetchTracks();
    } catch { /* backend unavailable */ }
  }

  private async _fetchSources(): Promise<void> {
    try {
      const r = await fetch("/api/files/sources");
      this._sources = await r.json() as Source[];
    } catch { /* backend unavailable */ }
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
      await new Promise((r) => setTimeout(r, 400));
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

  private _sourceKind(sourceId: string): string {
    return this._sources.find((s) => s.id === sourceId)?.kind ?? "";
  }

  private _setLanField(field: keyof LanForm, value: string): void {
    this._lanForm = { ...this._lanForm, [field]: value };
  }

  // ---- rendering ----

  private _renderSourceBadge(sourceId: string) {
    const kind = this._sourceKind(sourceId);
    if (kind === "removable") {
      return html`<span class="src-removable">${t("files.source.removable")}</span>`;
    }
    if (kind === "smb") {
      return html`<span class="src-smb">${t("files.source.smb")}</span>`;
    }
    return nothing;
  }

  override render() {
    const ps = this._ps;
    const playing = ps.status === "playing";
    const active = ps.status !== "stopped";

    return html`
      <h3>${t("service.files")}</h3>

      <!-- sources strip -->
      ${this._sources.length > 0 ? html`
        <div class="sources">
          <strong style="font-size:0.88em">${t("files.sources")}:</strong>
          ${this._sources.map((src) => html`
            <div class="source">
              <span class="source-label">${src.label}</span>
              <span class="badge ${src.mounted ? "mounted" : "unmounted"}">
                ${src.mounted ? t("files.mounted") : t("files.unmounted")}
              </span>
              ${src.kind === "removable" || src.kind === "smb" ? html`
                <button @click=${src.mounted
                  ? () => void this._unmount(src.id)
                  : () => void this._mount(src.id)}>
                  ${src.mounted ? t("files.unmount") : t("files.mount")}
                </button>
              ` : nothing}
              ${src.kind === "smb" ? html`
                <button @click=${() => void this._removeLanSource(src.id)}>
                  ${t("files.lan.remove")}
                </button>
              ` : nothing}
            </div>
          `)}
          <button class="add-lan-btn"
                  @click=${() => { this._showAddLan = !this._showAddLan; }}>
            ${t("files.lan.add")}
          </button>
        </div>
      ` : nothing}

      <!-- add-LAN form (collapsible) -->
      ${this._showAddLan ? html`
        <div class="lan-form">
          <h4>${t("files.lan.add")}</h4>
          <div class="fields">
            <label>
              ${t("files.lan.label")}
              <input type="text" .value=${this._lanForm.label}
                     @input=${(e: Event) => this._setLanField("label", (e.target as HTMLInputElement).value)} />
            </label>
            <label>
              ${t("files.lan.server")}
              <input type="text" .value=${this._lanForm.server}
                     @input=${(e: Event) => this._setLanField("server", (e.target as HTMLInputElement).value)} />
            </label>
            <label>
              ${t("files.lan.share")}
              <input type="text" .value=${this._lanForm.share}
                     @input=${(e: Event) => this._setLanField("share", (e.target as HTMLInputElement).value)} />
            </label>
            <label>
              ${t("files.lan.subpath")}
              <input type="text" .value=${this._lanForm.subpath}
                     @input=${(e: Event) => this._setLanField("subpath", (e.target as HTMLInputElement).value)} />
            </label>
            <label>
              ${t("files.lan.username")}
              <input type="text" autocomplete="username" .value=${this._lanForm.username}
                     @input=${(e: Event) => this._setLanField("username", (e.target as HTMLInputElement).value)} />
            </label>
            <label>
              ${t("files.lan.password")}
              <input type="password" autocomplete="current-password" .value=${this._lanForm.password}
                     @input=${(e: Event) => this._setLanField("password", (e.target as HTMLInputElement).value)} />
            </label>
          </div>
          <div class="form-actions">
            <button @click=${() => void this._addLanSource()}>${t("files.lan.submit")}</button>
            <button @click=${() => { this._showAddLan = false; }}>${t("files.lan.cancel")}</button>
          </div>
        </div>
      ` : nothing}

      <!-- sort toolbar -->
      <div class="toolbar">
        <button @click=${this._scan}>${t("files.scan")}</button>
        <span class="sort-label">${t("files.sort.artist")}:</span>
        ${SORT_KEYS.map((k) => html`
          <button ?disabled=${this._sort === k} @click=${() => void this._setSort(k)}>
            ${t(`files.sort.${k}`)}
          </button>
        `)}
      </div>

      <!-- track list -->
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
                const sid = (tr as unknown as Record<string, string>)["source_id"];
                return html`
                  <tr class=${isCurrent && active ? "playing" : ""}
                      @click=${() => this._playTrack(tr)}>
                    <td>
                      ${tr.title}
                      ${this._renderSourceBadge(sid)}
                    </td>
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

      <!-- now-playing panel -->
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
