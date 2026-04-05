# Recito Obsidian Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Immersive Reader Chrome extension's TTS playback with karaoke highlighting to an Obsidian plugin.

**Architecture:** Single-process Electron app. Reading View DOM-based highlighting using CSS Highlight API. Direct Web Audio API for gapless playback. Sidebar `ItemView` for controls. All 5 TTS providers ported from Chrome extension with API key pooling/failover.

**Tech Stack:** TypeScript, Obsidian Plugin API (`ItemView`, `PluginSettingTab`, `Plugin`), Web Audio API, CSS Custom Highlight API, esbuild.

**Chrome extension source reference:** `~/allgemeiner-intellekt/immersive-reader/src/`

---

## File Structure

```
src/
  main.ts                    # Plugin entry — ribbon, commands, lifecycle, wiring
  settings.ts                # PluginSettingTab + RecitoSettings interface + storage helpers
  sidebar.ts                 # ItemView — playback controls, time display, provider status
  orchestrator.ts            # Session management, chunk sequencing, failover, prefetch
  audio-player.ts            # Web Audio API — gapless scheduling, speed/volume, progress callbacks
  word-timing.ts             # Word timing relay — real (ElevenLabs) + interpolated
  highlighting/
    highlight-manager.ts     # CSS Highlight API — word/sentence/scrub ranges
    dom-mapper.ts            # Walk Reading View DOM → TextNodeEntry[]
    auto-scroll.ts           # Scroll to highlighted range, pause on manual scroll
    click-to-seek.ts         # Click handler → resolve chunk index → seek callback
    styles.ts                # Inject/update highlight CSS rules
  extraction/
    extractor.ts             # Walk Reading View DOM, skip non-prose, return TextMapResult
    sentence-splitter.ts     # Split text into SentenceBoundary[]
    chunker.ts               # Group sentences into provider-sized TextChunk[]
  providers/
    registry.ts              # Provider map + getChunkLimits()
    openai.ts                # OpenAI TTS provider
    elevenlabs.ts            # ElevenLabs + /with-timestamps
    groq.ts                  # Groq PlayAI
    mimo.ts                  # Xiaomi Mimo
    custom.ts                # OpenAI-compatible endpoint
    openai-compatible.ts     # Shared URL building + validation
    api-key-format.ts        # Heuristic API key validation
    voice-cache.ts           # In-memory voice list cache (5min TTL)
    failover.ts              # Health tracking, cooldown logic, getNextCandidate()
  lib/
    types.ts                 # All shared TypeScript interfaces
    constants.ts             # Speed ranges, chunk limits, defaults
    api-error.ts             # ApiError class with retry logic
```

---

## Task 1: Shared Types and Constants

**Files:**
- Create: `src/lib/types.ts`
- Create: `src/lib/constants.ts`
- Create: `src/lib/api-error.ts`

Port from Chrome extension: `~/allgemeiner-intellekt/immersive-reader/src/lib/types.ts`, `constants.ts`, `api-error.ts`. Remove Chrome-specific types (`PageInfo`, `ThemeMode`, `ExtractionResult.html`). Add Obsidian-specific settings.

- [ ] **Step 1: Create `src/lib/types.ts`**

```ts
// === Provider Types ===

export interface ProviderConfig {
  id: string;
  providerId: string; // 'openai' | 'elevenlabs' | 'groq' | 'mimo' | 'custom'
  name: string;
  apiKey: string;
  baseUrl?: string;
  extraParams?: Record<string, unknown>;
}

export interface Voice {
  id: string;
  name: string;
  language?: string;
  gender?: string;
  previewUrl?: string;
}

export interface SynthesisResult {
  audioData: ArrayBuffer;
  format: string;
  wordTimings?: WordTiming[];
}

export interface TTSProvider {
  id: string;
  name: string;
  listVoices(config: ProviderConfig): Promise<Voice[]>;
  synthesize(
    text: string,
    voice: Voice,
    config: ProviderConfig,
    options?: SynthesisOptions,
  ): Promise<SynthesisResult>;
  validateKey(config: ProviderConfig): Promise<boolean>;
}

export interface SynthesisOptions {
  speed?: number;
  format?: string;
}

// === Text Extraction Types ===

export interface TextChunk {
  index: number;
  text: string;
  startOffset: number;
  endOffset: number;
  wordCount: number;
}

export interface TextNodeEntry {
  node: Text;
  globalStart: number;
  globalEnd: number;
}

export interface TextMapResult {
  entries: TextNodeEntry[];
  text: string;
}

export interface SentenceBoundary {
  text: string;
  startOffset: number;
  endOffset: number;
}

// === Playback Types ===

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused';

export interface PlaybackState {
  status: PlaybackStatus;
  currentChunkIndex: number;
  totalChunks: number;
  chunkProgress: number;
  currentTime: number;
  duration: number;
  speed: number;
  volume: number;
}

export interface WordTiming {
  word: string;
  startTime: number;
  endTime: number;
  charStart: number;
  charEnd: number;
}

// === Settings Types ===

export interface HighlightSettings {
  wordColor: string | null;
  sentenceColor: string | null;
  wordEnabled: boolean;
  sentenceEnabled: boolean;
  autoScroll: boolean;
}

export interface ResolvedHighlightSettings {
  wordColor: string;
  sentenceColor: string;
  wordEnabled: boolean;
  sentenceEnabled: boolean;
  autoScroll: boolean;
}

export interface PlaybackSettings {
  defaultSpeed: number;
  defaultVolume: number;
  bufferSize: number;
  autoScrollEnabled: boolean;
}

export interface RecitoSettings {
  providers: ProviderConfig[];
  activeProviderGroup: string | null;
  activeVoiceId: string | null;
  playback: PlaybackSettings;
  highlight: HighlightSettings;
  accentColor: string | null;
  readingProgress: Record<string, ReadingProgress>;
}

export interface ReadingProgress {
  notePath: string;
  chunkIndex: number;
  totalChunks: number;
  timestamp: number;
}

export interface ProviderUsage {
  characterCount: number;
  characterLimit: number;
  nextResetUnix: number;
}

// === Failover Types ===

export interface ConfigHealth {
  status: 'healthy' | 'cooldown' | 'failed';
  lastError?: { message: string; status: number; timestamp: number };
  cooldownUntil?: number;
  failCount: number;
}

export interface PlaybackSession {
  config: ProviderConfig;
  voice: Voice;
  providerId: string;
  generation: number;
}
```

- [ ] **Step 2: Create `src/lib/constants.ts`**

```ts
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
```

- [ ] **Step 3: Create `src/lib/api-error.ts`**

```ts
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly providerId: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static fromResponse(status: number, body: string, providerId: string, headers?: Headers): ApiError {
    const retryable = status === 429 || status === 403 || status >= 500;
    let retryAfterMs: number | undefined;
    if (headers) {
      const ra = headers.get('retry-after');
      if (ra) {
        const seconds = parseInt(ra, 10);
        if (!isNaN(seconds)) {
          retryAfterMs = seconds * 1000;
        } else {
          const date = Date.parse(ra);
          if (!isNaN(date)) retryAfterMs = Math.max(0, date - Date.now());
        }
      }
    }
    return new ApiError(body || `HTTP ${status}`, status, providerId, retryable, retryAfterMs);
  }

  static fromNetworkError(err: unknown, providerId: string): ApiError {
    const message = err instanceof Error ? err.message : String(err);
    return new ApiError(`Network error: ${message}`, 0, providerId, true);
  }
}
```

- [ ] **Step 4: Verify the project builds**

Run: `npm run build`
Expected: Build succeeds (unused files don't break esbuild since it only bundles from `main.ts` entrypoint — the new files won't be bundled yet but must be valid TypeScript).

Actually, since esbuild only bundles imports from `main.ts`, just verify no syntax errors:

Run: `npx tsc --noEmit`
Expected: No errors from the new files (they aren't imported yet, so tsc with `include: ["src/**/*.ts"]` will type-check them).

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/constants.ts src/lib/api-error.ts
git commit -m "feat: add shared types, constants, and ApiError class"
```

---

## Task 2: TTS Providers

**Files:**
- Create: `src/providers/openai-compatible.ts`
- Create: `src/providers/api-key-format.ts`
- Create: `src/providers/voice-cache.ts`
- Create: `src/providers/openai.ts`
- Create: `src/providers/elevenlabs.ts`
- Create: `src/providers/groq.ts`
- Create: `src/providers/mimo.ts`
- Create: `src/providers/custom.ts`
- Create: `src/providers/registry.ts`
- Create: `src/providers/failover.ts`

Port directly from Chrome extension. The provider code is pure `fetch()` + types — no Chrome-specific APIs. The only change is import paths.

- [ ] **Step 1: Create `src/providers/openai-compatible.ts`**

```ts
export function buildOpenAICompatibleUrl(baseUrl: string, path: string): string {
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  const baseWithVersion = /\/v1$/i.test(trimmedBaseUrl) ? trimmedBaseUrl : `${trimmedBaseUrl}/v1`;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${baseWithVersion}${normalizedPath}`;
}

export async function validateOpenAICompatibleKey(
  baseUrl: string,
  headers: HeadersInit,
): Promise<boolean> {
  return validateOpenAICompatibleSpeech(baseUrl, headers, {
    model: 'tts-1',
    input: '.',
    voice: 'alloy',
    response_format: 'mp3',
  });
}

export async function validateOpenAICompatibleSpeech(
  baseUrl: string,
  headers: HeadersInit,
  body: Record<string, unknown>,
): Promise<boolean> {
  try {
    const response = await fetch(buildOpenAICompatibleUrl(baseUrl, '/audio/speech'), {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) return false;

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType && !contentType.startsWith('audio/') && !contentType.startsWith('application/octet-stream')) {
      return false;
    }

    const audioData = await response.arrayBuffer().catch(() => null);
    return audioData instanceof ArrayBuffer && audioData.byteLength > 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Create `src/providers/api-key-format.ts`**

```ts
import type { ProviderConfig } from '../lib/types';

function hasPrefixAndLength(apiKey: string, prefix: string, minLength: number): boolean {
  const trimmed = apiKey.trim();
  return trimmed.startsWith(prefix) && trimmed.length >= minLength;
}

export function hasLikelyValidApiKeyFormat(config: ProviderConfig): boolean {
  const apiKey = config.apiKey.trim();
  if (!apiKey) return false;

  switch (config.providerId) {
    case 'openai':
      return hasPrefixAndLength(apiKey, 'sk-', 20);
    case 'groq':
      return hasPrefixAndLength(apiKey, 'gsk_', 20);
    case 'elevenlabs':
    case 'mimo':
      return apiKey.length >= 16;
    case 'custom':
      return apiKey.length >= 3;
    default:
      return apiKey.length >= 8;
  }
}
```

- [ ] **Step 3: Create `src/providers/voice-cache.ts`**

```ts
import type { Voice } from '../lib/types';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  voices: Voice[];
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

export function getCachedVoices(configId: string): Voice[] | null {
  const entry = cache.get(configId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    cache.delete(configId);
    return null;
  }
  return entry.voices;
}

export function setCachedVoices(configId: string, voices: Voice[]): void {
  cache.set(configId, { voices, cachedAt: Date.now() });
}

export function invalidateVoiceCache(configId?: string): void {
  if (configId) {
    cache.delete(configId);
  } else {
    cache.clear();
  }
}
```

- [ ] **Step 4: Create `src/providers/openai.ts`**

```ts
import type { TTSProvider, ProviderConfig, Voice, SynthesisResult, SynthesisOptions } from '../lib/types';
import { buildOpenAICompatibleUrl, validateOpenAICompatibleKey } from './openai-compatible';
import { hasLikelyValidApiKeyFormat } from './api-key-format';
import { ApiError } from '../lib/api-error';

const DEFAULT_BASE_URL = 'https://api.openai.com';

const OPENAI_VOICES: Voice[] = [
  { id: 'alloy', name: 'Alloy' },
  { id: 'echo', name: 'Echo' },
  { id: 'fable', name: 'Fable' },
  { id: 'onyx', name: 'Onyx' },
  { id: 'nova', name: 'Nova' },
  { id: 'shimmer', name: 'Shimmer' },
];

export const openaiProvider: TTSProvider = {
  id: 'openai',
  name: 'OpenAI',

  async listVoices(_config: ProviderConfig): Promise<Voice[]> {
    return OPENAI_VOICES;
  },

  async synthesize(
    text: string,
    voice: Voice,
    config: ProviderConfig,
    options?: SynthesisOptions,
  ): Promise<SynthesisResult> {
    const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    const speed = options?.speed ?? 1.0;
    const format = options?.format ?? 'mp3';

    let response: Response;
    try {
      response = await fetch(buildOpenAICompatibleUrl(baseUrl, '/audio/speech'), {
        signal: AbortSignal.timeout(30_000),
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: text,
          voice: voice.id,
          response_format: format,
          speed,
        }),
      });
    } catch (err) {
      throw ApiError.fromNetworkError(err, 'openai');
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      if (response.status === 401) {
        throw new ApiError('Invalid API key. Please check your OpenAI API key.', 401, 'openai', false);
      }
      if (response.status === 429) {
        throw new ApiError('Rate limit exceeded. Please try again later.', 429, 'openai', true);
      }
      throw ApiError.fromResponse(response.status, errBody || response.statusText, 'openai', response.headers);
    }

    const audioData = await response.arrayBuffer();
    return { audioData, format };
  },

  async validateKey(config: ProviderConfig): Promise<boolean> {
    if (!hasLikelyValidApiKeyFormat(config)) return false;
    const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    return validateOpenAICompatibleKey(baseUrl, {
      'Authorization': `Bearer ${config.apiKey}`,
    });
  },
};
```

- [ ] **Step 5: Create `src/providers/elevenlabs.ts`**

Port from `~/allgemeiner-intellekt/immersive-reader/src/providers/elevenlabs.ts`. Only change: import paths use `../lib/types` and `../lib/api-error` instead of `@shared/...`.

```ts
import type { TTSProvider, ProviderConfig, Voice, SynthesisResult, SynthesisOptions, ProviderUsage, WordTiming } from '../lib/types';
import { hasLikelyValidApiKeyFormat } from './api-key-format';
import { ApiError } from '../lib/api-error';

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';

