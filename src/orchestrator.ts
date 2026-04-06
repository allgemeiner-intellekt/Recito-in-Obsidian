import type RecitoPlugin from './main';
import type { PlaybackState, TextChunk, PlaybackStatus, ProviderConfig } from './lib/types';
import { AudioPlayer } from './audio-player';
import { HighlightManager } from './highlighting/highlight-manager';
import { extractFromReadingView } from './extraction/extractor';
import { chunkText } from './extraction/chunker';
import { getProvider, getChunkLimits } from './providers/registry';
import { markFailed, getNextCandidate, getHealth } from './providers/failover';
import type { PlaybackSession } from './providers/failover';
import { getCachedVoices, setCachedVoices } from './providers/voice-cache';
import { getGroupKey } from './lib/group-key';
import { ApiError } from './lib/api-error';
import {
  LOOKAHEAD_BUFFER_SIZE,
  PROVIDER_SPEED_RANGES,
  READING_PROGRESS_MAX_AGE_MS,
  PROGRESS_SAVE_MIN_INTERVAL_MS,
  PROGRESS_SAVE_CHUNK_STRIDE,
} from './lib/constants';
import { resolveHighlightSettings } from './lib/accent-colors';
import { startWordTiming, stopWordTiming, onPlaybackProgress } from './word-timing';
import { initAutoScroll, destroyAutoScroll } from './highlighting/auto-scroll';
import { initClickToSeek, destroyClickToSeek, setClickToSeekActive } from './highlighting/click-to-seek';

const MAX_FAILOVER_ATTEMPTS = 3;

interface SynthesizedChunk {
  chunkIndex: number;
  audioData: ArrayBuffer;
  format: string;
  wordTimings?: Array<{ word: string; startTime: number; endTime: number }>;
}

export type PlaybackStateListener = (state: PlaybackState) => void;

export class Orchestrator {
  private plugin: RecitoPlugin;
  private audioPlayer: AudioPlayer;
  private highlightManager: HighlightManager | null = null;

  // Playback state
  private state: PlaybackState = {
    status: 'idle',
    currentChunkIndex: 0,
    totalChunks: 0,
    chunkProgress: 0,
    currentTime: 0,
    duration: 0,
    speed: 1.0,
    volume: 1.0,
  };
  private listeners: Set<PlaybackStateListener> = new Set();

  // Session state
  private currentSession: PlaybackSession | null = null;
  private sessionGeneration = 0;
  private abortController: AbortController | null = null;
  private prefetchCache = new Map<number, SynthesizedChunk>();
  private MAX_CACHE_SIZE = 8;

  // Current extraction state
  private chunks: TextChunk[] = [];
  private containerEl: HTMLElement | null = null;
  private notePath: string | null = null;

  // Chunk completion: resolve callbacks keyed by chunkIndex
  private chunkCompleteResolvers = new Map<number, () => void>();

  // Throttling for progress writes during the playback loop
  private lastProgressSaveTs = 0;
  private lastProgressSavedChunk = -1;

  constructor(plugin: RecitoPlugin) {
    this.plugin = plugin;
    this.audioPlayer = new AudioPlayer({
      onProgress: (currentTime, duration, chunkIndex) => {
        this.updateState({
          currentTime,
          duration,
          chunkProgress: duration > 0 ? currentTime / duration : 0,
        });
        onPlaybackProgress(chunkIndex, currentTime, duration);
      },
      onChunkComplete: (chunkIndex) => {
        const resolve = this.chunkCompleteResolvers.get(chunkIndex);
        if (resolve) {
          this.chunkCompleteResolvers.delete(chunkIndex);
          resolve();
        }
      },
    });
  }

  // =========================================================================
  // State management
  // =========================================================================

  getState(): PlaybackState {
    return { ...this.state };
  }

  addListener(listener: PlaybackStateListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: PlaybackStateListener): void {
    this.listeners.delete(listener);
  }

