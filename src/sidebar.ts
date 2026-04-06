import { ItemView, WorkspaceLeaf } from 'obsidian';
import type RecitoPlugin from './main';
import type { PlaybackState } from './lib/types';
import { SPEED_PRESETS } from './lib/constants';
import { PROVIDER_LIST } from './providers/registry';
import {
  configsInGroup,
  isCustomGroupKey,
  getCustomBaseUrlFromGroupKey,
} from './lib/group-key';
import { getCachedVoices } from './providers/voice-cache';

export const SIDEBAR_VIEW_TYPE = 'recito-sidebar';

/** Stable string hash → non-negative integer. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/**
 * Deterministic two-color gradient derived from the note title. Same title
 * always yields the same artwork — gives every note a recognizable identity.
 */
function gradientForTitle(title: string): { gradient: string; hue: number } {
  const seed = title.trim() || 'recito';
  const h = hashString(seed);
  const hue1 = h % 360;
  const hue2 = (hue1 + 35 + ((h >> 5) % 70)) % 360;
  const gradient = `linear-gradient(135deg, hsl(${hue1} 72% 58%) 0%, hsl(${hue2} 78% 42%) 100%)`;
  return { gradient, hue: hue1 };
}

const ICON_PLAY = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.55.83l10.04-6.86a1 1 0 0 0 0-1.66L9.55 4.31A1 1 0 0 0 8 5.14z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>`;
const ICON_SKIP_BACK = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 6h2v12H6zM20 6.41 18.59 5 11 12.59V6h-2v12h2v-6.59L18.59 19 20 17.59 13.41 12z"/></svg>`;
const ICON_SKIP_FWD = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 6h2v12h-2zM4 17.59 5.41 19 13 11.41V18h2V6h-2v6.59L5.41 5 4 6.41 10.59 12z"/></svg>`;
const ICON_STOP = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>`;
const ICON_VOLUME = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 10v4a1 1 0 0 0 1 1h3l4.29 4.29A1 1 0 0 0 13 18.59V5.41a1 1 0 0 0-1.71-.71L7 9H4a1 1 0 0 0-1 1zm13.5 2A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06A6.99 6.99 0 0 1 19 12a6.99 6.99 0 0 1-5 6.71v2.06A8.99 8.99 0 0 0 21 12a8.99 8.99 0 0 0-7-8.77z"/></svg>`;
const ICON_HEADPHONES = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h2v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h2a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9z"/></svg>`;
const ICON_COLLAPSE = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 13H5v-2h14v2z"/></svg>`;
const ICON_EXPAND = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`;

export class RecitoSidebarView extends ItemView {
  private plugin: RecitoPlugin;
  private stateListener: ((state: PlaybackState) => void) | null = null;

  // Root containers for the two states
  private idleEl: HTMLElement | null = null;
  private playingEl: HTMLElement | null = null;

  // Playing-state child elements (updated on each render)
  private heroEl: HTMLElement | null = null;
  private artworkEl: HTMLElement | null = null;
  private vinylLabelEl: HTMLElement | null = null;
  private collapseBtn: HTMLButtonElement | null = null;
  private collapseBtnIconState: 'collapsed' | 'expanded' | null = null;
  private noteTitleEl: HTMLElement | null = null;
  private providerEl: HTMLElement | null = null;
  private progressBarEl: HTMLElement | null = null;
  private progressBarFillEl: HTMLElement | null = null;
  private progressBarThumbEl: HTMLElement | null = null;
  private playPauseBtn: HTMLButtonElement | null = null;
  private playPauseIconState: 'playing' | 'paused' | 'loading' | null = null;
  private speedBtns: Map<number, HTMLButtonElement> = new Map();
  private volumeSlider: HTMLInputElement | null = null;

  // Memo so we don't rebuild artwork DOM unless the title actually changes.
  private artworkTitle: string | null = null;

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

    this.buildIdle(root);
    this.buildPlaying(root);

    this.stateListener = (state: PlaybackState) => this.renderState(state);
    this.plugin.orchestrator.addListener(this.stateListener);

    this.renderState(this.plugin.orchestrator.getState());
  }

  async onClose(): Promise<void> {
    if (this.stateListener) {
      this.plugin.orchestrator.removeListener(this.stateListener);
      this.stateListener = null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Idle state
  // ────────────────────────────────────────────────────────────────────────

  private buildIdle(root: HTMLElement): void {
    this.idleEl = root.createDiv({ cls: 'recito-idle' });

    const hero = this.idleEl.createDiv({ cls: 'recito-idle-hero' });
    const orb = hero.createDiv({ cls: 'recito-idle-orb' });
    orb.innerHTML = ICON_HEADPHONES;
    hero.createDiv({ cls: 'recito-idle-orb-ring' });
    hero.createDiv({ cls: 'recito-idle-orb-ring recito-idle-orb-ring--2' });

    this.idleEl.createEl('h2', { cls: 'recito-idle-title', text: 'Recito' });
    this.idleEl.createEl('p', {
      cls: 'recito-idle-tagline',
      text: 'Your notes, read aloud.',
    });

    const startBtn = this.idleEl.createEl('button', { cls: 'recito-idle-start' });
    startBtn.setAttribute('aria-label', 'Start listening');
    startBtn.innerHTML = `${ICON_PLAY}<span>Start listening</span>`;
    startBtn.addEventListener('click', () => {
      void this.plugin.startPlayback();
    });

    this.idleEl.createEl('p', {
      cls: 'recito-idle-hint',
      text: 'Open a note, then press play.',
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Playing state
  // ────────────────────────────────────────────────────────────────────────

  private buildPlaying(root: HTMLElement): void {
    this.playingEl = root.createDiv({ cls: 'recito-playing' });
    this.playingEl.style.display = 'none';

    // Hero block — wraps artwork + meta. Layout flips between stacked
    // (expanded) and side-by-side (collapsed) via a class on this element.
    this.heroEl = this.playingEl.createDiv({ cls: 'recito-hero' });

    // Vinyl record. The disc spins while playing; the center label is a
    // deterministic gradient derived from the note title, so each note still
    // gets a unique visual identity (analogous to a real record's label art).
    this.artworkEl = this.heroEl.createDiv({ cls: 'recito-artwork' });
    const vinyl = this.artworkEl.createDiv({ cls: 'recito-vinyl' });
    vinyl.createDiv({ cls: 'recito-vinyl-grooves' });
    this.vinylLabelEl = vinyl.createDiv({ cls: 'recito-vinyl-label' });
    this.vinylLabelEl.createDiv({ cls: 'recito-vinyl-hole' });
    this.artworkEl.createDiv({ cls: 'recito-artwork-shine' });

    // Collapse/expand toggle — overlays the artwork in the top-right when
    // expanded, hidden when collapsed (the small disc itself becomes the
    // expand affordance).
    this.collapseBtn = this.artworkEl.createEl('button', {
      cls: 'recito-artwork-toggle',
    });
    this.collapseBtn.setAttribute('aria-label', 'Collapse artwork');
    this.collapseBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.toggleArtworkCollapsed();
    });

    // When collapsed, clicking the small disc expands it.
    this.artworkEl.addEventListener('click', (ev) => {
      if (!this.plugin.settings.ui.artworkCollapsed) return;
      // Don't double-handle clicks on the toggle button itself.
      if ((ev.target as HTMLElement).closest('.recito-artwork-toggle')) return;
      void this.toggleArtworkCollapsed();
    });

    // Now-playing block
    const meta = this.heroEl.createDiv({ cls: 'recito-meta' });
    this.noteTitleEl = meta.createDiv({ cls: 'recito-note-title' });
    this.providerEl = meta.createDiv({ cls: 'recito-provider-chip' });

    // Progress bar with seek
    const progress = this.playingEl.createDiv({ cls: 'recito-progress' });
    this.progressBarEl = progress.createDiv({ cls: 'recito-progress-bar' });
    this.progressBarEl.setAttribute('role', 'slider');
    this.progressBarEl.setAttribute('aria-label', 'Playback position');
    this.progressBarFillEl = this.progressBarEl.createDiv({
      cls: 'recito-progress-fill',
    });
    this.progressBarThumbEl = this.progressBarEl.createDiv({
      cls: 'recito-progress-thumb',
    });
    this.progressBarEl.addEventListener('click', (ev) => {
      this.handleProgressSeek(ev);
    });

    // Transport row
    const transport = this.playingEl.createDiv({ cls: 'recito-transport' });

    const skipBackBtn = transport.createEl('button', {
      cls: 'recito-tbtn recito-tbtn--ghost',
    });
    skipBackBtn.setAttribute('aria-label', 'Previous chunk');
    skipBackBtn.innerHTML = ICON_SKIP_BACK;
    skipBackBtn.addEventListener('click', () => {
      void this.plugin.orchestrator.skipBackward();
    });

    this.playPauseBtn = transport.createEl('button', {
      cls: 'recito-tbtn recito-tbtn--primary',
    });
    this.playPauseBtn.setAttribute('aria-label', 'Play/Pause');
    this.playPauseIconState = null;
    this.playPauseBtn.addEventListener('click', () => {
      void this.plugin.togglePlayback();
    });

    const skipFwdBtn = transport.createEl('button', {
      cls: 'recito-tbtn recito-tbtn--ghost',
    });
    skipFwdBtn.setAttribute('aria-label', 'Next chunk');
    skipFwdBtn.innerHTML = ICON_SKIP_FWD;
    skipFwdBtn.addEventListener('click', () => {
      void this.plugin.orchestrator.skipForward();
    });

    const stopBtn = transport.createEl('button', {
      cls: 'recito-tbtn recito-tbtn--ghost',
    });
    stopBtn.setAttribute('aria-label', 'Stop and reset to start');
    stopBtn.setAttribute('title', 'Stop (clears resume position)');
    stopBtn.innerHTML = ICON_STOP;
    stopBtn.addEventListener('click', () => {
      this.plugin.orchestrator.stopPlayback({ clearProgress: true });
    });

    // Speed segmented control
    const speedRow = this.playingEl.createDiv({ cls: 'recito-row' });
    speedRow.createSpan({ cls: 'recito-row-label', text: 'Speed' });
    const segment = speedRow.createDiv({ cls: 'recito-segment' });
    this.speedBtns.clear();
    for (const preset of SPEED_PRESETS) {
      const btn = segment.createEl('button', {
        cls: 'recito-segment-btn',
        text: `${preset}\u00D7`,
      });
      btn.dataset.speed = String(preset);
      btn.addEventListener('click', () => {
        this.plugin.orchestrator.setSpeed(preset);
      });
      this.speedBtns.set(preset, btn);
    }

    // Volume row with icon
    const volumeRow = this.playingEl.createDiv({ cls: 'recito-row' });
    const volIcon = volumeRow.createSpan({ cls: 'recito-row-icon' });
    volIcon.innerHTML = ICON_VOLUME;
    this.volumeSlider = volumeRow.createEl('input', {
      cls: 'recito-volume-slider',
    });
    this.volumeSlider.type = 'range';
    this.volumeSlider.min = '0';
    this.volumeSlider.max = '1';
    this.volumeSlider.step = '0.05';
    this.volumeSlider.value = String(this.plugin.settings.playback.defaultVolume);
    this.volumeSlider.addEventListener('input', () => {
      const val = parseFloat(this.volumeSlider!.value);
      this.plugin.orchestrator.setVolume(val);
      this.syncVolumeFill(val);
    });
    this.syncVolumeFill(parseFloat(this.volumeSlider.value));
  }

  // ────────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────────

  private renderState(state: PlaybackState): void {
    const isIdle = state.status === 'idle';

    if (this.idleEl) this.idleEl.style.display = isIdle ? '' : 'none';
    if (this.playingEl) this.playingEl.style.display = isIdle ? 'none' : '';

    if (isIdle) return;

    this.applyCollapsedState();

    const title = this.app.workspace.getActiveFile()?.basename ?? '';
    this.updateArtwork(title);
    this.updatePlayState(state);

    if (this.noteTitleEl) this.noteTitleEl.textContent = title;
    if (this.providerEl) this.providerEl.textContent = this.formatProviderLabel();

    if (this.progressBarFillEl && state.totalChunks > 0) {
      const overallProgress =
        (state.currentChunkIndex + state.chunkProgress) / state.totalChunks;
      const pct = Math.min(Math.max(overallProgress, 0), 1) * 100;
      this.progressBarFillEl.style.width = `${pct.toFixed(2)}%`;
      if (this.progressBarThumbEl) {
        this.progressBarThumbEl.style.left = `${pct.toFixed(2)}%`;
      }
    }

    // Speed segment highlight
    for (const [preset, btn] of this.speedBtns) {
      btn.toggleClass('is-active', preset === state.speed);
    }

    // Volume slider — sync only if not actively focused to avoid jump
    if (this.volumeSlider && document.activeElement !== this.volumeSlider) {
      this.volumeSlider.value = String(state.volume);
      this.syncVolumeFill(state.volume);
    }
  }

  private updatePlayState(state: PlaybackState): void {
    const status = state.status;

    // Status drives both the artwork animation and the play/pause icon.
    if (this.artworkEl) {
      this.artworkEl.dataset.status = status;
    }
    if (this.playingEl) {
      this.playingEl.dataset.status = status;
    }

    if (this.playPauseBtn) {
      const next: 'playing' | 'paused' | 'loading' =
        status === 'playing'
          ? 'playing'
          : status === 'loading'
            ? 'loading'
            : 'paused';
      // Only mutate innerHTML when the icon actually changes — rewriting on
      // every progress tick destroys the inner <path> mid-click and silently
      // swallows mouseup events.
      if (this.playPauseIconState !== next) {
        if (next === 'loading') {
          this.playPauseBtn.innerHTML = `<span class="recito-spinner" aria-hidden="true"></span>`;
          this.playPauseBtn.setAttribute('aria-label', 'Loading');
        } else if (next === 'playing') {
          this.playPauseBtn.innerHTML = ICON_PAUSE;
          this.playPauseBtn.setAttribute('aria-label', 'Pause');
        } else {
          this.playPauseBtn.innerHTML = ICON_PLAY;
          this.playPauseBtn.setAttribute('aria-label', 'Play');
        }
        this.playPauseIconState = next;
      }
    }
  }

  private applyCollapsedState(): void {
    if (!this.heroEl) return;
    const collapsed = this.plugin.settings.ui.artworkCollapsed;
    this.heroEl.toggleClass('recito-hero--collapsed', collapsed);

    if (this.collapseBtn) {
      const next: 'collapsed' | 'expanded' = collapsed ? 'collapsed' : 'expanded';
      if (this.collapseBtnIconState !== next) {
        this.collapseBtn.innerHTML = collapsed ? ICON_EXPAND : ICON_COLLAPSE;
        this.collapseBtn.setAttribute(
          'aria-label',
          collapsed ? 'Expand artwork' : 'Collapse artwork',
        );
        this.collapseBtn.setAttribute(
          'title',
          collapsed ? 'Expand artwork' : 'Collapse artwork',
        );
        this.collapseBtnIconState = next;
      }
    }

    if (this.artworkEl) {
      if (collapsed) {
        this.artworkEl.setAttribute('role', 'button');
        this.artworkEl.setAttribute('aria-label', 'Expand artwork');
        this.artworkEl.setAttribute('tabindex', '0');
      } else {
        this.artworkEl.removeAttribute('role');
        this.artworkEl.removeAttribute('aria-label');
        this.artworkEl.removeAttribute('tabindex');
      }
    }
  }

  private async toggleArtworkCollapsed(): Promise<void> {
    this.plugin.settings.ui.artworkCollapsed =
      !this.plugin.settings.ui.artworkCollapsed;
    await this.plugin.saveSettings();
    this.applyCollapsedState();
  }

  private updateArtwork(title: string): void {
    if (!this.artworkEl || !this.vinylLabelEl) return;
    if (this.artworkTitle === title) return;
    this.artworkTitle = title;

    const { gradient } = gradientForTitle(title);
    this.vinylLabelEl.style.background = gradient;
  }

  private syncVolumeFill(value: number): void {
    if (!this.volumeSlider) return;
    const pct = Math.min(Math.max(value, 0), 1) * 100;
    this.volumeSlider.style.setProperty('--recito-vol-pct', `${pct}%`);
  }

  private handleProgressSeek(ev: MouseEvent): void {
    if (!this.progressBarEl) return;
    const state = this.plugin.orchestrator.getState();
    if (state.totalChunks <= 0) return;
    const rect = this.progressBarEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(Math.max((ev.clientX - rect.left) / rect.width, 0), 1);
    const target = Math.min(
      Math.floor(ratio * state.totalChunks),
      state.totalChunks - 1,
    );
    void this.plugin.orchestrator.skipToChunk(target);
  }

  private formatProviderLabel(): string {
    const group = this.plugin.settings.activeProviderGroup;
    if (!group) return '';

    const pool = configsInGroup(this.plugin.settings.providers, group);
    const sample = pool.find((p) => !p.disabled) ?? pool[0];
    if (!sample) return '';

    const meta = PROVIDER_LIST.find((m) => m.id === sample.providerId);
    let providerLabel = meta?.name ?? sample.providerId;
    if (isCustomGroupKey(group)) {
      const baseUrl = getCustomBaseUrlFromGroupKey(group);
      if (baseUrl) {
        try {
          providerLabel = `${providerLabel} \u00B7 ${new URL(baseUrl).host}`;
        } catch {
          providerLabel = `${providerLabel} \u00B7 ${baseUrl}`;
        }
      }
    }

    const voiceId = this.plugin.settings.activeVoiceId ?? '';
    let voiceLabel = '';
    if (voiceId) {
      const voices = getCachedVoices(sample.id);
      voiceLabel = voices?.find((v) => v.id === voiceId)?.name ?? voiceId;
    }

    const parts = [providerLabel, voiceLabel].filter(Boolean);
    return parts.join(' \u00B7 ');
  }
}
