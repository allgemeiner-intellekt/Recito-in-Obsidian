import { MarkdownView, Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { RecitoSettings } from './lib/types';
import { DEFAULT_SETTINGS, READING_PROGRESS_MAX_AGE_MS } from './lib/constants';
import { getGroupKey } from './lib/group-key';
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
  }

  async startPlayback(): Promise<void> {
    const markdownView = this.findTargetMarkdownView();
    if (!markdownView) {
      new Notice('Recito: Open a Markdown note to start reading.');
      return;
    }

    // Switch to reading (preview) mode if needed. setState resolves *before*
    // Obsidian has actually built the preview DOM, so we must poll for the
    // preview section to be populated before handing the container to the
    // orchestrator (which extracts text from the DOM).
    const currentState = markdownView.getState() as { mode?: string };
    const wasEditMode = currentState.mode !== 'preview';
    if (wasEditMode) {
      await markdownView.setState({ mode: 'preview' }, { history: false });
    }

    await this.activateSidebar();

    const containerEl = markdownView.containerEl;
    const ready = await this.waitForReadingViewReady(containerEl);
    if (!ready) {
      new Notice('Recito: Reading view did not render in time. Please try again.');
      return;
    }

    const notePath = markdownView.file?.path ?? '';
    await this.orchestrator.startPlayback(containerEl, notePath);
  }

  /**
   * Resolve the markdown view the user is acting on. `getActiveViewOfType`
   * returns null when the active leaf is a sidebar (e.g., the user clicked
   * Recito's own sidebar play button), so fall back to the most recently
   * active main-area leaf.
   */
  private findTargetMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;
    const recent = this.app.workspace.getMostRecentLeaf();
    if (recent && recent.view instanceof MarkdownView) return recent.view;
    return null;
  }

  /**
   * Poll until the reading view's preview section actually contains rendered
   * content. Obsidian builds the preview DOM asynchronously after `setState`,
   * so a synchronous query immediately after switching modes finds an empty
   * (or missing) `.markdown-preview-section`.
   */
  private async waitForReadingViewReady(
    containerEl: HTMLElement,
    timeoutMs = 2000,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const section = containerEl.querySelector<HTMLElement>(
        '.markdown-reading-view .markdown-preview-section',
      );
      if (section && (section.textContent ?? '').trim().length > 0) {
        return true;
      }
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    return false;
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
      await this.app.workspace.revealLeaf(existing[0]!);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
      await this.app.workspace.revealLeaf(leaf);
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
    this.migrateActiveProviderGroup();
  }

  /**
   * Legacy: `activeProviderGroup` used to store a per-key config id.
   * It now stores a group key (provider pool). Rewrite if we detect the old form.
   */
  private migrateActiveProviderGroup(): void {
    const current = this.settings.activeProviderGroup;
    const providers = this.settings.providers;

    if (!current) return;

    // If current matches an existing config id, it's the legacy form — rewrite.
    const legacyMatch = providers.find((p) => p.id === current);
    if (legacyMatch) {
      this.settings.activeProviderGroup = getGroupKey(legacyMatch);
      return;
    }

    // If current already matches a known group, leave it.
    const groupExists = providers.some((p) => getGroupKey(p) === current);
    if (groupExists) return;

    // Stale value with no matching pool — fall back to first provider's group, or null.
    this.settings.activeProviderGroup = providers[0]
      ? getGroupKey(providers[0])
      : null;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async clearCurrentNoteProgress(): Promise<void> {
    const view = this.findTargetMarkdownView();
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
