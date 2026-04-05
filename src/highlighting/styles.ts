import type { ResolvedHighlightSettings } from '../lib/types';

const STYLE_ID = 'recito-highlight-styles';

/**
 * Inject a <style> element with highlight CSS rules.
 * Uses CSS Custom Highlight API pseudo-elements with recito- prefixed names.
 */
export function injectHighlightStyles(settings: ResolvedHighlightSettings): HTMLStyleElement {
  // Remove existing style if present
  const existing = document.getElementById(STYLE_ID);
  if (existing) existing.remove();

  const styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent = buildCSS(settings);
  document.head.appendChild(styleEl);
  return styleEl;
}

/**
 * Update the CSS within an existing style element when settings change.
 */
export function updateHighlightStyles(
  styleEl: HTMLStyleElement,
  settings: ResolvedHighlightSettings,
): void {
  styleEl.textContent = buildCSS(settings);
}

/**
 * Remove the injected style element.
 */
export function removeHighlightStyles(styleEl: HTMLStyleElement): void {
  styleEl.remove();
}

/**
 * Parse an rgba/rgb color string and derive accent colors for underline and glow.
 */
function deriveAccentColors(rgbaColor: string): { underline: string; glow: string } {
  const match = rgbaColor.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (!match) {
    return { underline: rgbaColor, glow: rgbaColor };
  }
  const [, r, g, b] = match;
  return {
    underline: `rgba(${r}, ${g}, ${b}, 0.7)`,
    glow: `rgba(${r}, ${g}, ${b}, 0.25)`,
  };
}

function buildCSS(settings: ResolvedHighlightSettings): string {
  const wordAccent = deriveAccentColors(settings.wordColor);

  return `
/* CSS Custom Highlight API styles */
::highlight(recito-word) {
  background-color: ${settings.wordColor};
  text-shadow: 0 0 8px ${wordAccent.glow};
}
::highlight(recito-sentence) {
  background-color: ${settings.sentenceColor};
}

/* Scrub hover (interactive text navigation) */
::highlight(recito-scrub-hover) {
  background-color: rgba(0, 0, 0, 0.06);
}

/* Cursor when hovering over scrubbable text */
.recito-scrub-active { cursor: pointer; }
`;
}
