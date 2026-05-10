/** Service card icon definitions: accent colour + inline SVG logo (white on colour). */

import { html } from "lit";
import type { TemplateResult } from "lit";

export interface ServiceIcon {
  color: string;        // card background colour
  svg:   TemplateResult;
}

// All SVGs use viewBox="0 0 100 100"; shapes are white on the card accent colour.
export const SERVICE_ICONS: Record<string, ServiceIcon> = {

  demo: {
    color: "#7c3aed",
    svg: html`<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <polygon points="24,18 24,82 83,50" fill="white" opacity="0.92"/>
    </svg>`,
  },

  files: {
    color: "#2563eb",
    svg: html`<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <!-- folder tab -->
      <path d="M8,36 L8,27 Q8,21 14,21 L36,21 Q41,21 44,27 L47,33 L8,33 Z"
            fill="white" opacity="0.92"/>
      <!-- folder body -->
      <rect x="8" y="33" width="84" height="50" rx="7" fill="white" opacity="0.92"/>
    </svg>`,
  },

  mpd: {
    color: "#db7093",
    svg: html`<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <!-- equalizer bars, varying heights, bottom-aligned at y=85 -->
      <rect x="11" y="52" width="16" height="33" rx="4" fill="white" opacity="0.90"/>
      <rect x="32" y="28" width="16" height="57" rx="4" fill="white" opacity="0.90"/>
      <rect x="53" y="40" width="16" height="45" rx="4" fill="white" opacity="0.90"/>
      <rect x="74" y="16" width="16" height="69" rx="4" fill="white" opacity="0.90"/>
    </svg>`,
  },

  subsonic: {
    color: "#c71585",
    svg: html`<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <!-- sonar arcs from bottom-centre -->
      <circle cx="50" cy="83" r="7" fill="white"/>
      <path d="M28,67 Q28,43 50,43 Q72,43 72,67"
            stroke="white" stroke-width="8" fill="none" stroke-linecap="round"/>
      <path d="M13,72 Q13,22 50,22 Q87,22 87,72"
            stroke="white" stroke-width="7" fill="none" stroke-linecap="round" opacity="0.60"/>
    </svg>`,
  },

  spotify: {
    color: "#1db954",
    svg: html`<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <!-- three horizontal arcs (simplified Spotify mark) -->
      <path d="M19,36 Q50,24 81,36"
            stroke="white" stroke-width="11" fill="none" stroke-linecap="round"/>
      <path d="M23,55 Q50,45 77,55"
            stroke="white" stroke-width="10" fill="none" stroke-linecap="round"/>
      <path d="M27,74 Q50,66 73,74"
            stroke="white" stroke-width="9"  fill="none" stroke-linecap="round"/>
    </svg>`,
  },

  podcasts: {
    color: "#ea580c",
    svg: html`<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <!-- microphone head -->
      <rect x="35" y="9" width="30" height="48" rx="15" fill="white" opacity="0.92"/>
      <!-- stand arc -->
      <path d="M18,52 Q18,80 50,80 Q82,80 82,52"
            stroke="white" stroke-width="8" fill="none" stroke-linecap="round"/>
      <!-- stem + base -->
      <line x1="50" y1="80" x2="50" y2="93" stroke="white" stroke-width="8" stroke-linecap="round"/>
      <line x1="34" y1="93" x2="66" y2="93" stroke="white" stroke-width="8" stroke-linecap="round"/>
    </svg>`,
  },

  radio: {
    color: "#0d9488",
    svg: html`<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <!-- antenna mast + base -->
      <line x1="50" y1="10" x2="50" y2="76" stroke="white" stroke-width="7" stroke-linecap="round"/>
      <line x1="16" y1="76" x2="84" y2="76" stroke="white" stroke-width="7" stroke-linecap="round"/>
      <!-- signal arcs left -->
      <path d="M36,37 Q24,50 36,63" stroke="white" stroke-width="7" fill="none" stroke-linecap="round"/>
      <path d="M24,26 Q6,50 24,74"  stroke="white" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.55"/>
      <!-- signal arcs right -->
      <path d="M64,37 Q76,50 64,63" stroke="white" stroke-width="7" fill="none" stroke-linecap="round"/>
      <path d="M76,26 Q94,50 76,74"  stroke="white" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.55"/>
    </svg>`,
  },

  playlists: {
    color: "#0f766e",
    svg: html`<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <!-- three playlist lines -->
      <line x1="14" y1="28" x2="66" y2="28" stroke="white" stroke-width="8" stroke-linecap="round" opacity="0.90"/>
      <line x1="14" y1="50" x2="66" y2="50" stroke="white" stroke-width="8" stroke-linecap="round" opacity="0.90"/>
      <line x1="14" y1="72" x2="66" y2="72" stroke="white" stroke-width="8" stroke-linecap="round" opacity="0.90"/>
      <!-- play arrow to the right -->
      <polygon points="76,35 76,65 96,50" fill="white" opacity="0.95"/>
    </svg>`,
  },

};
