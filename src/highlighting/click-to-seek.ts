import type { TextChunk, TextNodeEntry } from '../lib/types';
import type { HighlightManager } from './highlight-manager';

let manager: HighlightManager | null = null;
let chunks: TextChunk[] = [];
let seekCallback: ((chunkIndex: number) => void) | null = null;
let nodeMap: WeakMap<Text, TextNodeEntry> | null = null;
let lastHoveredChunkIndex = -1;
let rafId = 0;
let isActive = false;

const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, [role="button"], [role="link"]';

/**
 * Set whether click-to-seek is active (i.e. playback is in progress).
 */
export function setClickToSeekActive(active: boolean): void {
  isActive = active;
  if (!active && lastHoveredChunkIndex >= 0) {
    manager?.clearScrubHover();
    const container = manager ? getContainer() : null;
    if (container) container.classList.remove('recito-scrub-active');
    lastHoveredChunkIndex = -1;
  }
}

/**
 * Get the text node and local offset at a screen coordinate.
 */
function getCaretInfo(
  x: number,
  y: number,
): { node: Text; offset: number } | null {
  // caretPositionFromPoint (standard, Chrome 128+)
  if ('caretPositionFromPoint' in document) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos?.offsetNode instanceof Text) {
      return { node: pos.offsetNode, offset: pos.offset };
    }
  }
  // caretRangeFromPoint (WebKit/Blink fallback)
  if ('caretRangeFromPoint' in document) {
    const range = (document as Document & { caretRangeFromPoint(x: number, y: number): Range | null }).caretRangeFromPoint(x, y);
    if (range?.startContainer instanceof Text) {
      return { node: range.startContainer, offset: range.startOffset };
    }
  }
  return null;
}

/**
 * Map a screen coordinate to a chunk index.
 */
function resolveChunkAtPoint(x: number, y: number): number {
  const caret = getCaretInfo(x, y);
  if (!caret || !nodeMap) return -1;

  const entry = nodeMap.get(caret.node);
  if (!entry) return -1;

  const globalOffset = entry.globalStart + caret.offset;

  for (const chunk of chunks) {
    if (globalOffset >= chunk.startOffset && globalOffset < chunk.endOffset) {
      return chunk.index;
    }
  }
  return -1;
}

let boundContainer: HTMLElement | null = null;

function getContainer(): HTMLElement | null {
  return boundContainer;
}

function onMouseMove(e: MouseEvent): void {
  if (rafId) return; // already scheduled
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (!manager || !isActive) {
      if (lastHoveredChunkIndex >= 0) {
        manager?.clearScrubHover();
        if (boundContainer) boundContainer.classList.remove('recito-scrub-active');
        lastHoveredChunkIndex = -1;
      }
      return;
    }

    const chunkIndex = resolveChunkAtPoint(e.clientX, e.clientY);

    if (chunkIndex < 0) {
      if (lastHoveredChunkIndex >= 0) {
        manager.clearScrubHover();
        if (boundContainer) boundContainer.classList.remove('recito-scrub-active');
        lastHoveredChunkIndex = -1;
      }
      return;
    }

    if (chunkIndex === lastHoveredChunkIndex) return;

    lastHoveredChunkIndex = chunkIndex;
    const chunk = chunks[chunkIndex];
    if (chunk) {
      manager.highlightScrubHover(chunk.startOffset, chunk.endOffset);
      if (boundContainer) boundContainer.classList.add('recito-scrub-active');
    }
  });
}

function onClick(e: MouseEvent): void {
  if (!manager || !seekCallback || !isActive) return;
  if (e.defaultPrevented) return;

  // Don't intercept clicks on interactive elements
  const target = e.target as Element | null;
  if (target?.closest(INTERACTIVE_SELECTOR)) return;

  const chunkIndex = resolveChunkAtPoint(e.clientX, e.clientY);
  if (chunkIndex < 0) return;

  e.preventDefault();
  manager.clearScrubHover();
  if (boundContainer) boundContainer.classList.remove('recito-scrub-active');
  lastHoveredChunkIndex = -1;
  seekCallback(chunkIndex);
}

export function initClickToSeek(
  container: HTMLElement,
  highlightManager: HighlightManager,
  textChunks: TextChunk[],
  onSeek: (chunkIndex: number) => void,
): void {
  destroyClickToSeek();

  boundContainer = container;
  manager = highlightManager;
  chunks = textChunks;
  seekCallback = onSeek;

  // Build WeakMap for O(1) text node → entry lookup
  nodeMap = new WeakMap<Text, TextNodeEntry>();
  for (const entry of highlightManager.getEntries()) {
    nodeMap.set(entry.node, entry);
  }

  container.addEventListener('mousemove', onMouseMove, { passive: true });
  container.addEventListener('click', onClick, true);
}

export function destroyClickToSeek(): void {
  if (boundContainer) {
    boundContainer.removeEventListener('mousemove', onMouseMove);
    boundContainer.removeEventListener('click', onClick, true);
    boundContainer.classList.remove('recito-scrub-active');
    boundContainer = null;
  }

  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  manager?.clearScrubHover();

  manager = null;
  chunks = [];
  seekCallback = null;
  nodeMap = null;
  lastHoveredChunkIndex = -1;
  isActive = false;
}