function getNormalizedBaseUrl(config: ProviderConfig): string {
  return (config.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function getNormalizedApiKey(config: ProviderConfig): string {
  return config.apiKey.trim();
}

function getElevenLabsErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as {
      detail?: string | { message?: string; status?: string };
    };
    if (typeof parsed.detail === 'string') return parsed.detail;
    if (parsed.detail && typeof parsed.detail === 'object') {
      const status = parsed.detail.status?.trim();
      const message = parsed.detail.message?.trim();
      if (status && message) return `${status}: ${message}`;
      return message || status || trimmed;
    }
  } catch { /* not JSON */ }
  return trimmed;
}

interface ElevenLabsAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

function alignmentToWordTimings(text: string, alignment: ElevenLabsAlignment): WordTiming[] {
  const timings: WordTiming[] = [];
  const words = text.split(/\s+/);
  let charIdx = 0;
  let textPos = 0;

  for (const word of words) {
    if (!word) continue;
    const wordStart = text.indexOf(word, textPos);
    if (wordStart < 0) continue;
    textPos = wordStart + word.length;

    while (charIdx < alignment.characters.length && /\s/.test(alignment.characters[charIdx])) {
      charIdx++;
    }

    const startCharIdx = charIdx;
    const endCharIdx = Math.min(charIdx + word.length - 1, alignment.characters.length - 1);
    charIdx += word.length;

    if (startCharIdx < alignment.character_start_times_seconds.length) {
      timings.push({
        word,
        startTime: alignment.character_start_times_seconds[startCharIdx],
        endTime: alignment.character_end_times_seconds[endCharIdx] ??
                 alignment.character_start_times_seconds[startCharIdx] + 0.1,
        charStart: wordStart,
        charEnd: wordStart + word.length,
      });
    }
  }
  return timings;
}

