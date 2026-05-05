import { LitElement } from "lit";

import { LangController } from "./i18n/lang-controller.js";

/**
 * Base class for all player elements.
 * Attaches a LangController so every render() re-runs when the active
 * language changes (via setLanguage() → "zik-lang-changed" window event).
 * Lit holds the controller reference internally; no class field needed.
 */
export abstract class PlayerBase extends LitElement {
  constructor() {
    super();
    new LangController(this);
  }
}