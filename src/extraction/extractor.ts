import type { TextMapResult } from '../lib/types';
import { buildTextNodeMap } from '../highlighting/dom-mapper';

export function extractFromReadingView(containerEl: HTMLElement): TextMapResult | null {
  const readingView = containerEl.querySelector('.markdown-reading-view');
  if (!readingView) return null;

  const previewSection = readingView.querySelector('.markdown-preview-section');
  if (!previewSection) return null;

  const result = buildTextNodeMap(previewSection);
  if (!result.text.trim()) return null;

  return result;
}