async function synthesizeWithTimestamps(
  baseUrl: string,
  apiKey: string,
  voiceId: string,
  body: Record<string, unknown>,
  originalText: string,
): Promise<SynthesisResult> {
  const response = await fetch(`${baseUrl}/v1/text-to-speech/${voiceId}/with-timestamps`, {
    signal: AbortSignal.timeout(30_000),
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`with-timestamps endpoint failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    audio_base64: string;
    alignment: ElevenLabsAlignment;
  };

  const binary = atob(data.audio_base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const audioData = bytes.buffer;
  const wordTimings = alignmentToWordTimings(originalText, data.alignment);

  return { audioData, format: 'mp3', wordTimings };
}

export const elevenlabsProvider: TTSProvider = {
  id: 'elevenlabs',
  name: 'ElevenLabs',

  async listVoices(config: ProviderConfig): Promise<Voice[]> {
    const baseUrl = getNormalizedBaseUrl(config);
    const apiKey = getNormalizedApiKey(config);
    const response = await fetch(`${baseUrl}/v1/voices`, {
      headers: { 'xi-api-key': apiKey },
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      const detail = getElevenLabsErrorMessage(errBody);
      if (response.status === 401) {
        throw new Error(detail || 'ElevenLabs rejected the API key while loading voices.');
      }
      throw new Error(
        `Failed to fetch ElevenLabs voices (${response.status})${detail ? `: ${detail}` : ''}`,
      );
    }

    const data = await response.json();
    return (data.voices ?? []).map((v: { voice_id: string; name: string; labels?: Record<string, string> }) => ({
      id: v.voice_id,
      name: v.name,
      gender: v.labels?.gender,
      language: v.labels?.language,
    }));
  },

  async synthesize(
    text: string,
    voice: Voice,
    config: ProviderConfig,
    options?: SynthesisOptions,
  ): Promise<SynthesisResult> {
    const baseUrl = getNormalizedBaseUrl(config);
    const apiKey = getNormalizedApiKey(config);
    const format = options?.format ?? 'mp3';
    const speed = options?.speed ?? 1.0;

    const body: Record<string, unknown> = {
      text,
      model_id: (config.extraParams?.model_id as string) ?? DEFAULT_MODEL_ID,
    };
    if (speed !== 1.0) body.speed = speed;
    if (config.extraParams?.stability != null || config.extraParams?.similarity_boost != null) {
      body.voice_settings = {
        stability: config.extraParams.stability ?? 0.5,
        similarity_boost: config.extraParams.similarity_boost ?? 0.75,
      };
    }

    // Try /with-timestamps first
    try {
      return await synthesizeWithTimestamps(baseUrl, apiKey, voice.id, body, text);
    } catch { /* fall back */ }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/text-to-speech/${voice.id}/stream`, {
        signal: AbortSignal.timeout(30_000),
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': `audio/${format}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw ApiError.fromNetworkError(err, 'elevenlabs');
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      const detail = getElevenLabsErrorMessage(errBody);
      if (response.status === 401) {
        throw new ApiError(detail || 'ElevenLabs rejected the API request.', 401, 'elevenlabs', false);
      }
      if (response.status === 429) {
        throw new ApiError('Rate limit exceeded.', 429, 'elevenlabs', true);
      }
      throw ApiError.fromResponse(response.status, detail || response.statusText, 'elevenlabs', response.headers);
    }

    const audioData = await response.arrayBuffer();
    return { audioData, format };
  },

  async validateKey(config: ProviderConfig): Promise<boolean> {
    if (!hasLikelyValidApiKeyFormat(config)) return false;
    const baseUrl = getNormalizedBaseUrl(config);
    const apiKey = getNormalizedApiKey(config);
    try {
      const response = await fetch(`${baseUrl}/v1/voices`, {
        headers: { 'xi-api-key': apiKey },
      });
      return response.status === 200;
    } catch {
      return false;
    }
  },
};

export async function getElevenLabsUsage(config: ProviderConfig): Promise<ProviderUsage> {
  const baseUrl = getNormalizedBaseUrl(config);
  const apiKey = getNormalizedApiKey(config);
  const response = await fetch(`${baseUrl}/v1/user/subscription`, {
    headers: { 'xi-api-key': apiKey },
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Could not fetch usage (HTTP ${response.status}): ${getElevenLabsErrorMessage(errBody)}`);
  }
  const data = (await response.json()) as {
    character_count: number;
    character_limit: number;
    next_character_count_reset_unix: number;
  };
  return {
    characterCount: data.character_count,
    characterLimit: data.character_limit,
    nextResetUnix: data.next_character_count_reset_unix,
  };
}
```

- [ ] **Step 6: Create `src/providers/groq.ts`**

```ts
import type { TTSProvider, ProviderConfig, Voice, SynthesisResult, SynthesisOptions } from '../lib/types';
import { buildOpenAICompatibleUrl, validateOpenAICompatibleSpeech } from './openai-compatible';
import { hasLikelyValidApiKeyFormat } from './api-key-format';
import { ApiError } from '../lib/api-error';

const DEFAULT_BASE_URL = 'https://api.groq.com/openai';

const GROQ_VOICES: Voice[] = [
  { id: 'autumn', name: 'Autumn', language: 'en' },
  { id: 'diana', name: 'Diana', language: 'en' },
  { id: 'hannah', name: 'Hannah', language: 'en' },
  { id: 'austin', name: 'Austin', language: 'en' },
  { id: 'daniel', name: 'Daniel', language: 'en' },
  { id: 'troy', name: 'Troy', language: 'en' },
  { id: 'fahad', name: 'Fahad', language: 'ar-SA' },
  { id: 'sultan', name: 'Sultan', language: 'ar-SA' },
  { id: 'lulwa', name: 'Lulwa', language: 'ar-SA' },
  { id: 'noura', name: 'Noura', language: 'ar-SA' },
];

const DEFAULT_MODEL = 'canopylabs/orpheus-v1-english';

export const groqProvider: TTSProvider = {
  id: 'groq',
  name: 'Groq',

  async listVoices(_config: ProviderConfig): Promise<Voice[]> {
    return GROQ_VOICES;
  },

  async synthesize(
    text: string,
    voice: Voice,
    config: ProviderConfig,
    options?: SynthesisOptions,
  ): Promise<SynthesisResult> {
    const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    const isArabic = voice.language === 'ar-SA';
    const defaultModel = isArabic ? 'canopylabs/orpheus-arabic-saudi' : DEFAULT_MODEL;
    const model = (config.extraParams?.model as string) ?? defaultModel;

    const body: Record<string, unknown> = {
      model,
      input: text,
      voice: voice.id,
      response_format: 'wav',
    };
    if (options?.speed && options.speed !== 1.0) body.speed = options.speed;

    let response: Response;
    try {
      response = await fetch(buildOpenAICompatibleUrl(baseUrl, '/audio/speech'), {
        signal: AbortSignal.timeout(30_000),
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw ApiError.fromNetworkError(err, 'groq');
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      if (response.status === 401) {
        throw new ApiError('Invalid Groq API key.', 401, 'groq', false);
      }
      if (response.status === 429) {
        throw new ApiError('Rate limit exceeded.', 429, 'groq', true);
      }
      throw ApiError.fromResponse(response.status, errBody || response.statusText, 'groq', response.headers);
    }

    const audioData = await response.arrayBuffer();
    return { audioData, format: 'wav' };
  },

  async validateKey(config: ProviderConfig): Promise<boolean> {
    if (!hasLikelyValidApiKeyFormat(config)) return false;
    const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    return validateOpenAICompatibleSpeech(baseUrl, {
      'Authorization': `Bearer ${config.apiKey}`,
    }, {
      model: DEFAULT_MODEL,
      input: '.',
      voice: GROQ_VOICES[0]?.id ?? 'autumn',
      response_format: 'wav',
    });
  },
};
```

- [ ] **Step 7: Create `src/providers/mimo.ts`**

```ts
import type { TTSProvider, ProviderConfig, Voice, SynthesisResult, SynthesisOptions } from '../lib/types';
import { hasLikelyValidApiKeyFormat } from './api-key-format';
import { ApiError } from '../lib/api-error';

const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';
const DEFAULT_MODEL = 'mimo-v2-tts';

const MIMO_VOICES: Voice[] = [
  { id: 'mimo_default', name: 'Mimo Default' },
  { id: 'default_zh', name: 'Chinese Female', language: 'zh' },
  { id: 'default_en', name: 'English Female', language: 'en' },
];

function buildHeaders(apiKey: string): Record<string, string> {
  return { 'api-key': apiKey.trim(), 'Content-Type': 'application/json' };
}

function buildRequestBody(text: string, voiceId: string): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    modalities: ['text', 'audio'],
    audio: { voice: voiceId, format: 'mp3' },
    thinking: { type: 'disabled' },
    messages: [
      { role: 'user', content: 'Read the following text aloud.' },
      { role: 'assistant', content: text },
    ],
  };
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export const mimoProvider: TTSProvider = {
  id: 'mimo',
  name: 'Xiaomi Mimo',

  async listVoices(_config: ProviderConfig): Promise<Voice[]> {
    return MIMO_VOICES;
  },

  async synthesize(
    text: string,
    voice: Voice,
    config: ProviderConfig,
    _options?: SynthesisOptions,
  ): Promise<SynthesisResult> {
    const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        signal: AbortSignal.timeout(30_000),
        method: 'POST',
        headers: buildHeaders(config.apiKey),
        body: JSON.stringify(buildRequestBody(text, voice.id)),
      });
    } catch (err) {
      throw ApiError.fromNetworkError(err, 'mimo');
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      if (response.status === 401) throw new ApiError('Invalid Mimo API key.', 401, 'mimo', false);
      if (response.status === 429) throw new ApiError('Rate limit exceeded.', 429, 'mimo', true);
      throw ApiError.fromResponse(response.status, errBody || response.statusText, 'mimo', response.headers);
    }

    let json: Record<string, unknown>;
    try { json = await response.json(); } catch {
      throw new ApiError('Failed to parse Mimo response.', 0, 'mimo', true);
    }

    const choices = json.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const audio = message?.audio as Record<string, unknown> | undefined;
    const audioBase64 = audio?.data as string | undefined;
    if (!audioBase64) {
      throw new ApiError('Mimo response missing audio data.', 0, 'mimo', true);
    }

    return { audioData: base64ToArrayBuffer(audioBase64), format: 'mp3' };
  },

  async validateKey(config: ProviderConfig): Promise<boolean> {
    if (!hasLikelyValidApiKeyFormat(config)) return false;
    const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        signal: AbortSignal.timeout(15_000),
        method: 'POST',
        headers: buildHeaders(config.apiKey),
        body: JSON.stringify(buildRequestBody('test', MIMO_VOICES[0]!.id)),
      });
      return response.ok;
    } catch { return false; }
  },
};
```

- [ ] **Step 8: Create `src/providers/custom.ts`**

```ts
import type { TTSProvider, ProviderConfig, Voice, SynthesisResult, SynthesisOptions } from '../lib/types';
import { buildOpenAICompatibleUrl, validateOpenAICompatibleSpeech } from './openai-compatible';
import { ApiError } from '../lib/api-error';

export const customProvider: TTSProvider = {
  id: 'custom',
  name: 'Custom (OpenAI-compatible)',

  async listVoices(config: ProviderConfig): Promise<Voice[]> {
    if (!config.baseUrl) return [];
    try {
      const response = await fetch(buildOpenAICompatibleUrl(config.baseUrl, '/audio/voices'), {
        headers: { 'Authorization': `Bearer ${config.apiKey}` },
      });
      if (!response.ok) return [];
      const data = await response.json();
      return (data.voices ?? []).map((v: { id: string; name?: string }) => ({
        id: v.id,
        name: v.name ?? v.id,
      }));
    } catch { return []; }
  },

  async synthesize(
    text: string,
    voice: Voice,
    config: ProviderConfig,
    options?: SynthesisOptions,
  ): Promise<SynthesisResult> {
    if (!config.baseUrl) throw new Error('Custom provider requires a baseUrl.');
    const speed = options?.speed ?? 1.0;
    const format = options?.format ?? 'mp3';

    let response: Response;
    try {
      response = await fetch(buildOpenAICompatibleUrl(config.baseUrl, '/audio/speech'), {
        signal: AbortSignal.timeout(30_000),
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: (config.extraParams?.model as string) ?? 'tts-1',
          input: text,
          voice: voice.id,
          response_format: format,
          speed,
        }),
      });
    } catch (err) {
      throw ApiError.fromNetworkError(err, 'custom');
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      if (response.status === 401) throw new ApiError('Invalid API key.', 401, 'custom', false);
      if (response.status === 429) throw new ApiError('Rate limit exceeded.', 429, 'custom', true);
      throw ApiError.fromResponse(response.status, errBody || response.statusText, 'custom', response.headers);
    }

    const audioData = await response.arrayBuffer();
    return { audioData, format };
  },

  async validateKey(config: ProviderConfig): Promise<boolean> {
    if (!config.baseUrl) return false;
    const voices = await this.listVoices(config);
    const voiceId = voices[0]?.id ?? 'alloy';
    const model = (config.extraParams?.model as string) ?? 'tts-1';
    return validateOpenAICompatibleSpeech(config.baseUrl, {
      'Authorization': `Bearer ${config.apiKey}`,
    }, { model, input: 'test', voice: voiceId, response_format: 'mp3' });
  },
};
```

- [ ] **Step 9: Create `src/providers/registry.ts`**

```ts
import type { TTSProvider } from '../lib/types';
import { openaiProvider } from './openai';
import { elevenlabsProvider } from './elevenlabs';
import { groqProvider } from './groq';
import { mimoProvider } from './mimo';
import { customProvider } from './custom';

export interface ProviderMeta {
  id: string;
  name: string;
  description: string;
  website: string;
}

const providerMap: Record<string, TTSProvider> = {
  openai: openaiProvider,
  elevenlabs: elevenlabsProvider,
  groq: groqProvider,
  mimo: mimoProvider,
  custom: customProvider,
};

export function getProvider(providerId: string): TTSProvider {
  const provider = providerMap[providerId];
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  return provider;
}

export interface ChunkLimits {
  minWords: number;
  maxWords: number;
  splitThreshold: number;
}

export function getChunkLimits(providerId: string): ChunkLimits {
  switch (providerId) {
    case 'groq':
      return { minWords: 15, maxWords: 25, splitThreshold: 50 };
    default:
      return { minWords: 30, maxWords: 50, splitThreshold: 80 };
  }
}

export const PROVIDER_LIST: ProviderMeta[] = [
  { id: 'openai', name: 'OpenAI', description: 'High-quality TTS with 6 built-in voices', website: 'https://platform.openai.com/api-keys' },
  { id: 'elevenlabs', name: 'ElevenLabs', description: 'Premium voice cloning and synthesis', website: 'https://elevenlabs.io/app/settings/api-keys' },
  { id: 'groq', name: 'Groq', description: 'Ultra-fast inference with PlayAI voices', website: 'https://console.groq.com/keys' },
  { id: 'mimo', name: 'Xiaomi Mimo', description: 'Multilingual TTS with emotion support', website: 'https://platform.xiaomimimo.com' },
  { id: 'custom', name: 'Custom (OpenAI-compatible)', description: 'Any OpenAI-compatible TTS endpoint', website: '' },
];
```

- [ ] **Step 10: Create `src/providers/failover.ts`**

```ts
import type { ProviderConfig, Voice, ConfigHealth, PlaybackSession } from '../lib/types';
import { ApiError } from '../lib/api-error';
import { getProvider } from './registry';
import { getCachedVoices, setCachedVoices } from './voice-cache';

const healthMap = new Map<string, ConfigHealth>();

const COOLDOWN_429 = 60_000;
const COOLDOWN_403 = 5 * 60_000;
const COOLDOWN_5XX = 30_000;
const COOLDOWN_NETWORK = 30_000;

function getOrCreateHealth(configId: string): ConfigHealth {
  let health = healthMap.get(configId);
  if (!health) {
    health = { status: 'healthy', failCount: 0 };
    healthMap.set(configId, health);
  }
  if (health.status === 'cooldown' && health.cooldownUntil && Date.now() >= health.cooldownUntil) {
    health.status = 'healthy';
    health.cooldownUntil = undefined;
    health.failCount = 0;
  }
  return health;
}

export function getCooldownDuration(error: ApiError): number {
  if (error.retryAfterMs) return error.retryAfterMs;
  if (error.status === 429) return COOLDOWN_429;
  if (error.status === 403) return COOLDOWN_403;
  if (error.status >= 500) return COOLDOWN_5XX;
  if (error.status === 0) return COOLDOWN_NETWORK;
  return COOLDOWN_5XX;
}

export function markFailed(configId: string, error: ApiError): void {
  const health = getOrCreateHealth(configId);
  health.failCount++;
  health.lastError = { message: error.message, status: error.status, timestamp: Date.now() };
  if (error.status === 401) {
    health.status = 'failed';
  } else {
    health.status = 'cooldown';
    health.cooldownUntil = Date.now() + getCooldownDuration(error);
  }
}

export function isHealthy(configId: string): boolean {
  return getOrCreateHealth(configId).status === 'healthy';
}

export function getHealth(configId: string): ConfigHealth {
  return getOrCreateHealth(configId);
}

export function getAllHealth(): Record<string, ConfigHealth> {
  for (const key of healthMap.keys()) getOrCreateHealth(key);
  return Object.fromEntries(healthMap);
}

export function clearHealth(configId: string): void {
  healthMap.delete(configId);
}

export function resetAllHealth(): void {
  healthMap.clear();
}

/**
 * Find next healthy candidate from same provider group.
 * `allConfigs` is passed in (from plugin settings) instead of reading chrome.storage.
 */
export async function getNextCandidate(
  session: PlaybackSession,
  failedConfigId: string,
  allConfigs: ProviderConfig[],
): Promise<ProviderConfig | null> {
  const candidates = allConfigs.filter((c) => {
    if (c.id === failedConfigId) return false;
    if (c.providerId !== session.providerId) return false;
    if (c.providerId === 'custom') {
      const normalize = (url?: string) => (url || '').trim().replace(/\/+$/, '');
      if (normalize(c.baseUrl) !== normalize(session.config.baseUrl)) return false;
    }
    return true;
  });

  for (const candidate of candidates) {
    const health = getOrCreateHealth(candidate.id);
    if (health.status === 'failed' || (health.status === 'cooldown' && health.cooldownUntil && Date.now() < health.cooldownUntil)) {
      continue;
    }

    if (candidate.providerId === 'elevenlabs') {
      let voices = getCachedVoices(candidate.id);
      if (!voices) {
        try {
          const provider = getProvider(candidate.providerId);
          voices = await provider.listVoices(candidate);
          setCachedVoices(candidate.id, voices);
        } catch { continue; }
      }
      if (!voices.some((v: Voice) => v.id === session.voice.id)) continue;
    }

    return candidate;
  }
  return null;
}
```

- [ ] **Step 11: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 12: Commit**

```bash
git add src/providers/
git commit -m "feat: add all 5 TTS providers with failover and voice cache"
```

---

## Task 3: Text Extraction and Chunking

**Files:**
- Create: `src/extraction/sentence-splitter.ts`
- Create: `src/extraction/chunker.ts`
- Create: `src/extraction/extractor.ts`
- Create: `src/highlighting/dom-mapper.ts`

- [ ] **Step 1: Create `src/extraction/sentence-splitter.ts`**

Port directly from Chrome extension. Only change: import path.

```ts
import type { SentenceBoundary } from '../lib/types';

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'ave', 'blvd',
  'gen', 'gov', 'sgt', 'cpl', 'pvt', 'capt', 'lt', 'col', 'maj',
  'cmdr', 'adm', 'rev', 'hon', 'pres',
  'dept', 'univ', 'assn', 'bros', 'inc', 'ltd', 'co', 'corp',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
  'vol', 'vs', 'etc', 'approx', 'appt', 'est', 'min', 'max',
  'dept', 'div', 'fig', 'no', 'op', 'pp', 'para',
]);

const MULTI_DOT_ABBREV = /^(?:e\.g|i\.e|a\.m|p\.m|u\.s|u\.k|u\.n)$/i;

function isAbbreviation(word: string): boolean {
  const base = word.replace(/\.$/, '').toLowerCase();
  if (ABBREVIATIONS.has(base)) return true;
  if (MULTI_DOT_ABBREV.test(word.replace(/\.$/, ''))) return true;
  if (/^[A-Z]$/.test(base)) return true;
  return false;
}

function isDecimal(text: string, dotIndex: number): boolean {
  if (dotIndex <= 0 || dotIndex >= text.length - 1) return false;
  return /\d/.test(text[dotIndex - 1]) && /\d/.test(text[dotIndex + 1]);
}

function isEllipsis(text: string, dotIndex: number): boolean {
  if (dotIndex >= 2 && text[dotIndex - 1] === '.' && text[dotIndex - 2] === '.') return true;
  if (dotIndex >= 1 && dotIndex < text.length - 1 && text[dotIndex - 1] === '.' && text[dotIndex + 1] === '.') return true;
  if (dotIndex < text.length - 2 && text[dotIndex + 1] === '.' && text[dotIndex + 2] === '.') return true;
  if (text[dotIndex] === '\u2026') return true;
  return false;
}

export function splitSentences(text: string): SentenceBoundary[] {
  if (!text.trim()) return [];
  const boundaries: SentenceBoundary[] = [];
  let sentenceStart = 0;

  while (sentenceStart < text.length && /\s/.test(text[sentenceStart])) sentenceStart++;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '\u2026'
        && ch !== '\u3002' && ch !== '\uFF01' && ch !== '\uFF1F') continue;
    if (ch === '.' && isEllipsis(text, i)) continue;
    if (ch === '\u2026') continue;
    if (ch === '.' && isDecimal(text, i)) continue;
    if (ch === '.') {
      let wordStart = i - 1;
      while (wordStart >= 0 && /[A-Za-z.]/.test(text[wordStart])) wordStart--;
      const precedingWord = text.slice(wordStart + 1, i + 1);
      if (isAbbreviation(precedingWord)) continue;
    }

    let end = i + 1;
    while (end < text.length && /['""\u201C\u201D\u2019)}\]]/.test(text[end])) end++;

    let afterPunct = end;
    while (afterPunct < text.length && /\s/.test(text[afterPunct])) afterPunct++;

    const atEnd = afterPunct >= text.length;
    const nextIsUpper = afterPunct < text.length && /[A-Z\u201C\u2018"'(]/.test(text[afterPunct]);
    const isCjkTerminator = ch === '\u3002' || ch === '\uFF01' || ch === '\uFF1F';
    const nextIsCjk = afterPunct < text.length && /[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F]/.test(text[afterPunct]);
    const hasNewline = /[\r\n]/.test(text.slice(end, afterPunct));

    if (atEnd || nextIsUpper || isCjkTerminator || nextIsCjk || hasNewline) {
      const sentenceText = text.slice(sentenceStart, end).trim();
      if (sentenceText) {
        boundaries.push({ text: sentenceText, startOffset: sentenceStart, endOffset: end });
      }
      sentenceStart = afterPunct;
      i = afterPunct - 1;
    }
  }

  const remaining = text.slice(sentenceStart).trim();
  if (remaining) {
    boundaries.push({ text: remaining, startOffset: sentenceStart, endOffset: text.length });
  }
  return boundaries;
}

export function splitSentenceStrings(text: string): string[] {
  return splitSentences(text).map((b) => b.text);
}
```

- [ ] **Step 2: Create `src/extraction/chunker.ts`**

```ts
import type { TextChunk } from '../lib/types';
import { splitSentenceStrings } from './sentence-splitter';

export interface ChunkConfig {
  minWords: number;
  maxWords: number;
  splitThreshold: number;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function splitAtClauseBoundary(text: string, maxWords: number): string[] {
  const parts = text.split(/(?<=[,;\u2014])\s+/);
  if (parts.length <= 1) return [text];

  const merged: string[] = [];
  let current = '';
  for (const part of parts) {
    const combined = current ? `${current} ${part}` : part;
    if (countWords(combined) > maxWords && current) {
      merged.push(current.trim());
      current = part;
    } else {
      current = combined;
    }
  }
  if (current.trim()) merged.push(current.trim());
  return merged;
}

export function chunkText(text: string, config: ChunkConfig): TextChunk[] {
  if (!text.trim()) return [];
  const { maxWords, splitThreshold } = config;
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  const rawChunks: string[] = [];

  for (const para of paragraphs) {
    const sentences = splitSentenceStrings(para.trim());
    for (const sentence of sentences) {
      if (countWords(sentence) > splitThreshold) {
        for (const clause of splitAtClauseBoundary(sentence, maxWords)) {
          rawChunks.push(clause.trim());
        }
        continue;
      }
      rawChunks.push(sentence.trim());
    }
  }

  const chunks: TextChunk[] = [];
  let globalOffset = 0;
  for (let i = 0; i < rawChunks.length; i++) {
    const chunkStr = rawChunks[i];
    const idx = text.indexOf(chunkStr, globalOffset);
    const startOffset = idx >= 0 ? idx : globalOffset;
    const endOffset = startOffset + chunkStr.length;
    chunks.push({ index: i, text: chunkStr, startOffset, endOffset, wordCount: countWords(chunkStr) });
    if (idx >= 0) globalOffset = endOffset;
  }
  return chunks;
}
```

- [ ] **Step 3: Create `src/highlighting/dom-mapper.ts`**

Adapted from Chrome extension. Adds filtering for Obsidian-specific non-prose elements.

```ts
import type { TextNodeEntry, TextMapResult } from '../lib/types';

/** CSS selectors for elements to skip when building the text node map. */
const SKIP_SELECTORS = [
  'pre',                          // fenced code blocks
  'code',                         // inline code
  '.frontmatter-container',       // YAML frontmatter in reading view
  '.math',                        // LaTeX math blocks
  '.callout-title',               // callout title/type line (read body text, not title)
  '.embedded-backlinks',          // backlinks section
  '.mod-footer',                  // reading view footer
];

const SKIP_SELECTOR = SKIP_SELECTORS.join(', ');

function shouldSkip(node: Node): boolean {
  if (node.nodeType === Node.ELEMENT_NODE) {
    return (node as Element).matches(SKIP_SELECTOR);
  }
  // Check if any ancestor matches
  let parent = node.parentElement;
  while (parent) {
    if (parent.matches(SKIP_SELECTOR)) return true;
    parent = parent.parentElement;
  }
  return false;
}

/**
 * Walk the DOM tree under `root` and collect all text nodes with their
 * global character offsets, skipping non-prose elements.
 */
export function buildTextNodeMap(root: Element): TextMapResult {
  const entries: TextNodeEntry[] = [];
  let offset = 0;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (shouldSkip(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const text = node.nodeValue ?? '';
    if (!text) continue;

    entries.push({ node, globalStart: offset, globalEnd: offset + text.length });
    offset += text.length;
  }

  const text = entries.map((e) => e.node.nodeValue ?? '').join('');
  return { entries, text };
}
```

- [ ] **Step 4: Create `src/extraction/extractor.ts`**

This is the Obsidian-specific extractor. Instead of Readability, it finds the reading view container and delegates to `buildTextNodeMap`.

```ts
import type { TextMapResult } from '../lib/types';
import { buildTextNodeMap } from '../highlighting/dom-mapper';

/**
 * Extract prose text from the active Reading View leaf.
 * Returns the text node map for highlighting and the concatenated plain text for chunking.
 */
export function extractFromReadingView(containerEl: HTMLElement): TextMapResult | null {
  // Obsidian's reading view renders content inside .markdown-reading-view
  const readingView = containerEl.querySelector('.markdown-reading-view');
  if (!readingView) return null;

  // The actual rendered content is in .markdown-preview-section
  const previewSection = readingView.querySelector('.markdown-preview-section');
  if (!previewSection) return null;

  const result = buildTextNodeMap(previewSection);
  if (!result.text.trim()) return null;

  return result;
}
```

- [ ] **Step 5: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/extraction/ src/highlighting/dom-mapper.ts
git commit -m "feat: add text extraction, sentence splitting, chunking, and DOM mapping"
```

---

## Task 4: Audio Player

**Files:**
- Create: `src/audio-player.ts`

Simplified from Chrome extension's offscreen audio player. No message passing — uses direct callbacks. Same gapless scheduling logic.

- [ ] **Step 1: Create `src/audio-player.ts`**

```ts
import { PROGRESS_REPORT_INTERVAL_MS } from './lib/constants';

export interface AudioPlayerCallbacks {
  onProgress: (currentTime: number, duration: number, chunkIndex: number) => void;
  onChunkComplete: (chunkIndex: number) => void;
}

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private currentBuffer: AudioBuffer | null = null;
  private progressInterval: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;
  private pauseOffset = 0;
  private isPlaying = false;
  private currentChunkIndex = -1;
  private playbackRate = 1.0;
  private prefetchedBuffers = new Map<number, AudioBuffer>();
  private callbacks: AudioPlayerCallbacks;

  // Gapless scheduling
  private nextSourceNode: AudioBufferSourceNode | null = null;
  private nextBuffer: AudioBuffer | null = null;
  private nextChunkIndex = -1;

  constructor(callbacks: AudioPlayerCallbacks) {
    this.callbacks = callbacks;
  }

  private getContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.gainNode = this.ctx.createGain();
      this.gainNode.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  async play(audioData: ArrayBuffer, chunkIndex: number): Promise<void> {
    this.stop();
    this.currentChunkIndex = chunkIndex;

    const ctx = this.getContext();
    if (ctx.state === 'suspended') await ctx.resume();

    const cached = this.prefetchedBuffers.get(chunkIndex);
    const buffer = cached ?? await ctx.decodeAudioData(audioData.slice(0));
    if (cached) this.prefetchedBuffers.delete(chunkIndex);

    this.currentBuffer = buffer;
    this.pauseOffset = 0;
    this.startPlayback();
  }

  async scheduleNext(audioData: ArrayBuffer, chunkIndex: number): Promise<void> {
    const ctx = this.getContext();
    if (!this.isPlaying || !this.currentBuffer) {
      await this.play(audioData, chunkIndex);
      return;
    }

    if (this.nextSourceNode) {
      try { this.nextSourceNode.stop(); } catch { /* */ }
      this.nextSourceNode.disconnect();
      this.nextSourceNode = null;
    }

    const cached = this.prefetchedBuffers.get(chunkIndex);
    const buffer = cached ?? await ctx.decodeAudioData(audioData.slice(0));
    if (cached) this.prefetchedBuffers.delete(chunkIndex);

    this.nextBuffer = buffer;
    this.nextChunkIndex = chunkIndex;

    const elapsed = ctx.currentTime - this.startTime;
    const currentDuration = (this.currentBuffer.duration - this.pauseOffset) / this.playbackRate;
    const remaining = currentDuration - elapsed;
    const startAt = ctx.currentTime + Math.max(0, remaining);

    this.nextSourceNode = ctx.createBufferSource();
    this.nextSourceNode.buffer = buffer;
    this.nextSourceNode.playbackRate.value = this.playbackRate;
    this.nextSourceNode.connect(this.gainNode!);
    this.nextSourceNode.start(startAt);
  }

  async prefetch(audioData: ArrayBuffer, chunkIndex: number): Promise<void> {
    const ctx = this.getContext();
    try {
      const buffer = await ctx.decodeAudioData(audioData.slice(0));
      this.prefetchedBuffers.set(chunkIndex, buffer);
      if (this.prefetchedBuffers.size > 3) {
        const oldest = this.prefetchedBuffers.keys().next().value;
        if (oldest !== undefined) this.prefetchedBuffers.delete(oldest);
      }
    } catch { /* decode failed */ }
  }

  private startPlayback(): void {
    if (!this.currentBuffer || !this.ctx || !this.gainNode) return;

    const completingChunkIndex = this.currentChunkIndex;
    this.sourceNode = this.ctx.createBufferSource();
    this.sourceNode.buffer = this.currentBuffer;
    this.sourceNode.playbackRate.value = this.playbackRate;
    this.sourceNode.connect(this.gainNode);

    this.sourceNode.onended = () => {
      if (!this.isPlaying) return;
      this.stopProgressReporting();

      if (this.nextSourceNode && this.nextBuffer) {
        // Gapless transition
        this.sourceNode = this.nextSourceNode;
        this.currentBuffer = this.nextBuffer;
        this.currentChunkIndex = this.nextChunkIndex;
        this.startTime = this.ctx!.currentTime;
        this.pauseOffset = 0;
        this.nextSourceNode = null;
        this.nextBuffer = null;
        this.nextChunkIndex = -1;

        const promotedIndex = this.currentChunkIndex;
        this.sourceNode.onended = () => {
          if (this.isPlaying) {
            this.isPlaying = false;
            this.stopProgressReporting();
            this.callbacks.onChunkComplete(promotedIndex);
          }
        };
        this.startProgressReporting();
        this.callbacks.onChunkComplete(completingChunkIndex);
      } else {
        this.isPlaying = false;
        this.callbacks.onChunkComplete(completingChunkIndex);
      }
    };

    this.sourceNode.start(0, this.pauseOffset);
    this.startTime = this.ctx.currentTime - this.pauseOffset;
    this.isPlaying = true;
    this.startProgressReporting();
  }

  pause(): void {
    if (!this.isPlaying || !this.ctx || !this.sourceNode) return;
    this.pauseOffset = (this.ctx.currentTime - this.startTime) * this.playbackRate;
    this.isPlaying = false;
    try { this.sourceNode.onended = null; this.sourceNode.stop(); } catch { /* */ }
    this.sourceNode.disconnect();
    this.sourceNode = null;
    if (this.nextSourceNode) {
      try { this.nextSourceNode.onended = null; this.nextSourceNode.stop(); } catch { /* */ }
      this.nextSourceNode.disconnect();
      this.nextSourceNode = null;
    }
    this.stopProgressReporting();
  }

  resume(): void {
    if (this.isPlaying || !this.currentBuffer) return;
    this.startPlayback();
  }

  stop(): void {
    this.isPlaying = false;
    this.stopProgressReporting();
    if (this.sourceNode) {
      try { this.sourceNode.onended = null; this.sourceNode.stop(); } catch { /* */ }
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.nextSourceNode) {
      try { this.nextSourceNode.onended = null; this.nextSourceNode.stop(); } catch { /* */ }
      this.nextSourceNode.disconnect();
      this.nextSourceNode = null;
    }
    this.currentBuffer = null;
    this.nextBuffer = null;
    this.nextChunkIndex = -1;
    this.pauseOffset = 0;
    this.currentChunkIndex = -1;
  }

  setSpeed(rate: number): void {
    this.playbackRate = rate;
    if (this.sourceNode && this.isPlaying) this.sourceNode.playbackRate.value = rate;
    if (this.nextSourceNode) this.nextSourceNode.playbackRate.value = rate;
  }

  setVolume(level: number): void {
    if (this.gainNode) this.gainNode.gain.value = Math.max(0, Math.min(1, level));
  }

  getCurrentTime(): number {
    if (!this.ctx || !this.isPlaying) return this.pauseOffset;
    return (this.ctx.currentTime - this.startTime) * this.playbackRate;
  }

  getDuration(): number {
    return this.currentBuffer?.duration ?? 0;
  }

  dispose(): void {
    this.stop();
    this.prefetchedBuffers.clear();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.gainNode = null;
  }

  private startProgressReporting(): void {
    this.stopProgressReporting();
    this.progressInterval = setInterval(() => {
      this.callbacks.onProgress(this.getCurrentTime(), this.getDuration(), this.currentChunkIndex);
    }, PROGRESS_REPORT_INTERVAL_MS);
  }

  private stopProgressReporting(): void {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
  }
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/audio-player.ts
git commit -m "feat: add Web Audio API player with gapless scheduling"
```

---

## Task 5: Word Timing and Highlighting

**Files:**
- Create: `src/word-timing.ts`
- Create: `src/highlighting/highlight-manager.ts`
- Create: `src/highlighting/styles.ts`
- Create: `src/highlighting/auto-scroll.ts`
- Create: `src/highlighting/click-to-seek.ts`

- [ ] **Step 1: Create `src/word-timing.ts`**

Simplified from Chrome extension — uses direct callback instead of `sendTabMessage`.

```ts
interface SimpleWordTiming {
  word: string;
  startTime: number;
  endTime: number;
}

export interface WordTimingCallback {
  (chunkIndex: number, wordIndex: number, word: string, startTime: number, endTime: number): void;
}

let currentChunkIndex = -1;
let currentWords: string[] = [];
let currentWordIndex = 0;
let currentRealTimings: SimpleWordTiming[] | null = null;
let audioDuration = 0;
let cumulativeCharFractions: number[] = [];
let callback: WordTimingCallback | null = null;

export function setWordTimingCallback(cb: WordTimingCallback | null): void {
  callback = cb;
}

export function startWordTimingRelay(
  chunkIndex: number,
  chunkText: string,
  realTimings?: SimpleWordTiming[],
): void {
  stopWordTimingRelay();
  currentChunkIndex = chunkIndex;
  currentWords = chunkText.split(/\s+/).filter(Boolean);
  currentWordIndex = 0;
  audioDuration = 0;

  currentRealTimings = realTimings && realTimings.length > 0 ? realTimings : null;

  const totalChars = currentWords.reduce((sum, w) => sum + w.length, 0);
  cumulativeCharFractions = [];
  let cumulative = 0;
  for (const w of currentWords) {
    cumulative += w.length / (totalChars || 1);
    cumulativeCharFractions.push(cumulative);
  }
}

export function stopWordTimingRelay(): void {
  currentChunkIndex = -1;
  currentWords = [];
  currentWordIndex = 0;
  currentRealTimings = null;
  audioDuration = 0;
  cumulativeCharFractions = [];
}

export function onPlaybackProgress(
  chunkIndex: number,
  currentTime: number,
  duration: number,
): void {
  if (chunkIndex !== currentChunkIndex || !callback || currentWords.length === 0) return;
  if (duration > 0) audioDuration = duration;

  if (currentRealTimings) {
    while (
      currentWordIndex < currentRealTimings.length &&
      currentRealTimings[currentWordIndex].startTime <= currentTime
    ) {
      const timing = currentRealTimings[currentWordIndex];
      callback(currentChunkIndex, currentWordIndex, timing.word, timing.startTime, timing.endTime);
      currentWordIndex++;
    }
  } else if (audioDuration > 0) {
    const progress = Math.min(currentTime / audioDuration, 1);
    let expectedWordIndex = 0;
    for (let i = 0; i < cumulativeCharFractions.length; i++) {
      if (progress < cumulativeCharFractions[i]) {
        expectedWordIndex = i;
        break;
      }
      expectedWordIndex = i;
    }
    while (currentWordIndex <= expectedWordIndex) {
      const startFrac = currentWordIndex > 0 ? cumulativeCharFractions[currentWordIndex - 1] : 0;
      const endFrac = cumulativeCharFractions[currentWordIndex];
      callback(currentChunkIndex, currentWordIndex, currentWords[currentWordIndex], startFrac * audioDuration, endFrac * audioDuration);
      currentWordIndex++;
    }
  }
}
```

- [ ] **Step 2: Create `src/highlighting/styles.ts`**

```ts
import type { ResolvedHighlightSettings } from '../lib/types';

const STYLE_ID = 'recito-highlight-styles';

function deriveAccentColors(rgbaColor: string): { glow: string } {
  const match = rgbaColor.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return { glow: rgbaColor };
  const [, r, g, b] = match;
  return { glow: `rgba(${r}, ${g}, ${b}, 0.25)` };
}

function buildCSS(settings: ResolvedHighlightSettings): string {
  const wordAccent = deriveAccentColors(settings.wordColor);
  return `
::highlight(recito-word) {
  background-color: ${settings.wordColor};
  text-shadow: 0 0 8px ${wordAccent.glow};
}
::highlight(recito-sentence) {
  background-color: ${settings.sentenceColor};
}
::highlight(recito-scrub-hover) {
  background-color: rgba(0, 0, 0, 0.06);
}
.recito-scrub-active { cursor: pointer; }
`;
}

export function injectHighlightStyles(settings: ResolvedHighlightSettings): HTMLStyleElement {
  const existing = document.getElementById(STYLE_ID);
  if (existing) existing.remove();
  const styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent = buildCSS(settings);
  document.head.appendChild(styleEl);
  return styleEl;
}

export function updateHighlightStyles(styleEl: HTMLStyleElement, settings: ResolvedHighlightSettings): void {
  styleEl.textContent = buildCSS(settings);
}

export function removeHighlightStyles(styleEl: HTMLStyleElement): void {
  styleEl.remove();
}
```

- [ ] **Step 3: Create `src/highlighting/highlight-manager.ts`**

Simplified from Chrome extension — no `<mark>` fallback (Electron always supports CSS Highlight API).

```ts
import type { TextMapResult, TextNodeEntry, ResolvedHighlightSettings } from '../lib/types';
import { buildTextNodeMap } from './dom-mapper';
import { createRangeFromOffsets } from './utils';
import { injectHighlightStyles, updateHighlightStyles, removeHighlightStyles } from './styles';
import { scrollToHighlight } from './auto-scroll';

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

  highlightWord(charStart: number, charEnd: number): void {
    if (!this.textMap || !this.settings.wordEnabled) return;
    this.clearWordHighlight();
    const range = createRangeFromOffsets(this.textMap.entries, charStart, charEnd);
    if (!range) return;
    this.wordHighlight?.add(range);
    if (this.settings.autoScroll) scrollToHighlight(range);
  }

  highlightSentence(charStart: number, charEnd: number): void {
    if (!this.textMap || !this.settings.sentenceEnabled) return;
    this.clearSentenceHighlight();
    const range = createRangeFromOffsets(this.textMap.entries, charStart, charEnd);
    if (!range) return;
    this.sentenceHighlight?.add(range);
  }

  highlightScrubHover(charStart: number, charEnd: number): void {
    if (!this.textMap) return;
    this.clearScrubHover();
    const range = createRangeFromOffsets(this.textMap.entries, charStart, charEnd);
    if (!range) return;
    this.scrubHoverHighlight?.add(range);
  }

  clearWordHighlight(): void { this.wordHighlight?.clear(); }
  clearSentenceHighlight(): void { this.sentenceHighlight?.clear(); }
  clearScrubHover(): void { this.scrubHoverHighlight?.clear(); }

  getEntries(): TextNodeEntry[] { return this.textMap?.entries ?? []; }
  getFullText(): string { return this.textMap?.text ?? ''; }

  clearAll(): void {
    this.clearWordHighlight();
    this.clearSentenceHighlight();
    this.clearScrubHover();
  }

  updateColors(settings: ResolvedHighlightSettings): void {
    this.settings = settings;
    if (this.styleEl) updateHighlightStyles(this.styleEl, settings);
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
    if (this.styleEl) { removeHighlightStyles(this.styleEl); this.styleEl = null; }
  }
}
```

- [ ] **Step 4: Create `src/highlighting/utils.ts`** (same as Chrome extension, new import path)

```ts
import type { TextNodeEntry } from '../lib/types';

export function createRangeFromOffsets(
  entries: TextNodeEntry[],
  startOffset: number,
  endOffset: number,
): Range | null {
  if (entries.length === 0 || startOffset >= endOffset) return null;

  let startNode: Text | null = null;
  let startLocal = 0;
  let endNode: Text | null = null;
  let endLocal = 0;

  for (const entry of entries) {
    if (!startNode && startOffset < entry.globalEnd) {
      startNode = entry.node;
      startLocal = startOffset - entry.globalStart;
    }
    if (endOffset <= entry.globalEnd) {
      endNode = entry.node;
      endLocal = endOffset - entry.globalStart;
      break;
    }
  }

  if (!startNode || !endNode) return null;

  try {
    const range = document.createRange();
    range.setStart(startNode, Math.max(0, startLocal));
    range.setEnd(endNode, Math.min(endLocal, endNode.length));
    return range;
  } catch { return null; }
}
```

- [ ] **Step 5: Create `src/highlighting/auto-scroll.ts`**

Adapted for Obsidian — scrolls within the Reading View container instead of `window`.

```ts
const MANUAL_SCROLL_PAUSE_MS = 5000;

let enabled = true;
let paused = false;
let pauseTimer: ReturnType<typeof setTimeout> | null = null;
let scrollContainer: Element | null = null;
let boundOnWheel: (() => void) | null = null;

function onManualScroll(): void {
  if (!enabled) return;
  paused = true;
  if (pauseTimer !== null) clearTimeout(pauseTimer);
  pauseTimer = setTimeout(() => {
    paused = false;
    pauseTimer = null;
  }, MANUAL_SCROLL_PAUSE_MS);
}

export function initAutoScroll(container: Element): void {
  enabled = true;
  paused = false;
  scrollContainer = container;
  boundOnWheel = onManualScroll;
  container.addEventListener('wheel', boundOnWheel, { passive: true });
}

export function scrollToHighlight(range: Range): void {
  if (!enabled || paused || !scrollContainer) return;

  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return;

  const containerRect = scrollContainer.getBoundingClientRect();
  const relativeTop = rect.top - containerRect.top;
  const containerHeight = containerRect.height;

  const topThreshold = containerHeight * 0.2;
  const bottomThreshold = containerHeight * 0.8;
  if (relativeTop >= topThreshold && relativeTop + rect.height <= bottomThreshold) return;

  const targetScroll = scrollContainer.scrollTop + relativeTop - containerHeight / 2 + rect.height / 2;
  scrollContainer.scrollTo({ top: targetScroll, behavior: 'smooth' });
}

export function destroyAutoScroll(): void {
  if (boundOnWheel && scrollContainer) {
    scrollContainer.removeEventListener('wheel', boundOnWheel);
    boundOnWheel = null;
  }
  if (pauseTimer !== null) { clearTimeout(pauseTimer); pauseTimer = null; }
  paused = false;
  enabled = false;
  scrollContainer = null;
}
```

- [ ] **Step 6: Create `src/highlighting/click-to-seek.ts`**

Adapted from Chrome extension's text-scrubber.ts. Simplified — no Zustand dependency.

```ts
import type { TextChunk, TextNodeEntry } from '../lib/types';
import type { HighlightManager } from './highlight-manager';

let manager: HighlightManager | null = null;
let chunks: TextChunk[] = [];
let seekCallback: ((chunkIndex: number) => void) | null = null;
let nodeMap: WeakMap<Text, TextNodeEntry> | null = null;
let lastHoveredChunkIndex = -1;
let rafId = 0;
let isActive = false;

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role="button"], [role="link"]';

function getCaretInfo(x: number, y: number): { node: Text; offset: number } | null {
  if ('caretPositionFromPoint' in document) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos?.offsetNode instanceof Text) return { node: pos.offsetNode, offset: pos.offset };
  }
  if ('caretRangeFromPoint' in document) {
    const range = document.caretRangeFromPoint(x, y);
    if (range?.startContainer instanceof Text) return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

function resolveChunkAtPoint(x: number, y: number): number {
  const caret = getCaretInfo(x, y);
  if (!caret || !nodeMap) return -1;
  const entry = nodeMap.get(caret.node);
  if (!entry) return -1;
  const globalOffset = entry.globalStart + caret.offset;
  for (const chunk of chunks) {
    if (globalOffset >= chunk.startOffset && globalOffset < chunk.endOffset) return chunk.index;
  }
  return -1;
}

function onMouseMove(e: MouseEvent): void {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (!manager || !isActive) {
      if (lastHoveredChunkIndex >= 0) {
        manager?.clearScrubHover();
        document.documentElement.classList.remove('recito-scrub-active');
        lastHoveredChunkIndex = -1;
      }
      return;
    }
    const chunkIndex = resolveChunkAtPoint(e.clientX, e.clientY);
    if (chunkIndex < 0) {
      if (lastHoveredChunkIndex >= 0) {
        manager.clearScrubHover();
        document.documentElement.classList.remove('recito-scrub-active');
        lastHoveredChunkIndex = -1;
      }
      return;
    }
    if (chunkIndex === lastHoveredChunkIndex) return;
    lastHoveredChunkIndex = chunkIndex;
    const chunk = chunks[chunkIndex];
    if (chunk) {
      manager.highlightScrubHover(chunk.startOffset, chunk.endOffset);
      document.documentElement.classList.add('recito-scrub-active');
    }
  });
}

