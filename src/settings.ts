import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type RecitoPlugin from './main';
import type { ProviderConfig, Voice } from './lib/types';
import { DEFAULT_SETTINGS } from './lib/constants';
import { PROVIDER_LIST, getProvider } from './providers/registry';
import { ELEVENLABS_MODELS } from './providers/elevenlabs';
import { getCachedVoices, setCachedVoices, invalidateVoiceCache } from './providers/voice-cache';
import {
  getGroupKey,
  configsInGroup,
  isCustomGroupKey,
  getCustomBaseUrlFromGroupKey,
  normalizeBaseUrl,
} from './lib/group-key';
import { buildExport, applyImport } from './lib/settings-io';

function maskKey(key: string): string {
  if (!key) return '(no key)';
  if (key.length <= 8) return '••••';
  return '••••' + key.slice(-4);
}

/**
 * Pick a representative config from the active pool — used for the Voice
 * section, which needs *some* key to fetch the voice list. Prefers enabled
 * keys; falls back to any.
 */
function getActivePoolRepresentative(plugin: RecitoPlugin): ProviderConfig | null {
  const group = plugin.settings.activeProviderGroup;
  if (!group) return null;
  const pool = configsInGroup(plugin.settings.providers, group);
  if (pool.length === 0) return null;
  return pool.find((p) => !p.disabled) ?? pool[0] ?? null;
}

/**
 * After deleting/changing membership, ensure activeProviderGroup still points
 * at an existing pool. Switch to the first remaining pool if not. Returns true
 * if the active group changed (caller should clear activeVoiceId).
 */
function ensureActiveGroupValid(plugin: RecitoPlugin): boolean {
  const providers = plugin.settings.providers;
  const current = plugin.settings.activeProviderGroup;
  if (current && providers.some((p) => getGroupKey(p) === current)) {
    return false;
  }
  const next = providers[0] ? getGroupKey(providers[0]) : null;
  plugin.settings.activeProviderGroup = next;
  return true;
}

export class RecitoSettingTab extends PluginSettingTab {
  plugin: RecitoPlugin;

  constructor(app: App, plugin: RecitoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('recito-settings');

    this.renderProvidersSection(containerEl);
    this.renderVoiceSection(containerEl);
    this.renderPlaybackSection(containerEl);
    this.renderAppearanceSection(containerEl);
    this.renderBackupSection(containerEl);
  }

  // =========================================================================
  // Providers section
  // =========================================================================

