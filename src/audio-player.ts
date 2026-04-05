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

  // Gapless scheduling: next chunk pre-scheduled to start when current ends
  private nextSourceNode: AudioBufferSourceNode | null = null;
  private nextBuffer: AudioBuffer | null = null;
  private nextChunkIndex = -1;

  constructor(private readonly callbacks: AudioPlayerCallbacks) {}

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
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    let buffer: AudioBuffer;

    // Check prefetch cache
    const cached = this.prefetchedBuffers.get(chunkIndex);
    if (cached) {
      buffer = cached;
      this.prefetchedBuffers.delete(chunkIndex);
    } else {
      buffer = await ctx.decodeAudioData(audioData.slice(0));
    }

    this.currentBuffer = buffer;
    this.pauseOffset = 0;
    this.startPlayback();
  }

  /**
   * Schedule the next chunk to start exactly when the current one ends (gapless).
   * If nothing is playing, falls back to regular play().
   */
  async scheduleNext(audioData: ArrayBuffer, chunkIndex: number): Promise<void> {
    const ctx = this.getContext();

    if (!this.isPlaying || !this.currentBuffer) {
      // Nothing playing — just play directly
      await this.play(audioData, chunkIndex);
      return;
    }

    // Cancel any previously scheduled next
    if (this.nextSourceNode) {
      try { this.nextSourceNode.stop(); } catch { /* already stopped */ }
      this.nextSourceNode.disconnect();
      this.nextSourceNode = null;
    }

    // Decode the next buffer
    let buffer: AudioBuffer;
    const cached = this.prefetchedBuffers.get(chunkIndex);
    if (cached) {
      buffer = cached;
      this.prefetchedBuffers.delete(chunkIndex);
    } else {
      buffer = await ctx.decodeAudioData(audioData.slice(0));
    }

    this.nextBuffer = buffer;
    this.nextChunkIndex = chunkIndex;

    // Schedule to start at the exact moment current source ends
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
      // Keep only a few prefetched buffers
      if (this.prefetchedBuffers.size > 3) {
        const oldest = this.prefetchedBuffers.keys().next().value;
        if (oldest !== undefined) {
          this.prefetchedBuffers.delete(oldest);
        }
      }
    } catch (err) {
      console.warn('Prefetch decode failed:', err);
    }
  }

  private startPlayback(): void {
    if (!this.currentBuffer || !this.ctx || !this.gainNode) return;

    const completingChunkIndex = this.currentChunkIndex;

    this.sourceNode = this.ctx.createBufferSource();
    this.sourceNode.buffer = this.currentBuffer;
    this.sourceNode.playbackRate.value = this.playbackRate;
    this.sourceNode.connect(this.gainNode);

    this.sourceNode.onended = () => {
      if (this.isPlaying) {
        this.stopProgressReporting();

        if (this.nextSourceNode && this.nextBuffer) {
          // Promote next to current (gapless transition)
          this.sourceNode = this.nextSourceNode;
          this.currentBuffer = this.nextBuffer;
          this.currentChunkIndex = this.nextChunkIndex;
          this.startTime = this.ctx!.currentTime;
          this.pauseOffset = 0;
          this.nextSourceNode = null;
          this.nextBuffer = null;
          this.nextChunkIndex = -1;

          // Re-attach onended for the promoted source
          const promotedChunkIndex = this.currentChunkIndex;
          this.sourceNode.onended = () => {
            if (this.isPlaying) {
              this.isPlaying = false;
              this.stopProgressReporting();
              this.callbacks.onChunkComplete(promotedChunkIndex);
            }
          };

          this.startProgressReporting();

          // Signal the old chunk complete
          this.callbacks.onChunkComplete(completingChunkIndex);
        } else {
          // No next buffer queued — just complete
          this.isPlaying = false;
          this.callbacks.onChunkComplete(completingChunkIndex);
        }
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
    try {
      this.sourceNode.onended = null;
      this.sourceNode.stop();
    } catch {
      // already stopped
    }
    this.sourceNode.disconnect();
    this.sourceNode = null;

    // Cancel pre-scheduled next source (keep nextBuffer for re-scheduling on resume)
    if (this.nextSourceNode) {
      try {
        this.nextSourceNode.onended = null;
        this.nextSourceNode.stop();
      } catch { /* already stopped */ }
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
      try {
        this.sourceNode.onended = null;
        this.sourceNode.stop();
      } catch {
        // already stopped
      }
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.nextSourceNode) {
      try {
        this.nextSourceNode.onended = null;
        this.nextSourceNode.stop();
      } catch { /* already stopped */ }
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
    if (this.sourceNode && this.isPlaying) {
      this.sourceNode.playbackRate.value = rate;
    }
    if (this.nextSourceNode) {
      this.nextSourceNode.playbackRate.value = rate;
    }
  }

  setVolume(level: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, level));
    }
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
      this.ctx.close().catch(() => {
        // AudioContext may already be closed
      });
      this.ctx = null;
      this.gainNode = null;
    }
  }

  private startProgressReporting(): void {
    this.stopProgressReporting();
    this.progressInterval = setInterval(() => {
      this.callbacks.onProgress(
        this.getCurrentTime(),
        this.getDuration(),
        this.currentChunkIndex,
      );
    }, PROGRESS_REPORT_INTERVAL_MS);
  }

  private stopProgressReporting(): void {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
  }
}
