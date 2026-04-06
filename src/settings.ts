import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type RecitoPlugin from './main';
import type { ProviderConfig, Voice } from './lib/types';
import { DEFAULT_SETTINGS } from './lib/constants';
import { PROVIDER_LIST, getProvider } from './providers/registry';
import { ELEVENLABS_MODELS } from './providers/elevenlabs';
import { getCachedVoices, setCachedVoices, invalidateVoiceCache } from './providers/voice-cache';

function maskKey(key: string): string {
  if (!key) return '(no key)';
  if (key.length <= 8) return '••••';
  return '••••' + key.slice(-4);
}

function getActiveConfig(plugin: RecitoPlugin): ProviderConfig | null {
  const id = plugin.settings.activeProviderGroup;
  if (!id) return null;
  return plugin.settings.providers.find((p) => p.id === id) ?? null;
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
  }

  // =========================================================================
  // Providers section
  // =========================================================================

  private renderProvidersSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'TTS Providers', cls: 'recito-section-heading' });

    for (const meta of PROVIDER_LIST) {
      const card = containerEl.createDiv({ cls: 'recito-card' });

      // Header: name + description + Add key button
      const header = card.createDiv({ cls: 'recito-card-header' });
      const headerText = header.createDiv({ cls: 'recito-card-header-text' });
      headerText.createEl('div', { text: meta.name, cls: 'recito-card-title' });
      headerText.createEl('div', { text: meta.description, cls: 'recito-card-desc' });

      const addBtn = header.createEl('button', {
        text: '+ Add key',
        cls: 'mod-cta recito-card-action',
      });
      addBtn.addEventListener('click', () => {
        new ProviderModal(this.app, meta.id, meta.name, null, async (config) => {
          this.plugin.settings.providers.push(config);
          if (!this.plugin.settings.activeProviderGroup) {
            this.plugin.settings.activeProviderGroup = config.id;
          }
          await this.plugin.saveSettings();
          this.display();
        }).open();
      });

      // Key list
      const configured = this.plugin.settings.providers.filter(
        (p) => p.providerId === meta.id,
      );

      const body = card.createDiv({ cls: 'recito-card-body' });
      if (configured.length === 0) {
        body.createEl('div', {
          text: 'No keys configured.',
          cls: 'recito-empty',
        });
      } else {
        for (const config of configured) {
          this.renderKeyRow(body, config, meta.id);
        }
      }
    }
  }

  private renderKeyRow(parent: HTMLElement, config: ProviderConfig, providerId: string): void {
    const isActive = config.id === this.plugin.settings.activeProviderGroup;
    const row = parent.createDiv({ cls: 'recito-key-row' + (isActive ? ' is-active' : '') });

    // Status dot
    row.createDiv({ cls: 'recito-key-dot' + (isActive ? ' is-active' : '') });

    // Info column
    const info = row.createDiv({ cls: 'recito-key-info' });
    const titleLine = info.createDiv({ cls: 'recito-key-title' });
    titleLine.createSpan({ text: maskKey(config.apiKey), cls: 'recito-key-mask' });
    if (config.name && config.name !== providerId) {
      titleLine.createSpan({ text: config.name, cls: 'recito-key-name' });
    }
    if (isActive) {
      titleLine.createSpan({ text: 'Active', cls: 'recito-badge' });
    }

    // Subline: provider type + model
    const subParts: string[] = [];
    if (providerId === 'elevenlabs') {
      const modelId = (config.extraParams?.model_id as string) ?? 'eleven_multilingual_v2';
      const label = ELEVENLABS_MODELS.find((m) => m.modelId === modelId)?.label ?? modelId;
      subParts.push(`model: ${label}`);
    } else if (providerId === 'custom') {
      const model = (config.extraParams?.model as string) ?? 'tts-1';
      subParts.push(`model: ${model}`);
      if (config.baseUrl) subParts.push(config.baseUrl);
    }
    if (subParts.length > 0) {
      info.createDiv({ text: subParts.join(' · '), cls: 'recito-key-sub' });
    }

    // Actions
    const actions = row.createDiv({ cls: 'recito-key-actions' });

    if (!isActive) {
      const setActiveBtn = actions.createEl('button', { text: 'Set active' });
      setActiveBtn.addEventListener('click', async () => {
        this.plugin.settings.activeProviderGroup = config.id;
        // Clear voice — different provider/key likely has different voices
        this.plugin.settings.activeVoiceId = null;
        await this.plugin.saveSettings();
        this.display();
      });
    }

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
        if (idx >= 0) {
          this.plugin.settings.providers[idx] = updated;
        }
        invalidateVoiceCache(config.id);
        await this.plugin.saveSettings();
        this.display();
      }).open();
    });

    const removeBtn = actions.createEl('button', { text: 'Remove', cls: 'mod-warning' });
    removeBtn.addEventListener('click', async () => {
      this.plugin.settings.providers = this.plugin.settings.providers.filter(
        (p) => p.id !== config.id,
      );
      if (this.plugin.settings.activeProviderGroup === config.id) {
        this.plugin.settings.activeProviderGroup =
          this.plugin.settings.providers[0]?.id ?? null;
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

    const active = getActiveConfig(this.plugin);
    if (!active) {
      body.createEl('div', {
        text: 'No active provider. Add a key and set it active to choose a voice.',
        cls: 'recito-empty',
      });
      return;
    }

    const meta = PROVIDER_LIST.find((m) => m.id === active.providerId);
    body.createEl('div', {
      text: `Active provider: ${meta?.name ?? active.providerId}`,
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

    new Setting(contentEl)
      .setName('Display name')
      .setDesc('Optional label to identify this key.')
      .addText((text) => {
        text
          .setPlaceholder(this.providerName)
          .setValue(this.displayName)
          .onChange((value) => {
            this.displayName = value;
          });
      });

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