  private renderProvidersSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'TTS Providers', cls: 'recito-section-heading' });

    // Built-in providers: one card per provider type.
    for (const meta of PROVIDER_LIST) {
      if (meta.id === 'custom') continue;
      this.renderPoolCard(containerEl, {
        groupKey: meta.id,
        title: meta.name,
        description: meta.description,
        providerId: meta.id,
        providerName: meta.name,
      });
    }

    // Custom providers: one card per unique baseUrl, then a bottom button.
    const customConfigs = this.plugin.settings.providers.filter(
      (p) => p.providerId === 'custom',
    );
    const customGroupKeys = Array.from(
      new Set(customConfigs.map((c) => getGroupKey(c))),
    );
    for (const groupKey of customGroupKeys) {
      const baseUrl = getCustomBaseUrlFromGroupKey(groupKey);
      const poolMembers = customConfigs.filter((c) => getGroupKey(c) === groupKey);
      const customTitle =
        poolMembers.find((c) => c.name && c.name.trim())?.name?.trim() ||
        'Custom (OpenAI-compatible)';
      this.renderPoolCard(containerEl, {
        groupKey,
        title: customTitle,
        description: baseUrl || '(no base URL)',
        providerId: 'custom',
        providerName: 'Custom (OpenAI-compatible)',
      });
    }

    // Bottom-of-section: + Add custom provider
    const customAddRow = containerEl.createDiv({ cls: 'recito-add-custom-row' });
    const addCustomBtn = customAddRow.createEl('button', {
      text: '+ Add custom provider',
      cls: 'mod-cta',
    });
    addCustomBtn.addEventListener('click', () => {
      new ProviderModal(
        this.app,
        'custom',
        'Custom (OpenAI-compatible)',
        null,
        async (config) => {
          this.plugin.settings.providers.push(config);
          if (!this.plugin.settings.activeProviderGroup) {
            this.plugin.settings.activeProviderGroup = getGroupKey(config);
          }
          await this.plugin.saveSettings();
          this.display();
        },
      ).open();
    });
  }

  private renderPoolCard(
    containerEl: HTMLElement,
    opts: {
      groupKey: string;
      title: string;
      description: string;
      providerId: string;
      providerName: string;
    },
  ): void {
    const { groupKey, title, description, providerId, providerName } = opts;
    const isActive = this.plugin.settings.activeProviderGroup === groupKey;

    const card = containerEl.createDiv({
      cls: 'recito-card' + (isActive ? ' is-active' : ''),
    });

    // Header
    const header = card.createDiv({ cls: 'recito-card-header' });
    const headerText = header.createDiv({ cls: 'recito-card-header-text' });
    const titleLine = headerText.createDiv({ cls: 'recito-card-title' });
    titleLine.createSpan({ text: title });
    if (isActive) {
      titleLine.createSpan({ text: 'Active', cls: 'recito-badge' });
    }
    headerText.createEl('div', { text: description, cls: 'recito-card-desc' });

    const headerActions = header.createDiv({ cls: 'recito-card-header-actions' });

    if (!isActive) {
      const setActiveBtn = headerActions.createEl('button', { text: 'Set active' });
      setActiveBtn.addEventListener('click', async () => {
        this.plugin.settings.activeProviderGroup = groupKey;
        // Clear voice — different pool likely has different voices.
        this.plugin.settings.activeVoiceId = null;
        await this.plugin.saveSettings();
        this.display();
      });
    }

    // For built-in providers, the Add Key button creates a new key in this pool.
    // For custom, adding a key may belong to a different baseUrl, so the
    // bottom-of-section button is the right place. We still expose Add Key on the
    // header for built-ins.
    if (providerId !== 'custom') {
      const addBtn = headerActions.createEl('button', {
        text: '+ Add key',
        cls: 'mod-cta',
      });
      addBtn.addEventListener('click', () => {
        new ProviderModal(this.app, providerId, providerName, null, async (config) => {
          this.plugin.settings.providers.push(config);
          if (!this.plugin.settings.activeProviderGroup) {
            this.plugin.settings.activeProviderGroup = getGroupKey(config);
          }
          await this.plugin.saveSettings();
          this.display();
        }).open();
      });
    }

    // Key list (members of this pool)
    const body = card.createDiv({ cls: 'recito-card-body' });
    const configured = configsInGroup(this.plugin.settings.providers, groupKey);
    if (configured.length === 0) {
      body.createEl('div', {
        text: 'No keys configured.',
        cls: 'recito-empty',
      });
    } else {
      for (const config of configured) {
        this.renderKeyRow(body, config, providerId);
      }
    }
  }

  private renderKeyRow(parent: HTMLElement, config: ProviderConfig, providerId: string): void {
    const isDisabled = !!config.disabled;
    const row = parent.createDiv({
      cls: 'recito-key-row' + (isDisabled ? ' is-disabled' : ''),
    });

    // Status dot
    row.createDiv({ cls: 'recito-key-dot' + (isDisabled ? '' : ' is-active') });

    // Info column
    const info = row.createDiv({ cls: 'recito-key-info' });
    const titleLine = info.createDiv({ cls: 'recito-key-title' });
    titleLine.createSpan({ text: maskKey(config.apiKey), cls: 'recito-key-mask' });
    if (isDisabled) {
      titleLine.createSpan({ text: 'Disabled', cls: 'recito-badge recito-badge--muted' });
    }

    // Subline: model (and baseUrl for custom)
    const subParts: string[] = [];
    if (providerId === 'elevenlabs') {
      const modelId = (config.extraParams?.model_id as string) ?? 'eleven_multilingual_v2';
      const label = ELEVENLABS_MODELS.find((m) => m.modelId === modelId)?.label ?? modelId;
      subParts.push(`model: ${label}`);
    } else if (providerId === 'custom') {
      const model = (config.extraParams?.model as string) ?? 'tts-1';
      subParts.push(`model: ${model}`);
    }
    if (subParts.length > 0) {
      info.createDiv({ text: subParts.join(' · '), cls: 'recito-key-sub' });
    }

    // Actions
    const actions = row.createDiv({ cls: 'recito-key-actions' });

    const toggleBtn = actions.createEl('button', {
      text: isDisabled ? 'Enable' : 'Disable',
    });
    toggleBtn.addEventListener('click', async () => {
      const idx = this.plugin.settings.providers.findIndex((p) => p.id === config.id);
      const existing = this.plugin.settings.providers[idx];
      if (!existing) return;
      this.plugin.settings.providers[idx] = {
        ...existing,
        disabled: !isDisabled,
      };
      await this.plugin.saveSettings();
      this.display();
    });

    const testBtn = actions.createEl('button', { text: 'Test' });
    testBtn.addEventListener('click', async () => {
      testBtn.setText('Testing...');
      testBtn.setAttr('disabled', 'true');
      await this.testKey(config);
      testBtn.setText('Test');
      testBtn.removeAttribute('disabled');
    });

    const editBtn = actions.createEl('button', { text: 'Edit' });
    editBtn.addEventListener('click', () => {
      new ProviderModal(this.app, providerId, config.name, config, async (updated) => {
        const idx = this.plugin.settings.providers.findIndex((p) => p.id === config.id);
        const prev = idx >= 0 ? this.plugin.settings.providers[idx] : undefined;
        if (idx >= 0 && prev) {
          // Preserve disabled flag across edits.
          this.plugin.settings.providers[idx] = {
            ...updated,
            disabled: prev.disabled,
          };
        }
        invalidateVoiceCache(config.id);

        // Custom: editing baseUrl may move this key to a different pool.
        // If the active group used to point at the old pool and that pool is now
        // empty, follow the key into its new pool.
        if (
          providerId === 'custom' &&
          normalizeBaseUrl(config.baseUrl) !== normalizeBaseUrl(updated.baseUrl)
        ) {
          const oldGroup = getGroupKey(config);
          const stillExists = this.plugin.settings.providers.some(
            (p) => getGroupKey(p) === oldGroup,
          );
          if (!stillExists && this.plugin.settings.activeProviderGroup === oldGroup) {
            this.plugin.settings.activeProviderGroup = getGroupKey(updated);
            this.plugin.settings.activeVoiceId = null;
          }
        }

        if (ensureActiveGroupValid(this.plugin)) {
          this.plugin.settings.activeVoiceId = null;
        }
        await this.plugin.saveSettings();
        this.display();
      }).open();
    });

    const removeBtn = actions.createEl('button', { text: 'Remove', cls: 'mod-warning' });
    removeBtn.addEventListener('click', async () => {
      const removedGroup = getGroupKey(config);
      this.plugin.settings.providers = this.plugin.settings.providers.filter(
        (p) => p.id !== config.id,
      );
      // If the active pool is now empty, switch to the first remaining pool.
      const poolStillExists = this.plugin.settings.providers.some(
        (p) => getGroupKey(p) === removedGroup,
      );
      if (
        !poolStillExists &&
        this.plugin.settings.activeProviderGroup === removedGroup
      ) {
        this.plugin.settings.activeProviderGroup =
          this.plugin.settings.providers[0]
            ? getGroupKey(this.plugin.settings.providers[0])
            : null;
        this.plugin.settings.activeVoiceId = null;
      }
      invalidateVoiceCache(config.id);
      await this.plugin.saveSettings();
      this.display();
    });
  }

  private async testKey(config: ProviderConfig): Promise<void> {
    try {
      const provider = getProvider(config.providerId);
      const valid = await provider.validateKey(config);
      if (valid) {
        new Notice(`${config.name}: API key is valid.`);
      } else {
        new Notice(`${config.name}: API key validation failed.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`${config.name}: Test error — ${msg}`);
    }
  }

  // =========================================================================
  // Voice section
  // =========================================================================

  private renderVoiceSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Voice', cls: 'recito-section-heading' });

    const card = containerEl.createDiv({ cls: 'recito-card' });
    const body = card.createDiv({ cls: 'recito-card-body' });

    const active = getActivePoolRepresentative(this.plugin);
    if (!active) {
      body.createEl('div', {
        text: 'No active provider pool. Add a key and set its provider active to choose a voice.',
        cls: 'recito-empty',
      });
      return;
    }

    const meta = PROVIDER_LIST.find((m) => m.id === active.providerId);
    const activeGroup = this.plugin.settings.activeProviderGroup ?? '';
    let label: string;
    if (isCustomGroupKey(activeGroup)) {
      const poolMembers = configsInGroup(this.plugin.settings.providers, activeGroup);
      const customName =
        poolMembers.find((c) => c.name && c.name.trim())?.name?.trim() ||
        meta?.name ||
        active.providerId;
      label = `${customName} · ${getCustomBaseUrlFromGroupKey(activeGroup) || '(no base URL)'}`;
    } else {
      label = meta?.name ?? active.providerId;
    }
    body.createEl('div', {
      text: `Active pool: ${label}`,
      cls: 'recito-key-sub',
    });

    const pickerRow = body.createDiv({ cls: 'recito-voice-row' });
    const select = pickerRow.createEl('select', { cls: 'dropdown recito-voice-select' });
    const status = pickerRow.createDiv({ cls: 'recito-voice-status' });
    const refreshBtn = pickerRow.createEl('button', { text: 'Refresh' });

    const populate = (voices: Voice[]) => {
      select.empty();
      if (voices.length === 0) {
        const opt = select.createEl('option', { text: 'No voices available', value: '' });
        opt.disabled = true;
        return;
      }
      for (const v of voices) {
        const labelParts = [v.name];
        const sub = [v.language, v.gender].filter(Boolean).join(' · ');
        if (sub) labelParts.push(`(${sub})`);
        const opt = select.createEl('option', {
          text: labelParts.join(' '),
          value: v.id,
        });
        if (v.id === this.plugin.settings.activeVoiceId) {
          opt.selected = true;
        }
      }

      // Auto-pick first voice if none set, or if current selection isn't in list
      const currentId = this.plugin.settings.activeVoiceId;
      const found = voices.find((v) => v.id === currentId);
      const first = voices[0];
      if (!found && first) {
        this.plugin.settings.activeVoiceId = first.id;
        select.value = first.id;
        void this.plugin.saveSettings();
      }
    };

    select.addEventListener('change', async () => {
      this.plugin.settings.activeVoiceId = select.value;
      await this.plugin.saveSettings();
    });

    const loadVoices = async (forceRefresh = false) => {
      if (forceRefresh) {
        invalidateVoiceCache(active.id);
      }
      const cached = getCachedVoices(active.id);
      if (cached) {
        populate(cached);
        status.setText('');
        return;
      }
      status.setText('Loading voices...');
      select.setAttr('disabled', 'true');
      try {
        const provider = getProvider(active.providerId);
        const voices = await provider.listVoices(active);
        setCachedVoices(active.id, voices);
        populate(voices);
        status.setText('');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        status.setText(`Failed to load voices: ${msg}`);
        select.empty();
        const opt = select.createEl('option', { text: '(error)', value: '' });
        opt.disabled = true;
      } finally {
        select.removeAttribute('disabled');
      }
    };

    refreshBtn.addEventListener('click', () => void loadVoices(true));
    void loadVoices(false);
  }

  // =========================================================================
  // Playback section
  // =========================================================================

  private renderPlaybackSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Playback', cls: 'recito-section-heading' });
    const card = containerEl.createDiv({ cls: 'recito-card recito-card--settings' });

    new Setting(card)
      .setName('Default speed')
      .setDesc('Playback speed when starting a new reading session.')
      .addDropdown((drop) => {
        drop
          .addOption('0.75', '0.75×')
          .addOption('1', '1×')
          .addOption('1.25', '1.25×')
          .addOption('1.5', '1.5×')
          .addOption('1.75', '1.75×')
          .addOption('2', '2×')
          .setValue(String(this.plugin.settings.playback.defaultSpeed))
          .onChange(async (value) => {
            this.plugin.settings.playback.defaultSpeed = parseFloat(value);
            await this.plugin.saveSettings();
          });
      });

    new Setting(card)
      .setName('Auto-scroll')
      .setDesc('Automatically scroll the note to keep the highlighted text in view.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.playback.autoScrollEnabled)
          .onChange(async (value) => {
            this.plugin.settings.playback.autoScrollEnabled = value;
            this.plugin.settings.highlight.autoScroll = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(card)
      .setName('Prefetch buffer')
      .setDesc('Number of chunks to pre-synthesize ahead of the current position.')
      .addDropdown((drop) => {
        drop
          .addOption('1', '1')
          .addOption('2', '2')
          .addOption('3', '3')
          .addOption('4', '4')
          .setValue(String(this.plugin.settings.playback.bufferSize))
          .onChange(async (value) => {
            this.plugin.settings.playback.bufferSize = parseInt(value, 10);
            await this.plugin.saveSettings();
          });
      });
  }

  // =========================================================================
  // Appearance section
  // =========================================================================

  private renderAppearanceSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Appearance', cls: 'recito-section-heading' });
    const card = containerEl.createDiv({ cls: 'recito-card recito-card--settings' });

    new Setting(card)
      .setName('Accent color')
      .setDesc(
        'Color used for word and sentence highlighting. Leave blank to use the Obsidian theme accent.',
      )
      .addColorPicker((picker) => {
        picker
          .setValue(this.plugin.settings.accentColor ?? DEFAULT_SETTINGS.accentColor ?? '#3b82f6')
          .onChange(async (value) => {
            this.plugin.settings.accentColor = value;
            await this.plugin.saveSettings();
          });
      })
      .addButton((btn) => {
        btn.setButtonText('Reset').onClick(async () => {
          this.plugin.settings.accentColor = null;
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }

  // =========================================================================
  // Backup section
  // =========================================================================

  private renderBackupSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Backup', cls: 'recito-section-heading' });
    const card = containerEl.createDiv({ cls: 'recito-card recito-card--settings' });

    new Setting(card)
      .setName('Export settings')
      .setDesc(
        'Save all providers and settings as a JSON file. The same file format is shared with the Recito Chrome extension.',
      )
      .addButton((btn) => {
        btn.setButtonText('Export').onClick(() => {
          try {
            const envelope = buildExport(this.plugin.settings);
            const blob = new Blob([JSON.stringify(envelope, null, 2)], {
              type: 'application/json',
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'recito-settings.json';
            a.click();
            URL.revokeObjectURL(url);
            new Notice('Settings exported.');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Export failed: ${msg}`);
          }
        });
      });

    new Setting(card)
      .setName('Import settings')
      .setDesc(
        'Replace your current providers and settings with a previously exported JSON file. Reading progress is preserved.',
      )
      .addButton((btn) => {
        btn.setButtonText('Import…').onClick(() => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.json,application/json';
          input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
              const text = await file.text();
              const parsed = JSON.parse(text);
              const result = applyImport(this.plugin.settings, parsed);

              new ConfirmImportModal(
                this.app,
                this.plugin.settings.providers.length,
                result.providerCount,
                async () => {
                  this.plugin.settings = result.next;
                  await this.plugin.saveSettings();
                  this.display();
                  new Notice('Settings imported.');
                  for (const w of result.warnings) {
                    new Notice(w);
                  }
                },
              ).open();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              new Notice(`Import failed: ${msg}`);
            }
          };
          input.click();
        });
      });
  }
}