function onClick(e: MouseEvent): void {
  if (!manager || !seekCallback || !isActive) return;
  if (e.defaultPrevented) return;
  const target = e.target as Element | null;
  if (target?.closest(INTERACTIVE_SELECTOR)) return;
  const chunkIndex = resolveChunkAtPoint(e.clientX, e.clientY);
  if (chunkIndex < 0) return;
  e.preventDefault();
  manager.clearScrubHover();
  document.documentElement.classList.remove('recito-scrub-active');
  lastHoveredChunkIndex = -1;
  seekCallback(chunkIndex);
}

export function initClickToSeek(
  highlightManager: HighlightManager,
  textChunks: TextChunk[],
  onSeek: (chunkIndex: number) => void,
): void {
  destroyClickToSeek();
  manager = highlightManager;
  chunks = textChunks;
  seekCallback = onSeek;
  isActive = true;
  nodeMap = new WeakMap<Text, TextNodeEntry>();
  for (const entry of highlightManager.getEntries()) nodeMap.set(entry.node, entry);
  document.addEventListener('mousemove', onMouseMove, { passive: true });
  document.addEventListener('click', onClick, true);
}

export function setClickToSeekActive(active: boolean): void {
  isActive = active;
}

export function destroyClickToSeek(): void {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('click', onClick, true);
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  manager?.clearScrubHover();
  document.documentElement.classList.remove('recito-scrub-active');
  manager = null;
  chunks = [];
  seekCallback = null;
  nodeMap = null;
  lastHoveredChunkIndex = -1;
  isActive = false;
}
```

- [ ] **Step 7: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add src/word-timing.ts src/highlighting/
git commit -m "feat: add word timing, highlight manager, auto-scroll, and click-to-seek"
```

