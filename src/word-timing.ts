import type { WordTiming } from './lib/types';

interface SimpleWordTiming {
  word: string;
  startTime: number;
  endTime: number;
}

// State for the current chunk's word timing
let currentChunkIndex = -1;
let currentWords: string[] = [];
let currentWordIndex = 0;
let currentRealTimings: SimpleWordTiming[] | null = null;
let audioDuration = 0;
// Pre-computed cumulative character fractions for weighted interpolation
let cumulativeCharFractions: number[] = [];

// Callback to invoke when a word timing event is ready
let wordTimingCallback: ((timing: WordTiming & { chunkIndex: number; wordIndex: number }) => void) | null = null;

export function startWordTiming(
  chunkIndex: number,
  chunkText: string,
  onWordTiming: (timing: WordTiming & { chunkIndex: number; wordIndex: number }) => void,
  realTimings?: SimpleWordTiming[],
): void {
  stopWordTiming();

  currentChunkIndex = chunkIndex;
  currentWords = chunkText.split(/\s+/).filter(Boolean);
  currentWordIndex = 0;
  audioDuration = 0;
  wordTimingCallback = onWordTiming;

  if (realTimings && realTimings.length > 0) {
    currentRealTimings = realTimings;
  } else {
    currentRealTimings = null;
  }

  // Pre-compute cumulative character fractions for weighted interpolation.
  // Each word's "weight" is its character count, so longer words get more time.
  const totalChars = currentWords.reduce((sum, w) => sum + w.length, 0);
  cumulativeCharFractions = [];
  let cumulative = 0;
  for (const w of currentWords) {
    cumulative += w.length / (totalChars || 1);
    cumulativeCharFractions.push(cumulative);
  }
}

export function stopWordTiming(): void {
  currentChunkIndex = -1;
  currentWords = [];
  currentWordIndex = 0;
  currentRealTimings = null;
  audioDuration = 0;
  cumulativeCharFractions = [];
  wordTimingCallback = null;
}

/**
 * Called by the orchestrator when playback progress is reported.
 * This drives word highlighting in sync with actual audio playback.
 */
export function onPlaybackProgress(
  chunkIndex: number,
  currentTime: number,
  duration: number,
): void {
  if (chunkIndex !== currentChunkIndex || !wordTimingCallback || currentWords.length === 0) {
    return;
  }

  if (duration > 0) {
    audioDuration = duration;
  }

  if (currentRealTimings) {
    // Use real timings — advance words whose startTime has been reached
    while (currentWordIndex < currentRealTimings.length) {
      const timing = currentRealTimings[currentWordIndex];
      if (!timing || timing.startTime > currentTime) break;
      wordTimingCallback({
        chunkIndex: currentChunkIndex,
        wordIndex: currentWordIndex,
        word: timing.word,
        startTime: timing.startTime,
        endTime: timing.endTime,
        charStart: 0,
        charEnd: 0,
      });
      currentWordIndex++;
    }
  } else if (audioDuration > 0) {
    // Interpolate using character-weighted word durations so longer words
    // get proportionally more time (instead of uniform distribution which
    // causes highlighting to race ahead of short words).
    const progress = Math.min(currentTime / audioDuration, 1);

    // Find the expected word index using cumulative character fractions
    let expectedWordIndex = 0;
    for (let i = 0; i < cumulativeCharFractions.length; i++) {
      const frac = cumulativeCharFractions[i];
      if (frac !== undefined && progress < frac) {
        expectedWordIndex = i;
        break;
      }
      expectedWordIndex = i;
    }

    while (currentWordIndex <= expectedWordIndex) {
      const prevFrac = currentWordIndex > 0 ? cumulativeCharFractions[currentWordIndex - 1] : undefined;
      const startFrac = prevFrac ?? 0;
      const endFrac = cumulativeCharFractions[currentWordIndex] ?? 1;
      const word = currentWords[currentWordIndex];
      if (word === undefined) break;
      wordTimingCallback({
        chunkIndex: currentChunkIndex,
        wordIndex: currentWordIndex,
        word,
        startTime: startFrac * audioDuration,
        endTime: endFrac * audioDuration,
        charStart: 0,
        charEnd: 0,
      });
      currentWordIndex++;
    }
  }
}
