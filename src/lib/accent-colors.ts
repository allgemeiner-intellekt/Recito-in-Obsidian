import type { HighlightSettings, ResolvedHighlightSettings } from './types';

const DEFAULT_ACCENT = '#3b82f6';

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function highlightColorsFromAccent(hex: string | null): { wordColor: string; sentenceColor: string } {
  const [r, g, b] = hexToRgb(hex ?? DEFAULT_ACCENT);
  return {
    wordColor: `rgba(${r}, ${g}, ${b}, 0.35)`,
    sentenceColor: `rgba(${r}, ${g}, ${b}, 0.08)`,
  };
}

export function resolveHighlightSettings(
  highlight: HighlightSettings,
  accentColor: string | null,
): ResolvedHighlightSettings {
  const accent = highlightColorsFromAccent(accentColor);
  return {
    ...highlight,
    wordColor: highlight.wordColor ?? accent.wordColor,
    sentenceColor: highlight.sentenceColor ?? accent.sentenceColor,
  };
}
