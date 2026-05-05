import type { ReactiveController, ReactiveControllerHost } from "lit";

import { LANG_CHANGE_EVENT } from "./i18n.js";

/**
 * Reactive controller that triggers a host re-render whenever the active
 * language changes. Add one instance to each LitElement that calls t():
 *
 *   private readonly _lang = new LangController(this);
 */
export class LangController implements ReactiveController {
  private readonly _host: ReactiveControllerHost;
  private readonly _handler = (): void => { this._host.requestUpdate(); };

  constructor(host: ReactiveControllerHost) {
    this._host = host;
    host.addController(this);
  }

  hostConnected(): void {
    window.addEventListener(LANG_CHANGE_EVENT, this._handler);
  }

  hostDisconnected(): void {
    window.removeEventListener(LANG_CHANGE_EVENT, this._handler);
  }
}