---

## Task 6: Playback State and Orchestrator

**Files:**
- Create: `src/orchestrator.ts`

This is the central coordinator. Simplified from Chrome extension — no message passing, direct calls to audio player, highlighting, and providers.

- [ ] **Step 1: Create `src/orchestrator.ts`**

```ts
import type { TextChunk, PlaybackState, PlaybackStatus, PlaybackSession, RecitoSettings, ProviderConfig, Voice } from './lib/types';
import { LOOKAHEAD_BUFFER_SIZE, PROVIDER_SPEED_RANGES } from './lib/constants';
import { ApiError } from './lib/api-error';
import { getProvider, getChunkLimits } from './providers/registry';
import { getCachedVoices, setCachedVoices } from './providers/voice-cache';
import { markFailed, getNextCandidate, resetAllHealth } from './providers/failover';
import { AudioPlayer } from './audio-player';
import { startWordTimingRelay, stopWordTimingRelay, onPlaybackProgress, setWordTimingCallback } from './word-timing';
import { HighlightManager } from './highlighting/highlight-manager';
import { extractFromReadingView } from './extraction/extractor';
import { chunkText } from './extraction/chunker';
import { splitSentences } from './extraction/sentence-splitter';
import { initAutoScroll, destroyAutoScroll } from './highlighting/auto-scroll';
import { initClickToSeek, destroyClickToSeek, setClickToSeekActive } from './highlighting/click-to-seek';
import { highlightColorsFromAccent, resolveHighlightSettings } from './lib/accent-colors';

import type RecitoPlugin from './main';

export type StateListener = (state: PlaybackState) => void;

const MAX_FAILOVER_ATTEMPTS = 3;
const MAX_CACHE_SIZE = 8;

interface SynthesizedChunk {
  chunkIndex: number;
  audioData: ArrayBuffer;
  format: string;
  wordTimings?: Array<{ word: string; startTime: number; endTime: number }>;
}

export class Orchestrator {
  private plugin: RecitoPlugin;
  private audioPlayer: AudioPlayer;
  private highlightManager: HighlightManager | null = null;
  private state: PlaybackState;
  private listeners: StateListener[] = [];
  private chunks: TextChunk[] = [];
  private currentSession: PlaybackSession | null = null;
  private sessionGeneration = 0;
  private prefetchCache = new Map<number, SynthesizedChunk>();
  private abortController: AbortController | null = null;
  private currentNotePath: string | null = null;
  private chunkCompleteResolve: (() => void) | null = null;

  constructor(plugin: RecitoPlugin) {
    this.plugin = plugin;
    this.state = {
      status: 'idle',
      currentChunkIndex: 0,
      totalChunks: 0,
      chunkProgress: 0,
      currentTime: 0,
      duration: 0,
      speed: plugin.settings.playback.defaultSpeed,
      volume: plugin.settings.playback.defaultVolume,
    };

    this.audioPlayer = new AudioPlayer({
      onProgress: (currentTime, duration, chunkIndex) => {
        if (this.state.currentChunkIndex === chunkIndex) {
          this.updateState({
            currentTime,
            duration,
            chunkProgress: duration > 0 ? currentTime / duration : 0,
          });
          onPlaybackProgress(chunkIndex, currentTime, duration);
        }
      },
      onChunkComplete: (chunkIndex) => {
        if (this.chunkCompleteResolve && this.state.currentChunkIndex === chunkIndex) {
          this.chunkCompleteResolve();
          this.chunkCompleteResolve = null;
        }
      },
    });

    // Wire word timing to highlighting
    setWordTimingCallback((chunkIndex, wordIndex, word, startTime, endTime) => {
      if (!this.highlightManager || this.state.currentChunkIndex !== chunkIndex) return;
      const chunk = this.chunks[chunkIndex];
      if (!chunk) return;

      // Find word position in chunk text, then add chunk's global offset
      const words = chunk.text.split(/\s+/).filter(Boolean);
      let charPos = 0;
      for (let i = 0; i < wordIndex && i < words.length; i++) {
        const idx = chunk.text.indexOf(words[i], charPos);
        if (idx >= 0) charPos = idx + words[i].length;
      }
      const wordStartInChunk = chunk.text.indexOf(word, charPos);
      if (wordStartInChunk < 0) return;

      const globalStart = chunk.startOffset + wordStartInChunk;
      const globalEnd = globalStart + word.length;
      this.highlightManager.highlightWord(globalStart, globalEnd);

      // Highlight containing sentence
      const sentenceStart = chunk.startOffset;
      const sentenceEnd = chunk.endOffset;
      this.highlightManager.highlightSentence(sentenceStart, sentenceEnd);
    });
  }

  getState(): PlaybackState {
    return { ...this.state };
  }

  onStateChange(listener: StateListener): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }

  private updateState(partial: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...partial };
    const snapshot = { ...this.state };
    for (const listener of this.listeners) listener(snapshot);
  }

  private setStatus(status: PlaybackStatus): void {
    this.updateState({ status });
  }

  async startPlayback(containerEl: HTMLElement, notePath: string): Promise<void> {
    this.stopPlayback();
    this.abortController = new AbortController();
    this.currentNotePath = notePath;
    this.setStatus('loading');

    // Extract text from Reading View
    const textMap = extractFromReadingView(containerEl);
    if (!textMap) {
      this.setStatus('idle');
      return;
    }

    // Initialize session
    try {
      await this.initSession();
    } catch (err) {
      this.setStatus('idle');
      console.error('Session init failed:', err);
      return;
    }

    // Chunk the text
    const chunkConfig = getChunkLimits(this.currentSession!.providerId);
    this.chunks = chunkText(textMap.text, chunkConfig);
    if (this.chunks.length === 0) {
      this.setStatus('idle');
      return;
    }

    // Set up highlighting
    const settings = this.plugin.settings;
    const colors = highlightColorsFromAccent(settings.accentColor);
    const resolvedHighlight = resolveHighlightSettings(settings.highlight, settings.accentColor);
    this.highlightManager = new HighlightManager(resolvedHighlight);

    const previewSection = containerEl.querySelector('.markdown-reading-view .markdown-preview-section');
    if (previewSection) {
      this.highlightManager.init(previewSection);
      initAutoScroll(containerEl.querySelector('.markdown-reading-view') ?? containerEl);
      initClickToSeek(this.highlightManager, this.chunks, (chunkIndex) => {
        this.skipToChunk(chunkIndex);
      });
    }

    // Check for saved progress
    let startIndex = 0;
    const saved = settings.readingProgress[notePath];
    if (saved && saved.chunkIndex > 0 && saved.chunkIndex < this.chunks.length) {
      startIndex = saved.chunkIndex;
    }

    this.updateState({ totalChunks: this.chunks.length, currentChunkIndex: startIndex });

    // Start playback loop
    await this.playChunksSequentially(startIndex);
  }

  private async initSession(): Promise<void> {
    const settings = this.plugin.settings;
    const activeGroup = settings.activeProviderGroup;
    if (!activeGroup) throw new Error('No TTS provider configured.');

    const config = settings.providers.find((p) => this.getProviderGroupKey(p) === activeGroup);
    if (!config) throw new Error('No provider config found for active group.');

    const provider = getProvider(config.providerId);
    let voices = getCachedVoices(config.id);
    if (!voices) {
      voices = await provider.listVoices(config);
      setCachedVoices(config.id, voices);
    }

    const voice = voices.find((v) => v.id === settings.activeVoiceId) ?? voices[0];
    if (!voice) throw new Error('No voice available.');

    this.sessionGeneration++;
    this.currentSession = {
      config,
      voice,
      providerId: config.providerId,
      generation: this.sessionGeneration,
    };
  }

  private getProviderGroupKey(config: ProviderConfig): string {
    if (config.providerId === 'custom') {
      return `custom:${(config.baseUrl || '').trim().replace(/\/+$/, '')}`;
    }
    return config.providerId;
  }

  async resumePlayback(): Promise<void> {
    if (this.state.status !== 'paused') return;
    this.setStatus('playing');
    this.audioPlayer.resume();
    setClickToSeekActive(true);
  }

  pausePlayback(): void {
    if (this.state.status !== 'playing') return;
    this.setStatus('paused');
    this.audioPlayer.pause();
  }

  stopPlayback(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.prefetchCache.clear();
    this.audioPlayer.stop();
    stopWordTimingRelay();

    if (this.highlightManager) {
      this.highlightManager.destroy();
      this.highlightManager = null;
    }
    destroyAutoScroll();
    destroyClickToSeek();

    // Clear progress on explicit stop
    if (this.currentNotePath) {
      const progress = { ...this.plugin.settings.readingProgress };
      delete progress[this.currentNotePath];
      this.plugin.settings.readingProgress = progress;
      this.plugin.saveSettings();
      this.currentNotePath = null;
    }

    this.currentSession = null;
    this.chunks = [];
    this.chunkCompleteResolve = null;
    this.updateState({
      status: 'idle',
      currentChunkIndex: 0,
      totalChunks: 0,
      chunkProgress: 0,
      currentTime: 0,
      duration: 0,
    });
  }

  async skipForward(): Promise<void> {
    if (this.state.status === 'idle') return;
    const next = this.state.currentChunkIndex + 1;
    if (next >= this.state.totalChunks) { this.stopPlayback(); return; }
    await this.skipToChunk(next);
  }

  async skipBackward(): Promise<void> {
    if (this.state.status === 'idle') return;
    await this.skipToChunk(Math.max(0, this.state.currentChunkIndex - 1));
  }

  async skipToChunk(chunkIndex: number): Promise<void> {
    if (this.state.status === 'idle') return;
    stopWordTimingRelay();
    this.audioPlayer.stop();
    this.abortController?.abort();
    this.abortController = new AbortController();
    this.updateState({ currentChunkIndex: chunkIndex, status: 'loading' });
    await this.playChunksSequentially(chunkIndex);
  }

  setSpeed(speed: number): void {
    this.updateState({ speed });
    const providerId = this.currentSession?.config.providerId;
    const range = providerId ? PROVIDER_SPEED_RANGES[providerId] ?? null : null;
    const serverSpeed = range ? Math.min(Math.max(speed, range.min), range.max) : 1.0;
    const residual = serverSpeed !== 0 ? speed / serverSpeed : speed;
    this.audioPlayer.setSpeed(residual);
  }

  setVolume(volume: number): void {
    this.updateState({ volume });
    this.audioPlayer.setVolume(volume);
  }

  dispose(): void {
    this.stopPlayback();
    this.audioPlayer.dispose();
    setWordTimingCallback(null);
    resetAllHealth();
  }

  private async playChunksSequentially(startIndex: number): Promise<void> {
    const signal = this.abortController?.signal;

    for (let i = startIndex; i < this.chunks.length; i++) {
      if (signal?.aborted) return;
      this.updateState({ currentChunkIndex: i, status: 'loading' });

      let synthesized: SynthesizedChunk;
      const cached = this.prefetchCache.get(i);
      if (cached) {
        synthesized = cached;
      } else {
        try {
          synthesized = await this.synthesizeChunkWithFailover(i);
        } catch (err) {
          if (signal?.aborted) return;
          console.error('Synthesis error:', err);
          this.setStatus('idle');
          return;
        }
      }

      if (signal?.aborted) return;
      if (!this.prefetchCache.has(i)) this.prefetchCache.set(i, synthesized);

      // Prefetch
      const gen = this.sessionGeneration;
      for (let j = 1; j <= LOOKAHEAD_BUFFER_SIZE; j++) {
        const pi = i + j;
        if (pi < this.chunks.length && !this.prefetchCache.has(pi)) {
          this.synthesizeChunk(pi)
            .then((result) => {
              if (!signal?.aborted && this.sessionGeneration === gen) {
                this.prefetchCache.set(pi, result);
              }
            })
            .catch(() => {});
        }
      }

      this.evictCache(i);
      this.setStatus('playing');
      setClickToSeekActive(true);

      if (i === startIndex) {
        await this.audioPlayer.play(synthesized.audioData, i);
      } else {
        await this.audioPlayer.scheduleNext(synthesized.audioData, i);
      }

      // Start word timing
      const chunk = this.chunks[i];
      if (chunk) {
        startWordTimingRelay(i, chunk.text, synthesized.wordTimings);
      }

      // Wait for chunk to complete
      await this.waitForChunkComplete(i, signal);
      if (signal?.aborted) return;

      // Save progress
      if (this.currentNotePath) {
        this.plugin.settings.readingProgress[this.currentNotePath] = {
          notePath: this.currentNotePath,
          chunkIndex: i + 1,
          totalChunks: this.chunks.length,
          timestamp: Date.now(),
        };
        this.plugin.saveSettings();
      }
    }

    // Done — clear progress and stop
    if (this.currentNotePath) {
      const progress = { ...this.plugin.settings.readingProgress };
      delete progress[this.currentNotePath];
      this.plugin.settings.readingProgress = progress;
      this.plugin.saveSettings();
    }
    this.stopPlayback();
  }

  private async synthesizeChunk(chunkIndex: number): Promise<SynthesizedChunk> {
    const session = this.currentSession;
    if (!session) throw new Error('No active session.');
    const chunk = this.chunks[chunkIndex];
    if (!chunk) throw new Error(`No chunk at index ${chunkIndex}`);

    const provider = getProvider(session.config.providerId);
    const rawSpeed = this.state.speed;
    const range = PROVIDER_SPEED_RANGES[session.config.providerId] ?? null;
    const serverSpeed = range ? Math.min(Math.max(rawSpeed, range.min), range.max) : 1.0;

    const result = await provider.synthesize(chunk.text, session.voice, session.config, { speed: serverSpeed });
    return { chunkIndex, audioData: result.audioData, format: result.format, wordTimings: result.wordTimings };
  }

  private async synthesizeChunkWithFailover(chunkIndex: number): Promise<SynthesizedChunk> {
    let attempts = 0;
    while (attempts < MAX_FAILOVER_ATTEMPTS) {
      try {
        return await this.synthesizeChunk(chunkIndex);
      } catch (err) {
        attempts++;
        if (!(err instanceof ApiError) || !err.retryable) {
          if (err instanceof ApiError) markFailed(this.currentSession!.config.id, err);
          throw err;
        }
        const failedConfigId = this.currentSession!.config.id;
        if ((err.status >= 500 || err.status === 0) && attempts === 1) {
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (attempts - 1), 8000)));
          continue;
        }
        markFailed(failedConfigId, err);
        const candidate = await getNextCandidate(this.currentSession!, failedConfigId, this.plugin.settings.providers);
        if (!candidate) throw new Error(`All API keys exhausted. Last: ${err.message}`);
        this.currentSession = { ...this.currentSession!, config: candidate, generation: ++this.sessionGeneration };
        this.prefetchCache.clear();
      }
    }
    throw new Error('Max failover attempts exceeded.');
  }

  private waitForChunkComplete(chunkIndex: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) { resolve(); return; }
      this.chunkCompleteResolve = resolve;
      signal?.addEventListener('abort', () => { this.chunkCompleteResolve = null; resolve(); });
    });
  }

  private evictCache(currentIndex: number): void {
    if (this.prefetchCache.size <= MAX_CACHE_SIZE) return;
    const entries = [...this.prefetchCache.keys()].sort(
      (a, b) => Math.abs(b - currentIndex) - Math.abs(a - currentIndex),
    );
    while (this.prefetchCache.size > MAX_CACHE_SIZE && entries.length > 0) {
      this.prefetchCache.delete(entries.shift()!);
    }
  }
}
```