// =========================================================================
// Provider Add/Edit Modal
// =========================================================================

class ProviderModal extends Modal {
  private providerId: string;
  private providerName: string;
  private existing: ProviderConfig | null;
  private onSubmit: (config: ProviderConfig) => void;

  // Form state
  private apiKey = '';
  private baseUrl = '';
  private displayName = '';
  private elevenLabsModelId = 'eleven_multilingual_v2';
  private customModel = 'tts-1';

  constructor(
    app: App,
    providerId: string,
    providerName: string,
    existing: ProviderConfig | null,
    onSubmit: (config: ProviderConfig) => void,
  ) {
    super(app);
    this.providerId = providerId;
    this.providerName = providerName;
    this.existing = existing;
    this.onSubmit = onSubmit;

    if (existing) {
      this.apiKey = existing.apiKey;
      this.baseUrl = existing.baseUrl ?? '';
      this.displayName = existing.name;
      this.elevenLabsModelId =
        (existing.extraParams?.model_id as string) ?? 'eleven_multilingual_v2';
      this.customModel = (existing.extraParams?.model as string) ?? 'tts-1';
    } else {
      this.displayName = providerName;
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('recito-provider-modal');

    contentEl.createEl('h3', {
      text: `${this.existing ? 'Edit' : 'Add'} ${this.providerName} key`,
    });

    if (this.providerId === 'custom') {
      new Setting(contentEl)
        .setName('Display name')
        .setDesc('Label shown as this provider\'s title in settings.')
        .addText((text) => {
          text
            .setPlaceholder(this.providerName)
            .setValue(this.displayName)
            .onChange((value) => {
              this.displayName = value;
            });
        });
    }

    new Setting(contentEl)
      .setName('API key')
      .addText((text) => {
        text
          .setPlaceholder('Enter your API key')
          .setValue(this.apiKey)
          .onChange((value) => {
            this.apiKey = value;
          });
        text.inputEl.type = 'password';
      });

    if (this.providerId === 'elevenlabs') {
      new Setting(contentEl)
        .setName('Model')
        .setDesc('ElevenLabs synthesis model.')
        .addDropdown((drop) => {
          for (const m of ELEVENLABS_MODELS) {
            drop.addOption(m.modelId, m.label);
          }
          drop.setValue(this.elevenLabsModelId).onChange((value) => {
            this.elevenLabsModelId = value;
          });
        });
    }

    if (this.providerId === 'custom') {
      new Setting(contentEl)
        .setName('Base URL')
        .setDesc('OpenAI-compatible endpoint (e.g. https://your-server/v1)')
        .addText((text) => {
          text
            .setPlaceholder('https://api.example.com/v1')
            .setValue(this.baseUrl)
            .onChange((value) => {
              this.baseUrl = value;
            });
        });

      new Setting(contentEl)
        .setName('Model')
        .setDesc('Model identifier sent to the endpoint.')
        .addText((text) => {
          text
            .setPlaceholder('tts-1')
            .setValue(this.customModel)
            .onChange((value) => {
              this.customModel = value;
            });
        });
    }

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText('Cancel').onClick(() => this.close());
      })
      .addButton((btn) => {
        btn
          .setButtonText('Save')
          .setCta()
          .onClick(() => {
            if (!this.apiKey.trim()) {
              new Notice('API key cannot be empty.');
              return;
            }
            if (this.providerId === 'custom' && !this.baseUrl.trim()) {
              new Notice('Base URL is required for custom providers.');
              return;
            }

            const extraParams: Record<string, unknown> = {};
            if (this.providerId === 'elevenlabs') {
              extraParams.model_id = this.elevenLabsModelId;
            } else if (this.providerId === 'custom' && this.customModel.trim()) {
              extraParams.model = this.customModel.trim();
            }

            const config: ProviderConfig = {
              id: this.existing?.id ?? `${this.providerId}-${Date.now()}`,
              providerId: this.providerId,
              name: this.displayName.trim() || this.providerName,
              apiKey: this.apiKey.trim(),
              baseUrl: this.baseUrl.trim() || undefined,
              extraParams: Object.keys(extraParams).length > 0 ? extraParams : undefined,
            };

            this.onSubmit(config);
            this.close();
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// =========================================================================
// Confirm Import Modal
// =========================================================================

class ConfirmImportModal extends Modal {
  private currentCount: number;
  private incomingCount: number;
  private onConfirm: () => void;

  constructor(
    app: App,
    currentCount: number,
    incomingCount: number,
    onConfirm: () => void,
  ) {
    super(app);
    this.currentCount = currentCount;
    this.incomingCount = incomingCount;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('recito-provider-modal');

    contentEl.createEl('h3', { text: 'Import settings?' });
    contentEl.createEl('p', {
      text:
        `This will import ${this.incomingCount} provider${this.incomingCount === 1 ? '' : 's'} ` +
        `and overwrite your current settings. Your current ${this.currentCount} provider` +
        `${this.currentCount === 1 ? '' : 's'} will be replaced. Reading progress will be kept.`,
    });

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText('Cancel').onClick(() => this.close());
      })
      .addButton((btn) => {
        btn
          .setButtonText('Import')
          .setCta()
          .onClick(() => {
            this.onConfirm();
            this.close();
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