  private updateState(partial: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...partial };
    this.notifyListeners();
  }

  private setStatus(status: PlaybackStatus): void {
    this.updateState({ status });
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener({ ...this.state });
    }
  }

  // =========================================================================
  // Session initialization
  // =========================================================================

  private async initSession(): Promise<PlaybackSession> {
    const settings = this.plugin.settings;

    const providers = settings.providers;
    if (!providers || providers.length === 0) {
      throw new Error('No TTS provider configured. Please add one in Settings.');
    }

    // Resolve the active pool. activeProviderGroup is a group key (provider type or
    // custom@<baseUrl>). Pick the first enabled, healthy key in that pool. If none
    // are healthy, fall back to the first enabled key and let failover try.
    const activeGroup = settings.activeProviderGroup;
    const pool = activeGroup
      ? providers.filter((p) => !p.disabled && getGroupKey(p) === activeGroup)
      : providers.filter((p) => !p.disabled);

    if (pool.length === 0) {
      throw new Error(
        activeGroup
          ? 'No enabled keys in the active provider pool. Enable a key or pick a different provider in Settings.'
          : 'No enabled TTS provider keys. Add or enable one in Settings.',
      );
    }

    const providerConfig: ProviderConfig =
      pool.find((p) => getHealth(p.id).status === 'healthy') ?? pool[0]!;

    const provider = getProvider(providerConfig.providerId);

    let voices = getCachedVoices(providerConfig.id);
    if (!voices) {
      voices = await provider.listVoices(providerConfig);
      setCachedVoices(providerConfig.id, voices);
    }

    const voiceId = settings.activeVoiceId;
    const voice = voices.find((v) => v.id === voiceId) ?? voices[0];
    if (!voice) {
      throw new Error('No voice available for this provider.');
    }

    this.sessionGeneration++;
    const session: PlaybackSession = {
      config: providerConfig,
      voice,
      providerId: providerConfig.providerId,
      generation: this.sessionGeneration,
    };
    this.currentSession = session;
    return session;
  }

  // =========================================================================
  // Public playback controls
  // =========================================================================

  async startPlayback(containerEl: HTMLElement, notePath: string): Promise<void> {
    this.stopPlayback();

    this.containerEl = containerEl;
    this.notePath = notePath;
    this.abortController = new AbortController();

    this.setStatus('loading');

    // Initialize session — lock provider + voice
    try {
      await this.initSession();
    } catch (err) {
      this.setStatus('idle');
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[Recito] Session init failed:', errorMsg);
      return;
    }

    // Extract content from Reading View DOM
    const textMap = extractFromReadingView(containerEl);
    if (!textMap || !textMap.text.trim()) {
      this.setStatus('idle');
      console.error('[Recito] No readable content found in this view.');
      return;
    }

    // Chunk the extracted text
    const session = this.currentSession!;
    const chunkConfig = getChunkLimits(session.providerId);
    this.chunks = chunkText(textMap.text, chunkConfig);

    if (this.chunks.length === 0) {
      this.setStatus('idle');
      console.error('[Recito] No chunks produced from extracted text.');
      return;
    }

    const totalChunks = this.chunks.length;

    // Check for saved reading progress
    let startIndex = 0;
    const saved = this.plugin.settings.readingProgress[notePath];
    if (saved && saved.chunkIndex > 0 && saved.chunkIndex < totalChunks) {
      // Check not expired
      if (Date.now() - saved.timestamp < READING_PROGRESS_MAX_AGE_MS) {
        startIndex = saved.chunkIndex;
      }
    }

    // Set up highlighting
    const resolvedHighlight = resolveHighlightSettings(
      this.plugin.settings.highlight,
      this.plugin.settings.accentColor,
    );
    this.highlightManager = new HighlightManager(resolvedHighlight);
    this.highlightManager.init(textMap.sourceElement);

    // Set up auto-scroll
    const scrollContainer =
      containerEl.querySelector<HTMLElement>('.markdown-reading-view') ?? containerEl;
    initAutoScroll(scrollContainer);

    // Set up click-to-seek
    initClickToSeek(containerEl, this.highlightManager, this.chunks, (chunkIndex) => {
      void this.skipToChunk(chunkIndex);
    });
    setClickToSeekActive(true);

    this.updateState({
      totalChunks,
      currentChunkIndex: startIndex,
      speed: this.plugin.settings.playback.defaultSpeed,
      volume: this.plugin.settings.playback.defaultVolume,
    });

    // Apply initial speed/volume to audio player
    this.audioPlayer.setSpeed(this.state.speed);
    this.audioPlayer.setVolume(this.state.volume);

    // Start the playback loop
    await this.playChunksSequentially(startIndex, totalChunks, notePath);
  }

  pausePlayback(): void {
    if (this.state.status !== 'playing') return;
    this.setStatus('paused');
    this.audioPlayer.pause();

    // Pause is the explicit "save my place" action — flush progress immediately,
    // bypassing the in-loop throttle.
    if (this.notePath && this.state.currentChunkIndex > 0) {
      void this.saveProgress(
        this.notePath,
        this.state.currentChunkIndex,
        this.state.totalChunks,
      );
    }
  }

  resumePlayback(): void {
    if (this.state.status !== 'paused') return;
    this.setStatus('playing');
    this.audioPlayer.resume();
  }

  stopPlayback(opts: { clearProgress?: boolean } = {}): void {
    this.abortController?.abort();
    this.abortController = null;
    this.prefetchCache.clear();
    this.chunkCompleteResolvers.clear();

    // Persist or clear position depending on intent.
    // - clearProgress=true → user pressed "Stop": next play starts from the beginning.
    // - clearProgress=false (default) → internal teardown / dispose: keep resume point.
    if (this.notePath && this.state.status !== 'idle') {
      if (opts.clearProgress) {
        void this.clearProgress(this.notePath);
      } else {
        const chunkIndex = this.state.currentChunkIndex;
        const totalChunks = this.state.totalChunks;
        if (chunkIndex > 0) {
          void this.saveProgress(this.notePath, chunkIndex, totalChunks);
        }
      }
    }

    // Reset throttle so the next session starts clean.
    this.lastProgressSaveTs = 0;
    this.lastProgressSavedChunk = -1;

    this.currentSession = null;
    stopWordTiming();
    this.audioPlayer.stop();

    // Tear down highlighting and interaction
    setClickToSeekActive(false);
    destroyClickToSeek();
    destroyAutoScroll();
    this.highlightManager?.destroy();
    this.highlightManager = null;

    this.chunks = [];
    this.containerEl = null;
    this.notePath = null;

    this.state = {
      status: 'idle',
      currentChunkIndex: 0,
      totalChunks: 0,
      chunkProgress: 0,
      currentTime: 0,
      duration: 0,
      speed: this.state.speed,
      volume: this.state.volume,
    };
    this.notifyListeners();
  }

  async skipForward(): Promise<void> {
    if (this.state.status === 'idle') return;
    const nextChunk = this.state.currentChunkIndex + 1;
    if (nextChunk >= this.state.totalChunks) {
      this.stopPlayback();
      return;
    }
    await this.skipToChunk(nextChunk);
  }

  async skipBackward(): Promise<void> {
    if (this.state.status === 'idle') return;
    const prevChunk = Math.max(0, this.state.currentChunkIndex - 1);
    await this.skipToChunk(prevChunk);
  }

  async skipToChunk(chunkIndex: number): Promise<void> {
    if (this.state.status === 'idle') return;

    stopWordTiming();
    this.audioPlayer.stop();

    // Cancel current loop
    this.abortController?.abort();
    this.abortController = new AbortController();
    this.prefetchCache.clear();
    this.chunkCompleteResolvers.clear();

    this.updateState({ currentChunkIndex: chunkIndex, status: 'loading' });

    const notePath = this.notePath;
    if (notePath) {
      await this.playChunksSequentially(chunkIndex, this.state.totalChunks, notePath);
    }
  }

  setSpeed(speed: number): void {
    this.updateState({ speed });

    // Compute residual playback rate: provider handles server-side speed,
    // audio player covers the gap client-side.
    const providerId = this.currentSession?.config.providerId;
    const range = providerId ? (PROVIDER_SPEED_RANGES[providerId] ?? null) : null;
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
    this.listeners.clear();
  }

  // =========================================================================
  // Playback loop
  // =========================================================================

  private async playChunksSequentially(
    startIndex: number,
    totalChunks: number,
    notePath: string,
  ): Promise<void> {
    const signal = this.abortController?.signal;

    for (let i = startIndex; i < totalChunks; i++) {
      if (signal?.aborted) return;

      this.updateState({ currentChunkIndex: i, status: 'loading' });

      // Synthesize current chunk (or use cache)
      let synthesized: SynthesizedChunk;
      const cached = this.prefetchCache.get(i);
      if (cached) {
        synthesized = cached;
      } else {
        try {
          synthesized = await this.synthesizeChunkWithFailover(i);
        } catch (err) {
          if (signal?.aborted) return;
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error('[Recito] Synthesis error:', errorMsg);
          this.setStatus('idle');
          return;
        }
      }

      if (signal?.aborted) return;

      // Cache for backward skip
      if (!this.prefetchCache.has(i)) {
        this.prefetchCache.set(i, synthesized);
      }

      // Start prefetching next chunks
      const gen = this.sessionGeneration;
      for (let j = 1; j <= LOOKAHEAD_BUFFER_SIZE; j++) {
        const prefetchIndex = i + j;
        if (prefetchIndex < totalChunks && !this.prefetchCache.has(prefetchIndex)) {
          this.synthesizeChunk(prefetchIndex)
            .then((result) => {
              if (!signal?.aborted && this.sessionGeneration === gen) {
                this.prefetchCache.set(prefetchIndex, result);
              }
            })
            .catch(() => {});
        }
      }

      // Evict cache entries furthest from current position
      this.evictCache(i);

      // Send audio to player
      this.setStatus('playing');
      if (i === startIndex) {
        await this.audioPlayer.play(synthesized.audioData, i);
      } else {
        await this.audioPlayer.scheduleNext(synthesized.audioData, i);
      }

      // Start word timing for this chunk
      const chunk = this.chunks[i];
      if (chunk) {
        // Pre-compute word local offsets once for this chunk so the callback
        // can do an O(1) lookup instead of rescanning on every timing event.
        const wordLocalOffsets = computeWordOffsets(chunk.text);

        startWordTiming(
          i,
          chunk.text,
          (timing) => {
            // Map local word character offsets to global offsets using chunk.startOffset
            const offsets = wordLocalOffsets[timing.wordIndex];
            if (offsets !== undefined) {
              const globalStart = chunk.startOffset + offsets.start;
              const globalEnd = chunk.startOffset + offsets.end;
              this.highlightManager?.highlightWord(globalStart, globalEnd);
            }
            this.highlightManager?.highlightSentence(chunk.startOffset, chunk.endOffset);
          },
          synthesized.wordTimings,
        );
      }

      // Wait for chunk to complete
      await this.waitForChunkComplete(i, signal);

      if (signal?.aborted) return;

      // Save reading progress, throttled to avoid hammering data.json on every
      // chunk. Pause/stop/dispose paths flush unconditionally.
      const nextChunk = i + 1;
      const isLastChunk = nextChunk >= totalChunks;
      const now = Date.now();
      const dueByTime = now - this.lastProgressSaveTs >= PROGRESS_SAVE_MIN_INTERVAL_MS;
      const dueByStride =
        nextChunk - this.lastProgressSavedChunk >= PROGRESS_SAVE_CHUNK_STRIDE;
      if (isLastChunk || dueByTime || dueByStride) {
        await this.saveProgress(notePath, nextChunk, totalChunks);
        this.lastProgressSaveTs = now;
        this.lastProgressSavedChunk = nextChunk;
      }
    }

    // All chunks done — clear progress for this note
    await this.clearProgress(notePath);
    this.stopPlayback();
  }

  // =========================================================================
  // Synthesis + failover
  // =========================================================================

  private async synthesizeChunk(chunkIndex: number): Promise<SynthesizedChunk> {
    const session = this.currentSession;
    if (!session) {
      throw new Error('No active playback session.');
    }

    const chunk = this.chunks[chunkIndex];
    if (!chunk) {
      throw new Error(`Chunk ${chunkIndex} not found.`);
    }

    const provider = getProvider(session.config.providerId);

    const rawSpeed = this.state.speed;
    const range = PROVIDER_SPEED_RANGES[session.config.providerId] ?? null;
    const serverSpeed = range ? Math.min(Math.max(rawSpeed, range.min), range.max) : 1.0;

    const result = await provider.synthesize(chunk.text, session.voice, session.config, {
      speed: serverSpeed,
    });

    return {
      chunkIndex,
      audioData: result.audioData,
      format: result.format,
      wordTimings: result.wordTimings,
    };
  }

  private async synthesizeChunkWithFailover(chunkIndex: number): Promise<SynthesizedChunk> {
    let attempts = 0;

    while (attempts < MAX_FAILOVER_ATTEMPTS) {
      try {
        return await this.synthesizeChunk(chunkIndex);
      } catch (err) {
        attempts++;

        if (!(err instanceof ApiError) || !err.retryable) {
          if (err instanceof ApiError) {
            markFailed(this.currentSession!.config.id, err);
          }
          throw err;
        }

        const failedConfigId = this.currentSession!.config.id;

        // For 5xx/network errors, retry same config once before failing over
        if ((err.status >= 500 || err.status === 0) && attempts === 1) {
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (attempts - 1), 8000)));
          continue;
        }

        markFailed(failedConfigId, err);

        const allConfigs = this.plugin.settings.providers;
        const candidate = await getNextCandidate(this.currentSession!, failedConfigId, allConfigs);
        if (!candidate) {
          throw new Error(
            `All API keys for ${this.currentSession!.providerId} exhausted. Last error: ${err.message}`,
          );
        }

        console.debug(`[Recito] Failover: switching from config ${failedConfigId} to ${candidate.id}`);
        this.currentSession = {
          ...this.currentSession!,
          config: candidate,
          generation: ++this.sessionGeneration,
        };
        this.prefetchCache.clear();
      }
    }

    throw new Error('Max failover attempts exceeded.');
  }

  // =========================================================================
  // Chunk completion (Promise-based, driven by AudioPlayer callbacks)
  // =========================================================================

  private waitForChunkComplete(chunkIndex: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }

      this.chunkCompleteResolvers.set(chunkIndex, resolve);

      signal?.addEventListener('abort', () => {
        this.chunkCompleteResolvers.delete(chunkIndex);
        resolve();
      });
    });
  }

  // =========================================================================
  // Cache management
  // =========================================================================

  private evictCache(currentIndex: number): void {
    if (this.prefetchCache.size <= this.MAX_CACHE_SIZE) return;
    const entries = [...this.prefetchCache.keys()].sort(
      (a, b) => Math.abs(b - currentIndex) - Math.abs(a - currentIndex),
    );
    while (this.prefetchCache.size > this.MAX_CACHE_SIZE && entries.length > 0) {
      this.prefetchCache.delete(entries.shift()!);
    }
  }

  // =========================================================================
  // Progress persistence
  // =========================================================================

  private async saveProgress(notePath: string, chunkIndex: number, totalChunks: number): Promise<void> {
    try {
      this.plugin.settings.readingProgress[notePath] = {
        notePath,
        chunkIndex,
        totalChunks,
        timestamp: Date.now(),
      };
      await this.plugin.saveSettings();
    } catch (err) {
      console.warn('[Recito] Failed to save reading progress:', err);
    }
  }

  private async clearProgress(notePath: string): Promise<void> {
    try {
      delete this.plugin.settings.readingProgress[notePath];
      await this.plugin.saveSettings();
    } catch (err) {
      console.warn('[Recito] Failed to clear reading progress:', err);
    }
  }
}

// ============================================================================
// Module-level helpers
// ============================================================================

/**
 * Pre-compute the start/end character offsets of each whitespace-delimited word
 * within `text`. This lets the word-timing callback do O(1) lookups.
 */
function computeWordOffsets(text: string): Array<{ start: number; end: number }> {
  const offsets: Array<{ start: number; end: number }> = [];
  const wordRe = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = wordRe.exec(text)) !== null) {
    offsets.push({ start: match.index, end: match.index + match[0].length });
  }
  return offsets;
}
