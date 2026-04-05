const MANUAL_SCROLL_PAUSE_MS = 5000;

let enabled = true;
let paused = false;
let pauseTimer: ReturnType<typeof setTimeout> | null = null;
let scrollContainer: HTMLElement | null = null;
let boundOnWheel: (() => void) | null = null;
let boundOnTouch: (() => void) | null = null;

function onManualScroll(): void {
  if (!enabled) return;
  paused = true;
  if (pauseTimer !== null) clearTimeout(pauseTimer);
  pauseTimer = setTimeout(() => {
    paused = false;
    pauseTimer = null;
  }, MANUAL_SCROLL_PAUSE_MS);
}

/**
 * Start listening for manual scroll events so we can pause auto-scroll.
 * @param container - The scrollable container element to scroll within.
 */
export function initAutoScroll(container: HTMLElement): void {
  destroyAutoScroll();
  enabled = true;
  paused = false;
  scrollContainer = container;
  boundOnWheel = onManualScroll;
  boundOnTouch = onManualScroll;
  container.addEventListener('wheel', boundOnWheel, { passive: true });
  container.addEventListener('touchmove', boundOnTouch, { passive: true });
}

/**
 * Smooth-scroll so the highlighted range is visible near the center of the container.
 */
export function scrollToHighlight(range: Range): void {
  if (!enabled || paused || !scrollContainer) return;

  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return;

  const containerRect = scrollContainer.getBoundingClientRect();
  const containerHeight = containerRect.height;

  // Position of range relative to the container
  const relativeTop = rect.top - containerRect.top;
  const relativeBottom = rect.bottom - containerRect.top;

  // If already visible in the middle 60% of the container, skip scroll
  const topThreshold = containerHeight * 0.2;
  const bottomThreshold = containerHeight * 0.8;
  if (relativeTop >= topThreshold && relativeBottom <= bottomThreshold) return;

  const targetScrollTop =
    scrollContainer.scrollTop + relativeTop - containerHeight / 2 + rect.height / 2;
  scrollContainer.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
}

/**
 * Smooth-scroll to center a given element within the container.
 */
export function scrollToElement(element: Element): void {
  if (!enabled || paused) return;
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export function pauseAutoScroll(): void {
  paused = true;
}

export function resumeAutoScroll(): void {
  paused = false;
  if (pauseTimer !== null) {
    clearTimeout(pauseTimer);
    pauseTimer = null;
  }
}

/**
 * Remove event listeners and reset state.
 */
export function destroyAutoScroll(): void {
  if (scrollContainer) {
    if (boundOnWheel) {
      scrollContainer.removeEventListener('wheel', boundOnWheel);
    }
    if (boundOnTouch) {
      scrollContainer.removeEventListener('touchmove', boundOnTouch);
    }
  }
  boundOnWheel = null;
  boundOnTouch = null;
  scrollContainer = null;
  if (pauseTimer !== null) {
    clearTimeout(pauseTimer);
    pauseTimer = null;
  }
  paused = false;
  enabled = false;
}