- [ ] **Step 2: Create `src/lib/accent-colors.ts`**

```ts
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
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors (the `import type RecitoPlugin from './main'` will resolve once main.ts is updated in Task 8).

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator.ts src/lib/accent-colors.ts
git commit -m "feat: add orchestrator with session management, failover, and playback loop"
```

---

## Task 7: Sidebar View

**Files:**
- Create: `src/sidebar.ts`

- [ ] **Step 1: Create `src/sidebar.ts`**

```ts
import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { PlaybackState } from './lib/types';
import { SPEED_PRESETS } from './lib/constants';
import type RecitoPlugin from './main';

export const SIDEBAR_VIEW_TYPE = 'recito-sidebar';

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class RecitoSidebarView extends ItemView {
  private plugin: RecitoPlugin;
  private unsubscribe: (() => void) | null = null;

  // DOM elements
  private playBtn!: HTMLButtonElement;
  private skipBackBtn!: HTMLButtonElement;
  private skipFwdBtn!: HTMLButtonElement;
  private progressBar!: HTMLElement;
  private progressFill!: HTMLElement;
  private timeDisplay!: HTMLElement;
  private noteTitle!: HTMLElement;
  private speedContainer!: HTMLElement;
  private volumeSlider!: HTMLInputElement;
  private providerDisplay!: HTMLElement;
  private idleContainer!: HTMLElement;
  private playingContainer!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: RecitoPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return SIDEBAR_VIEW_TYPE; }
  getDisplayText(): string { return 'Recito'; }
  getIcon(): string { return 'headphones'; }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('recito-sidebar');

    // Idle state
    this.idleContainer = contentEl.createDiv({ cls: 'recito-idle' });
    this.idleContainer.createEl('div', { cls: 'recito-idle-icon', text: '\uD83C\uDFA7' });
    this.idleContainer.createEl('div', { cls: 'recito-idle-title', text: 'Ready to Read' });
    this.idleContainer.createEl('div', { cls: 'recito-idle-subtitle', text: 'Open a note and press play' });
    const idlePlayBtn = this.idleContainer.createEl('button', { cls: 'recito-idle-play-btn', text: '\u25B6' });
    idlePlayBtn.addEventListener('click', () => this.plugin.startPlayback());

    // Playing state
    this.playingContainer = contentEl.createDiv({ cls: 'recito-playing' });
    this.playingContainer.style.display = 'none';

    this.noteTitle = this.playingContainer.createEl('div', { cls: 'recito-note-title' });
    this.timeDisplay = this.playingContainer.createEl('div', { cls: 'recito-time' });

    // Progress bar
    this.progressBar = this.playingContainer.createDiv({ cls: 'recito-progress-bar' });
    this.progressFill = this.progressBar.createDiv({ cls: 'recito-progress-fill' });

    // Controls
    const controls = this.playingContainer.createDiv({ cls: 'recito-controls' });
    this.skipBackBtn = controls.createEl('button', { cls: 'recito-control-btn', text: '\u23EE' });
    this.playBtn = controls.createEl('button', { cls: 'recito-play-btn', text: '\u23F8' });
    this.skipFwdBtn = controls.createEl('button', { cls: 'recito-control-btn', text: '\u23ED' });

    this.skipBackBtn.addEventListener('click', () => this.plugin.orchestrator?.skipBackward());
    this.playBtn.addEventListener('click', () => this.plugin.togglePlayback());
    this.skipFwdBtn.addEventListener('click', () => this.plugin.orchestrator?.skipForward());

    // Speed
    this.speedContainer = this.playingContainer.createDiv({ cls: 'recito-speed' });
    this.speedContainer.createEl('span', { cls: 'recito-label', text: 'Speed' });
    const speedBtns = this.speedContainer.createDiv({ cls: 'recito-speed-btns' });
    for (const preset of SPEED_PRESETS) {
      const btn = speedBtns.createEl('button', {
        cls: 'recito-speed-btn',
        text: `${preset}x`,
      });
      btn.dataset.speed = String(preset);
      btn.addEventListener('click', () => this.plugin.orchestrator?.setSpeed(preset));
    }

    // Volume
    const volumeRow = this.playingContainer.createDiv({ cls: 'recito-volume' });
    volumeRow.createEl('span', { cls: 'recito-label', text: 'Volume' });
    this.volumeSlider = volumeRow.createEl('input', { type: 'range', cls: 'recito-volume-slider' });
    this.volumeSlider.min = '0';
    this.volumeSlider.max = '1';
    this.volumeSlider.step = '0.05';
    this.volumeSlider.value = String(this.plugin.settings.playback.defaultVolume);
    this.volumeSlider.addEventListener('input', () => {
      this.plugin.orchestrator?.setVolume(parseFloat(this.volumeSlider.value));
    });

    // Provider
    this.providerDisplay = this.playingContainer.createDiv({ cls: 'recito-provider' });

    // Subscribe to state changes
    if (this.plugin.orchestrator) {
      this.unsubscribe = this.plugin.orchestrator.onStateChange((state) => this.render(state));
      this.render(this.plugin.orchestrator.getState());
    }
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  render(state: PlaybackState): void {
    const isIdle = state.status === 'idle';
    this.idleContainer.style.display = isIdle ? '' : 'none';
    this.playingContainer.style.display = isIdle ? 'none' : '';

    if (isIdle) return;

    // Note title
    const activeFile = this.app.workspace.getActiveFile();
    this.noteTitle.textContent = activeFile?.basename ?? 'Untitled';

    // Time display — elapsed / estimated total
    const chunkDuration = state.duration > 0 ? state.duration : 0;
    const elapsed = state.currentChunkIndex * chunkDuration + state.currentTime;
    const estimatedTotal = state.totalChunks * chunkDuration;
    this.timeDisplay.textContent = `${formatTime(elapsed)} / ${formatTime(estimatedTotal)}`;

    // Progress
    const overallProgress = state.totalChunks > 0
      ? (state.currentChunkIndex + state.chunkProgress) / state.totalChunks
      : 0;
    this.progressFill.style.width = `${overallProgress * 100}%`;

    // Play/pause button
    this.playBtn.textContent = state.status === 'playing' ? '\u23F8' : '\u25B6';

    // Speed buttons
    const speedBtns = this.speedContainer.querySelectorAll('.recito-speed-btn');
    speedBtns.forEach((btn) => {
      const el = btn as HTMLElement;
      el.toggleClass('is-active', parseFloat(el.dataset.speed ?? '0') === state.speed);
    });

    // Volume
    this.volumeSlider.value = String(state.volume);

    // Provider
    const activeGroup = this.plugin.settings.activeProviderGroup;
    const activeVoice = this.plugin.settings.activeVoiceId;
    this.providerDisplay.textContent = `${activeGroup ?? 'None'} \u2014 ${activeVoice ?? ''}`;
  }
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: May show errors about missing `RecitoPlugin.startPlayback`, `togglePlayback`, `orchestrator` — these are wired up in Task 8.

- [ ] **Step 3: Commit**

```bash
git add src/sidebar.ts
git commit -m "feat: add sidebar view with playback controls and state rendering"
```

---

## Task 8: Plugin Entry Point and Settings

**Files:**
- Modify: `src/main.ts` (complete rewrite)
- Modify: `src/settings.ts` (complete rewrite)
- Modify: `manifest.json`

- [ ] **Step 1: Rewrite `src/settings.ts`**

```ts
import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type RecitoPlugin from './main';
import type { ProviderConfig } from './lib/types';
import { ACCENT_COLOR_PRESETS, SPEED_PRESETS } from './lib/constants';
import { PROVIDER_LIST, getProvider } from './providers/registry';
import { invalidateVoiceCache } from './providers/voice-cache';

