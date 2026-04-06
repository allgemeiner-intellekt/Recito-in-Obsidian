import { ItemView, WorkspaceLeaf } from 'obsidian';
import type RecitoPlugin from './main';
import type { PlaybackState } from './lib/types';
import { SPEED_PRESETS } from './lib/constants';

export const SIDEBAR_VIEW_TYPE = 'recito-sidebar';

// Average chunk duration used for time estimation (seconds)
const AVG_CHUNK_DURATION = 15;

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class RecitoSidebarView extends ItemView {
  private plugin: RecitoPlugin;
  private stateListener: ((state: PlaybackState) => void) | null = null;

  // Root containers for the two states
  private idleEl: HTMLElement | null = null;
  private playingEl: HTMLElement | null = null;

  // Playing-state child elements (updated on each render)
  private noteTitleEl: HTMLElement | null = null;
  private timeEl: HTMLElement | null = null;
  private progressBarFillEl: HTMLElement | null = null;
  private playPauseBtn: HTMLButtonElement | null = null;
  private playPauseIconState: 'playing' | 'paused' | null = null;
  private speedBtns: Map<number, HTMLButtonElement> = new Map();
  private volumeSlider: HTMLInputElement | null = null;
  private providerEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: RecitoPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SIDEBAR_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Recito';
  }

  getIcon(): string {
    return 'headphones';
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('recito-sidebar');

    // ── Idle state ──────────────────────────────────────────────────────────
    this.idleEl = root.createDiv({ cls: 'recito-idle' });

    const playBtn = this.idleEl.createEl('button', { cls: 'recito-play-btn' });
    playBtn.setAttribute('aria-label', 'Start playback');
    playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
      <path d="M8 5v14l11-7z"/>
    </svg>`;
    playBtn.addEventListener('click', () => {
      void this.plugin.startPlayback();
    });

    this.idleEl.createEl('p', {
      text: 'Open a note and press play to start listening.',
      cls: 'recito-idle-msg',
    });

    // ── Playing state ────────────────────────────────────────────────────────
    this.playingEl = root.createDiv({ cls: 'recito-playing' });
    this.playingEl.style.display = 'none';

    // Note title
    this.noteTitleEl = this.playingEl.createEl('div', { cls: 'recito-note-title' });

    // Time display
    this.timeEl = this.playingEl.createEl('div', { cls: 'recito-time' });

    // Progress bar
    const progressBar = this.playingEl.createDiv({ cls: 'recito-progress-bar' });
    this.progressBarFillEl = progressBar.createDiv({ cls: 'recito-progress-fill' });

    // Transport controls
    const transport = this.playingEl.createDiv({ cls: 'recito-transport' });

    const skipBackBtn = transport.createEl('button', { cls: 'recito-btn recito-skip-back' });
    skipBackBtn.setAttribute('aria-label', 'Skip backward');
    skipBackBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
      <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>
    </svg>`;
    skipBackBtn.addEventListener('click', () => {
      void this.plugin.orchestrator.skipBackward();
    });

    this.playPauseBtn = transport.createEl('button', { cls: 'recito-btn recito-play-pause' });
    this.playPauseBtn.setAttribute('aria-label', 'Play/Pause');
    this.playPauseIconState = null;
    this.playPauseBtn.addEventListener('click', () => {
      void this.plugin.togglePlayback();
    });

    const skipFwdBtn = transport.createEl('button', { cls: 'recito-btn recito-skip-fwd' });
    skipFwdBtn.setAttribute('aria-label', 'Skip forward');
    skipFwdBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
      <path d="M6 18l8.5-6L6 6v12zm2-12v12l8.5-6z" style="display:none"/>
      <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
    </svg>`;
    skipFwdBtn.addEventListener('click', () => {
      void this.plugin.orchestrator.skipForward();
    });

    const stopBtn = transport.createEl('button', { cls: 'recito-btn recito-stop' });
    stopBtn.setAttribute('aria-label', 'Stop and reset to start');
    stopBtn.setAttribute('title', 'Stop (clears resume position)');
    stopBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
      <path d="M6 6h12v12H6z"/>
    </svg>`;
    stopBtn.addEventListener('click', () => {
      this.plugin.orchestrator.stopPlayback({ clearProgress: true });
    });

    // Speed presets
    const speedRow = this.playingEl.createDiv({ cls: 'recito-speed-row' });
    speedRow.createEl('span', { text: 'Speed:', cls: 'recito-label' });
    const speedBtns = speedRow.createDiv({ cls: 'recito-speed-btns' });
    this.speedBtns.clear();
    for (const preset of SPEED_PRESETS) {
      const btn = speedBtns.createEl('button', {
        text: `${preset}x`,
        cls: 'recito-speed-btn',
      });
      btn.dataset.speed = String(preset);
      btn.addEventListener('click', () => {
        this.plugin.orchestrator.setSpeed(preset);
      });
      this.speedBtns.set(preset, btn);
    }

    // Volume slider
    const volumeRow = this.playingEl.createDiv({ cls: 'recito-volume-row' });
    volumeRow.createEl('span', { text: 'Volume:', cls: 'recito-label' });
    this.volumeSlider = volumeRow.createEl('input', { cls: 'recito-volume-slider' });
    this.volumeSlider.type = 'range';
    this.volumeSlider.min = '0';
    this.volumeSlider.max = '1';
    this.volumeSlider.step = '0.05';
    this.volumeSlider.value = String(this.plugin.settings.playback.defaultVolume);
    this.volumeSlider.addEventListener('input', () => {
      const val = parseFloat(this.volumeSlider!.value);
      this.plugin.orchestrator.setVolume(val);
    });

    // Provider display
    this.providerEl = this.playingEl.createEl('div', { cls: 'recito-provider' });

    // ── Subscribe to state ───────────────────────────────────────────────────
    this.stateListener = (state: PlaybackState) => this.renderState(state);
    this.plugin.orchestrator.addListener(this.stateListener);

    // Render immediately with current state
    this.renderState(this.plugin.orchestrator.getState());
  }

  async onClose(): Promise<void> {
    if (this.stateListener) {
      this.plugin.orchestrator.removeListener(this.stateListener);
      this.stateListener = null;
    }
  }

  private renderState(state: PlaybackState): void {
    const isIdle = state.status === 'idle';

    if (this.idleEl) {
      this.idleEl.style.display = isIdle ? '' : 'none';
    }
    if (this.playingEl) {
      this.playingEl.style.display = isIdle ? 'none' : '';
    }

    if (isIdle) return;

    // Note title
    if (this.noteTitleEl) {
      const basename = this.app.workspace.getActiveFile()?.basename ?? '';
      this.noteTitleEl.textContent = basename;
    }

    // Elapsed / estimated total time
    if (this.timeEl) {
      const avgDur = state.duration > 0 ? state.duration : AVG_CHUNK_DURATION;
      const elapsed = state.currentChunkIndex * avgDur + state.currentTime;
      const total = state.totalChunks * avgDur;
      this.timeEl.textContent = `${formatTime(elapsed)} / ${formatTime(total)}`;
    }

    // Progress bar (fraction of chunks + intra-chunk progress)
    if (this.progressBarFillEl && state.totalChunks > 0) {
      const overallProgress =
        (state.currentChunkIndex + state.chunkProgress) / state.totalChunks;
      this.progressBarFillEl.style.width = `${Math.min(overallProgress * 100, 100).toFixed(2)}%`;
    }

    // Play/Pause button icon — only mutate the DOM when the icon actually
    // changes. Rewriting innerHTML on every progress tick (~60Hz) destroys
    // the inner <path>, which silently swallows clicks whose mousedown and
    // mouseup straddle a render: the click event only fires when both land
    // on the same element. That's why a single click often did nothing while
    // keyboard space (focused on the button itself) always worked.
    if (this.playPauseBtn) {
      const isPlaying = state.status === 'playing';
      const nextIcon: 'playing' | 'paused' = isPlaying ? 'playing' : 'paused';
      if (this.playPauseIconState !== nextIcon) {
        this.playPauseBtn.innerHTML = isPlaying
          ? `<svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
             </svg>`
          : `<svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
              <path d="M8 5v14l11-7z"/>
             </svg>`;
        this.playPauseBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
        this.playPauseIconState = nextIcon;
      }
    }

    // Speed preset buttons — highlight active
    for (const [preset, btn] of this.speedBtns) {
      btn.toggleClass('recito-speed-btn--active', preset === state.speed);
    }

    // Volume slider — sync only if not actively focused to avoid jump
    if (this.volumeSlider && document.activeElement !== this.volumeSlider) {
      this.volumeSlider.value = String(state.volume);
    }

    // Provider display
    if (this.providerEl) {
      const groupId = this.plugin.settings.activeProviderGroup ?? '';
      const voiceId = this.plugin.settings.activeVoiceId ?? '';
      const parts = [groupId, voiceId].filter(Boolean);
      this.providerEl.textContent = parts.length > 0 ? parts.join(' · ') : '';
    }
  }
}
