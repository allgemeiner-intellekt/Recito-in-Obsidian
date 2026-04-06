import { MarkdownView, Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { RecitoSettings } from './lib/types';
import { DEFAULT_SETTINGS, READING_PROGRESS_MAX_AGE_MS } from './lib/constants';
import { Orchestrator } from './orchestrator';
import { RecitoSidebarView, SIDEBAR_VIEW_TYPE } from './sidebar';
import { RecitoSettingTab } from './settings';

export default class RecitoPlugin extends Plugin {
  settings: RecitoSettings;
  orchestrator: Orchestrator;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.orchestrator = new Orchestrator(this);

    // Register sidebar view
    this.registerView(
      SIDEBAR_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new RecitoSidebarView(leaf, this),
    );

    // Ribbon icon
    this.addRibbonIcon('headphones', 'Recito: Read aloud', () => {
      void this.startPlayback();
    });

    // Commands
    this.addCommand({
      id: 'start-reading',
      name: 'Start reading',
      callback: () => {
        void this.startPlayback();
      },
    });

    this.addCommand({
      id: 'pause-resume',
      name: 'Pause / Resume',
      callback: () => {
        void this.togglePlayback();
      },
    });

    this.addCommand({
      id: 'stop-reading',
      name: 'Stop reading (clears resume position)',
      callback: () => {
        this.orchestrator.stopPlayback({ clearProgress: true });
      },
    });

    this.addCommand({
      id: 'clear-progress-current-note',
      name: 'Clear playback progress for current note',
      callback: () => {
        void this.clearCurrentNoteProgress();
      },
    });

    this.addCommand({
      id: 'skip-forward',
      name: 'Skip forward',
      callback: () => {
        void this.orchestrator.skipForward();
      },
    });

    this.addCommand({
      id: 'skip-backward',
      name: 'Skip backward',
      callback: () => {
        void this.orchestrator.skipBackward();
      },
    });

    this.addCommand({
      id: 'toggle-sidebar',
      name: 'Toggle Recito sidebar',
      callback: () => {
        void this.toggleSidebar();
      },
    });

    // Settings tab
    this.addSettingTab(new RecitoSettingTab(this.app, this));

    // Pause on leaf change
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const state = this.orchestrator.getState();
        if (state.status === 'playing') {
          this.orchestrator.pausePlayback();
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
    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!markdownView) {
      new Notice('Recito: Open a Markdown note to start reading.');
      return;
    }

    // Switch to reading (preview) mode
    const currentState = markdownView.getState() as { mode?: string };
    if (currentState.mode !== 'preview') {
      await markdownView.setState({ mode: 'preview' }, { history: false });
    }

    await this.activateSidebar();

    const containerEl = markdownView.containerEl;
    const notePath = markdownView.file?.path ?? '';

    await this.orchestrator.startPlayback(containerEl, notePath);
  }

  togglePlayback(): void {
    const state = this.orchestrator.getState();
    if (state.status === 'playing') {
      this.orchestrator.pausePlayback();
    } else if (state.status === 'paused') {
      this.orchestrator.resumePlayback();
    } else {
      void this.startPlayback();
    }
  }

  async activateSidebar(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]!);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
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
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<RecitoSettings>,
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async clearCurrentNoteProgress(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const path = view?.file?.path;
    if (!path) {
      new Notice('Recito: Open a Markdown note first.');
      return;
    }
    if (this.settings.readingProgress[path]) {
      delete this.settings.readingProgress[path];
      await this.saveSettings();
      new Notice('Recito: Cleared playback progress for this note.');
    } else {
      new Notice('Recito: No saved progress for this note.');
    }
  }

  cleanOldProgress(): void {
    const now = Date.now();
    let changed = false;
    for (const key of Object.keys(this.settings.readingProgress)) {
      const entry = this.settings.readingProgress[key];
      if (entry && now - entry.timestamp > READING_PROGRESS_MAX_AGE_MS) {
        delete this.settings.readingProgress[key];
        changed = true;
      }
    }
    if (changed) {
      void this.saveSettings();
    }
  }
}