export class RecitoSettingTab extends PluginSettingTab {
  plugin: RecitoPlugin;

  constructor(app: App, plugin: RecitoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Providers section ---
    containerEl.createEl('h2', { text: 'Providers' });

    for (const meta of PROVIDER_LIST) {
      const configs = this.plugin.settings.providers.filter((p) => p.providerId === meta.id);
      const groupKey = meta.id === 'custom' ? null : meta.id;
      const isActive = this.plugin.settings.activeProviderGroup === groupKey;

      const setting = new Setting(containerEl)
        .setName(meta.name)
        .setDesc(configs.length > 0 ? `${configs.length} API key(s) configured` : 'Not configured');

      if (configs.length > 0 && !isActive) {
        setting.addButton((btn) =>
          btn.setButtonText('Set Active').onClick(async () => {
            this.plugin.settings.activeProviderGroup = groupKey;
            await this.plugin.saveSettings();
            this.display();
          }),
        );
      }
      if (isActive) {
        setting.addButton((btn) => btn.setButtonText('Active').setDisabled(true));
      }

      // Show existing keys
      for (const config of configs) {
        const keySetting = new Setting(containerEl)
          .setName(`  API Key: ••••${config.apiKey.slice(-4)}`)
          .setDesc(config.name);

        keySetting.addButton((btn) =>
          btn.setButtonText('Test').onClick(async () => {
            const provider = getProvider(config.providerId);
            const valid = await provider.validateKey(config);
            new Notice(valid ? 'API key is valid!' : 'API key validation failed.');
          }),
        );

        keySetting.addButton((btn) =>
          btn.setButtonText('Remove').setWarning().onClick(async () => {
            this.plugin.settings.providers = this.plugin.settings.providers.filter((p) => p.id !== config.id);
            invalidateVoiceCache(config.id);
            await this.plugin.saveSettings();
            this.display();
          }),
        );
      }

      // Add key button
      new Setting(containerEl).addButton((btn) =>
        btn.setButtonText(`+ Add ${meta.name} key`).onClick(() => {
          this.showAddKeyModal(meta.id, meta.name);
        }),
      );
    }

    // --- Playback section ---
    containerEl.createEl('h2', { text: 'Playback' });

    new Setting(containerEl)
      .setName('Default speed')
      .addDropdown((dd) => {
        for (const s of SPEED_PRESETS) dd.addOption(String(s), `${s}x`);
        dd.setValue(String(this.plugin.settings.playback.defaultSpeed));
        dd.onChange(async (val) => {
          this.plugin.settings.playback.defaultSpeed = parseFloat(val);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Auto-scroll')
      .setDesc('Scroll to keep highlighted text visible')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.playback.autoScrollEnabled);
        toggle.onChange(async (val) => {
          this.plugin.settings.playback.autoScrollEnabled = val;
          this.plugin.settings.highlight.autoScroll = val;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Prefetch buffer')
      .setDesc('Chunks to synthesize ahead for gapless playback')
      .addDropdown((dd) => {
        dd.addOption('1', '1');
        dd.addOption('2', '2');
        dd.addOption('3', '3');
        dd.setValue(String(this.plugin.settings.playback.bufferSize));
        dd.onChange(async (val) => {
          this.plugin.settings.playback.bufferSize = parseInt(val);
          await this.plugin.saveSettings();
        });
      });

    // --- Appearance section ---
    containerEl.createEl('h2', { text: 'Appearance' });

    new Setting(containerEl)
      .setName('Accent color')
      .setDesc('Used for highlights and UI accents')
      .addColorPicker((cp) => {
        cp.setValue(this.plugin.settings.accentColor ?? ACCENT_COLOR_PRESETS[0]);
        cp.onChange(async (val) => {
          this.plugin.settings.accentColor = val;
          await this.plugin.saveSettings();
        });
      });
  }

  private showAddKeyModal(providerId: string, providerName: string): void {
    // Simple approach: use a Setting with text inputs inline
    // For v1, just prompt for API key via a Notice + re-display
    const apiKey = prompt(`Enter ${providerName} API key:`);
    if (!apiKey) return;

    const newConfig: ProviderConfig = {
      id: crypto.randomUUID(),
      providerId,
      name: `${providerName} Key ${this.plugin.settings.providers.filter((p) => p.providerId === providerId).length + 1}`,
      apiKey: apiKey.trim(),
    };

    this.plugin.settings.providers.push(newConfig);

    // Auto-set active if first provider
    if (!this.plugin.settings.activeProviderGroup) {
      this.plugin.settings.activeProviderGroup = providerId === 'custom'
        ? `custom:${(newConfig.baseUrl || '').trim().replace(/\/+$/, '')}`
        : providerId;
    }

    this.plugin.saveSettings();
    this.display();
  }
}
```

- [ ] **Step 2: Rewrite `src/main.ts`**

```ts
import { MarkdownView, Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import type { RecitoSettings } from './lib/types';
import { DEFAULT_SETTINGS, READING_PROGRESS_MAX_AGE_MS } from './lib/constants';
import { RecitoSettingTab } from './settings';
import { RecitoSidebarView, SIDEBAR_VIEW_TYPE } from './sidebar';
import { Orchestrator } from './orchestrator';

export default class RecitoPlugin extends Plugin {
  settings!: RecitoSettings;
  orchestrator!: Orchestrator;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.orchestrator = new Orchestrator(this);

    // Register sidebar view
    this.registerView(SIDEBAR_VIEW_TYPE, (leaf) => new RecitoSidebarView(leaf, this));

    // Ribbon icon — start playback
    this.addRibbonIcon('headphones', 'Recito: Read aloud', () => {
      this.startPlayback();
    });

    // Commands
    this.addCommand({
      id: 'start-reading',
      name: 'Start reading',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (!checking) this.startPlayback();
        return true;
      },
    });

    this.addCommand({
      id: 'pause-resume',
      name: 'Pause / Resume',
      callback: () => this.togglePlayback(),
    });

    this.addCommand({
      id: 'stop-reading',
      name: 'Stop reading',
      callback: () => this.orchestrator.stopPlayback(),
    });

    this.addCommand({
      id: 'skip-forward',
      name: 'Skip forward',
      callback: () => this.orchestrator.skipForward(),
    });

    this.addCommand({
      id: 'skip-backward',
      name: 'Skip backward',
      callback: () => this.orchestrator.skipBackward(),
    });

    this.addCommand({
      id: 'toggle-sidebar',
      name: 'Toggle sidebar',
      callback: () => this.toggleSidebar(),
    });

    // Settings tab
    this.addSettingTab(new RecitoSettingTab(this.app, this));

    // Detect note/view changes
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const state = this.orchestrator.getState();
        if (state.status === 'playing' || state.status === 'paused') {
          // Pause if user navigates away
          if (state.status === 'playing') {
            this.orchestrator.pausePlayback();
          }
        }
      }),
    );

    // Clean old reading progress on load
    this.cleanOldProgress();
  }

  onunload(): void {
    this.orchestrator.dispose();
    this.app.workspace.detachLeavesOfType(SIDEBAR_VIEW_TYPE);
  }

  async startPlayback(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice('Open a note first.');
      return;
    }

    // Switch to reading view
    const viewState = view.leaf.getViewState();
    if (viewState.state?.mode !== 'preview') {
      await view.leaf.setViewState({
        ...viewState,
        state: { ...viewState.state, mode: 'preview' },
      });
      // Wait for reading view to render
      await new Promise((r) => setTimeout(r, 200));
    }

    const file = view.file;
    if (!file) return;

    // Ensure sidebar is open
    await this.activateSidebar();

    await this.orchestrator.startPlayback(view.containerEl, file.path);
  }

