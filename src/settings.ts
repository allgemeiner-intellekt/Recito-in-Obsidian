import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type RecitoPlugin from './main';
import type { ProviderConfig } from './lib/types';
import { DEFAULT_SETTINGS } from './lib/constants';
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

    containerEl.createEl('h2', { text: 'Recito Settings' });

    this.renderProvidersSection(containerEl);
    this.renderPlaybackSection(containerEl);
    this.renderAppearanceSection(containerEl);
  }

  // =========================================================================
  // Providers section
  // =========================================================================

  private renderProvidersSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'TTS Providers' });

    for (const meta of PROVIDER_LIST) {
      const configured = this.plugin.settings.providers.filter(
        (p) => p.providerId === meta.id,
      );

      const settingEl = new Setting(containerEl)
        .setName(meta.name)
        .setDesc(meta.description);

      // Show configured keys count
      if (configured.length > 0) {
        const keyList = configured
          .map((p) => {
            const masked = p.apiKey ? '••••' + p.apiKey.slice(-4) : '(no key)';
            const isActive = p.id === this.plugin.settings.activeProviderGroup;
            return `${masked}${isActive ? ' (active)' : ''}`;
          })
          .join(', ');
        settingEl.setDesc(`${meta.description} — ${keyList}`);
      }

      // Add key button
      settingEl.addButton((btn) => {
        btn.setButtonText('Add key').onClick(async () => {
          const key = window.prompt(`Enter API key for ${meta.name}:`);
          if (!key) return;

          let baseUrl: string | undefined;
          if (meta.id === 'custom') {
            const url = window.prompt('Enter base URL (e.g. https://your-server/v1):');
            baseUrl = url ?? undefined;
          }

          const config: ProviderConfig = {
            id: `${meta.id}-${Date.now()}`,
            providerId: meta.id,
            name: meta.name,
            apiKey: key,
            baseUrl,
          };

          this.plugin.settings.providers.push(config);

          // Auto-activate if this is the first provider
          if (!this.plugin.settings.activeProviderGroup) {
            this.plugin.settings.activeProviderGroup = config.id;
          }

          await this.plugin.saveSettings();
          this.display();
        });
      });

      // Per-key controls: set active / test / remove
      for (const config of configured) {
        const keyRow = containerEl.createDiv({ cls: 'recito-key-row' });

        const isActive = config.id === this.plugin.settings.activeProviderGroup;
        const masked = config.apiKey ? '••••' + config.apiKey.slice(-4) : '(no key)';
        keyRow.createEl('span', {
          text: `${masked}${isActive ? ' ✓' : ''}`,
          cls: 'recito-key-label',
        });

        // Set active button
        if (!isActive) {
          new Setting(keyRow)
            .addButton((btn) => {
              btn.setButtonText('Set active').onClick(async () => {
                this.plugin.settings.activeProviderGroup = config.id;
                await this.plugin.saveSettings();
                this.display();
              });
            })
            .addButton((btn) => {
              btn.setButtonText('Test').onClick(async () => {
                await this.testKey(config);
              });
            })
            .addButton((btn) => {
              btn.setButtonText('Remove').setWarning().onClick(async () => {
                this.plugin.settings.providers = this.plugin.settings.providers.filter(
                  (p) => p.id !== config.id,
                );
                if (this.plugin.settings.activeProviderGroup === config.id) {
                  this.plugin.settings.activeProviderGroup =
                    this.plugin.settings.providers[0]?.id ?? null;
                }
                invalidateVoiceCache(config.id);
                await this.plugin.saveSettings();
                this.display();
              });
            });
        } else {
          new Setting(keyRow)
            .addButton((btn) => {
              btn.setButtonText('Test').onClick(async () => {
                await this.testKey(config);
              });
            })
            .addButton((btn) => {
              btn.setButtonText('Remove').setWarning().onClick(async () => {
                this.plugin.settings.providers = this.plugin.settings.providers.filter(
                  (p) => p.id !== config.id,
                );
                if (this.plugin.settings.activeProviderGroup === config.id) {
                  this.plugin.settings.activeProviderGroup =
                    this.plugin.settings.providers[0]?.id ?? null;
                }
                invalidateVoiceCache(config.id);
                await this.plugin.saveSettings();
                this.display();
              });
            });
        }
      }
    }
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
  // Playback section
  // =========================================================================

  private renderPlaybackSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Playback' });

    // Default speed
    new Setting(containerEl)
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

    // Auto-scroll toggle
    new Setting(containerEl)
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

    // Prefetch buffer
    new Setting(containerEl)
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
    containerEl.createEl('h3', { text: 'Appearance' });

    new Setting(containerEl)
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
