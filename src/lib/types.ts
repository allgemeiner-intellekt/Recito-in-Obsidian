// === Provider Types ===

export interface ProviderConfig {
  id: string;
  providerId: string; // 'openai' | 'elevenlabs' | 'groq' | 'mimo' | 'custom'
  name: string;
  apiKey: string;
  baseUrl?: string;
  extraParams?: Record<string, unknown>;
  /** When true, this key is excluded from pool selection and failover. */
  disabled?: boolean;
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
  sourceElement: Element;
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
