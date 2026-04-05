import type { TextMapResult, TextNodeEntry, ResolvedHighlightSettings } from '../lib/types';
import { buildTextNodeMap } from './dom-mapper';
import { createRangeFromOffsets } from './utils';
import { injectHighlightStyles, updateHighlightStyles, removeHighlightStyles } from './styles';
import { scrollToHighlight } from './auto-scroll';

/**
 * Manages word and sentence highlighting on the page.
 *
 * Uses the CSS Custom Highlight API (CSS.highlights) — Electron always supports it.
 * Highlight names use the recito- prefix.
 */
export class HighlightManager {
  private textMap: TextMapResult | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private wordHighlight: Highlight | null = null;
  private sentenceHighlight: Highlight | null = null;
  private scrubHoverHighlight: Highlight | null = null;
  private settings: ResolvedHighlightSettings;

  constructor(settings: ResolvedHighlightSettings) {
    this.settings = settings;
  }

  /**
   * Build the text-node map for the given source element and inject styles.
   */
  init(sourceElement: Element): void {
    this.textMap = buildTextNodeMap(sourceElement);
    this.styleEl = injectHighlightStyles(this.settings);

    this.wordHighlight = new Highlight();
    this.wordHighlight.priority = 2;
    this.sentenceHighlight = new Highlight();
    this.sentenceHighlight.priority = 0;
    this.scrubHoverHighlight = new Highlight();
    this.scrubHoverHighlight.priority = 1;
    CSS.highlights.set('recito-word', this.wordHighlight);
    CSS.highlights.set('recito-sentence', this.sentenceHighlight);
    CSS.highlights.set('recito-scrub-hover', this.scrubHoverHighlight);
  }

  /**
   * Highlight a single word by character offsets.
   */
  highlightWord(charStart: number, charEnd: number): void {
    if (!this.textMap || !this.settings.wordEnabled) return;

    this.clearWordHighlight();

    const range = createRangeFromOffsets(this.textMap.entries, charStart, charEnd);
    if (!range) return;

    this.wordHighlight?.add(range);

    if (this.settings.autoScroll) {
      scrollToHighlight(range);
    }
  }

  /**
   * Highlight a sentence by character offsets.
   */
  highlightSentence(charStart: number, charEnd: number): void {
    if (!this.textMap || !this.settings.sentenceEnabled) return;

    this.clearSentenceHighlight();

    const range = createRangeFromOffsets(this.textMap.entries, charStart, charEnd);
    if (!range) return;

    this.sentenceHighlight?.add(range);
  }

  clearWordHighlight(): void {
    this.wordHighlight?.clear();
  }

  clearSentenceHighlight(): void {
    this.sentenceHighlight?.clear();
  }

  /**
   * Highlight a sentence/chunk for the scrub hover effect.
   */
  highlightScrubHover(charStart: number, charEnd: number): void {
    if (!this.textMap) return;

    this.clearScrubHover();

    const range = createRangeFromOffsets(this.textMap.entries, charStart, charEnd);
    if (!range) return;

    this.scrubHoverHighlight?.add(range);
  }

  clearScrubHover(): void {
    this.scrubHoverHighlight?.clear();
  }

  /**
   * Return the text node entries for external offset mapping.
   */
  getEntries(): TextNodeEntry[] {
    return this.textMap?.entries ?? [];
  }

  /**
   * Return the concatenated plain text from the DOM text node map.
   */
  getFullText(): string {
    if (!this.textMap) return '';
    return this.textMap.text;
  }

  clearAll(): void {
    this.clearWordHighlight();
    this.clearSentenceHighlight();
    this.clearScrubHover();
  }

  updateColors(settings: ResolvedHighlightSettings): void {
    this.settings = settings;
    if (this.styleEl) {
      updateHighlightStyles(this.styleEl, settings);
    }
  }

  destroy(): void {
    this.clearAll();

    CSS.highlights.delete('recito-word');
    CSS.highlights.delete('recito-sentence');
    CSS.highlights.delete('recito-scrub-hover');

    this.wordHighlight = null;
    this.sentenceHighlight = null;
    this.scrubHoverHighlight = null;
    this.textMap = null;

    if (this.styleEl) {
      removeHighlightStyles(this.styleEl);
      this.styleEl = null;
    }
  }
}
