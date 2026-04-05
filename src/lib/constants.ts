import type { RecitoSettings } from './types';

export const DEFAULT_SETTINGS: RecitoSettings = {
  providers: [],
  activeProviderGroup: null,
  activeVoiceId: null,
  accentColor: null,
  playback: {
    defaultSpeed: 1.0,
    defaultVolume: 1.0,
    bufferSize: 2,
    autoScrollEnabled: true,
  },
  highlight: {
    wordColor: null,
    sentenceColor: null,
    wordEnabled: true,
    sentenceEnabled: true,
    autoScroll: true,
  },
  readingProgress: {},
};

export const ACCENT_COLOR_PRESETS = [
  '#3b82f6', // Blue (default)
  '#8b5cf6', // Violet
  '#ec4899', // Pink
  '#ef4444', // Red
  '#f97316', // Orange
  '#22c55e', // Green
  '#06b6d4', // Cyan
  '#6366f1', // Indigo
];

export const SPEED_PRESETS = [1, 1.25, 1.5, 2];

export interface SpeedRange {
  min: number;
  max: number;
}

export const PROVIDER_SPEED_RANGES: Record<string, SpeedRange | null> = {
  openai: { min: 0.5, max: 2.0 },
  groq: { min: 0.5, max: 2.0 },
  elevenlabs: { min: 0.7, max: 1.2 },
  mimo: null,
  custom: { min: 0.5, max: 2.0 },
};

export const PROGRESS_REPORT_INTERVAL_MS = 100;
export const LOOKAHEAD_BUFFER_SIZE = 2;

export const READING_PROGRESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