  togglePlayback(): void {
    const state = this.orchestrator.getState();
    if (state.status === 'playing') {
      this.orchestrator.pausePlayback();
    } else if (state.status === 'paused') {
      this.orchestrator.resumePlayback();
    } else {
      this.startPlayback();
    }
  }

  async activateSidebar(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
    if (existing.length > 0) return;

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
    }
  }

  async toggleSidebar(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
    if (existing.length > 0) {
      existing.forEach((leaf) => leaf.detach());
    } else {
      await this.activateSidebar();
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<RecitoSettings>);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private cleanOldProgress(): void {
    const progress = this.settings.readingProgress;
    const now = Date.now();
    let changed = false;
    for (const key of Object.keys(progress)) {
      if (now - progress[key].timestamp > READING_PROGRESS_MAX_AGE_MS) {
        delete progress[key];
        changed = true;
      }
    }
    if (changed) this.saveSettings();
  }
}
```

- [ ] **Step 3: Update `manifest.json`**

```json
{
  "id": "recito",
  "name": "Recito",
  "version": "1.0.0",
  "minAppVersion": "0.15.0",
  "description": "Read your notes aloud with karaoke-style word highlighting. Supports OpenAI, ElevenLabs, Groq, Mimo, and custom TTS providers.",
  "author": "allgemeiner-intellekt",
  "isDesktopOnly": true
}
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Build succeeds, `main.js` is generated.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/settings.ts manifest.json
git commit -m "feat: wire up plugin entry point, settings tab, and sidebar integration"
```

---

## Task 9: Styles

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: Write `styles.css`**

```css
/* Sidebar */
.recito-sidebar {
  padding: 12px;
}

.recito-idle {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  text-align: center;
}

.recito-idle-icon {
  font-size: 36px;
  margin-bottom: 12px;
  opacity: 0.6;
}

.recito-idle-title {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 4px;
}

.recito-idle-subtitle {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 20px;
}

.recito-idle-play-btn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  border: none;
  font-size: 20px;
  cursor: pointer;
}

.recito-idle-play-btn:hover {
  background: var(--interactive-accent-hover);
}

/* Playing state */
.recito-note-title {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recito-time {
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 12px;
}

.recito-progress-bar {
  height: 4px;
  background: var(--background-modifier-border);
  border-radius: 2px;
  margin-bottom: 16px;
  cursor: pointer;
}

.recito-progress-fill {
  height: 100%;
  background: var(--interactive-accent);
  border-radius: 2px;
  transition: width 0.1s linear;
}

.recito-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 20px;
  margin-bottom: 16px;
}

.recito-control-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  cursor: pointer;
  padding: 4px;
}

.recito-control-btn:hover {
  color: var(--text-normal);
}

.recito-play-btn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  border: none;
  font-size: 20px;
  cursor: pointer;
}

.recito-play-btn:hover {
  background: var(--interactive-accent-hover);
}

/* Speed */
.recito-speed {
  margin-bottom: 12px;
}

.recito-label {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  display: block;
  margin-bottom: 4px;
}

.recito-speed-btns {
  display: flex;
  gap: 4px;
}

.recito-speed-btn {
  padding: 3px 8px;
  background: var(--background-modifier-border);
  border: none;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  color: var(--text-normal);
}

.recito-speed-btn.is-active {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  font-weight: 500;
}

/* Volume */
.recito-volume {
  margin-bottom: 16px;
}

.recito-volume-slider {
  width: 100%;
  margin-top: 4px;
}

/* Provider */
.recito-provider {
  font-size: 12px;
  color: var(--text-muted);
  padding-top: 12px;
  border-top: 1px solid var(--background-modifier-border);
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add styles.css
git commit -m "feat: add sidebar styles using Obsidian CSS variables"
```

---

## Task 10: Final Integration and Manual Test

- [ ] **Step 1: Run full production build**

Run: `npm run build`
Expected: No errors. `main.js` and `styles.css` exist at root.

- [ ] **Step 2: Verify plugin loads in Obsidian**

1. Reload Obsidian (Ctrl/Cmd + R in dev mode)
2. Go to Settings → Community plugins → Enable "Recito"
3. Verify: ribbon icon appears (headphones)
4. Verify: Settings → Recito tab shows Providers, Playback, Appearance sections
5. Verify: Command palette shows "Recito: Start reading", "Recito: Pause / Resume", etc.

- [ ] **Step 3: Add an API key and test basic playback**

1. In Settings → Recito → Providers → Click "+ Add OpenAI key"
2. Enter a valid API key
3. Open any note with text
4. Click the ribbon icon
5. Verify: switches to reading view, sidebar opens, audio plays, words highlight

- [ ] **Step 4: Test click-to-seek**

1. While playing, click on a different sentence
2. Verify: playback jumps to that sentence

- [ ] **Step 5: Commit final state**

```bash
git add -A
git commit -m "feat: complete Recito v1 — TTS with karaoke highlighting in Obsidian"
```
