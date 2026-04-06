# Settings Export / Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cross-tool settings export/import to the Obsidian plugin and the matching minimal changes to the Chrome extension, so a single `recito-settings.json` file works in both directions.

**Architecture:** A small, isolated, pure module (`src/lib/settings-io.ts`) does the envelope build/apply. The Obsidian settings tab grows a Backup section with two buttons and one confirm modal. The Chrome extension's existing import/export grows a `version` field and a one-line `accentColor → themeColor` alias. Foreign fields round-trip via an opaque `_foreign` bag on Obsidian's side and via Chrome's existing spread-merge on Chrome's side.

**Tech Stack:** TypeScript, Obsidian plugin API (`PluginSettingTab`, `Modal`, `Notice`), Vitest for unit tests on the Obsidian side (added as part of this plan — the Obsidian repo currently has no test runner), the Chrome extension's existing Vitest setup.

**Spec:** `docs/superpowers/specs/2026-04-06-settings-export-import-design.md`

---

## File Structure

**Obsidian plugin** (`/Users/yuhanli/allgemeiner-intellekt/obsidian-dev/.obsidian/plugins/Recito-in-Obsidian`):

- **Create:** `src/lib/settings-io.ts` — pure module, `buildExport` + `applyImport`. No I/O, no DOM, no Obsidian API. ~120 lines.
- **Create:** `src/lib/settings-io.test.ts` — Vitest unit tests. ~200 lines.
- **Create:** `vitest.config.ts` — minimal Vitest config (Node env, default include glob).
- **Modify:** `package.json` — add `vitest` devDep + `test` script.
- **Modify:** `src/lib/types.ts` — add `_foreign?: Record<string, unknown>` to `RecitoSettings`.
- **Modify:** `src/settings.ts` — add `renderBackupSection` and `ConfirmImportModal`.

**Chrome extension** (`/Users/yuhanli/allgemeiner-intellekt/immersive-reader`):

- **Modify:** `src/options/Options.tsx` — add `version: 1` to export, add `accentColor → themeColor` alias and version handling to import (~7 lines total).

---

## Task 1: Set up Vitest in the Obsidian plugin

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

The Obsidian plugin currently has no test runner. We need one for `settings-io.ts`. Vitest is small (one devDep), zero-config-friendly, and matches what the Chrome extension already uses.

- [ ] **Step 1: Install Vitest as a devDep**

Run from the Obsidian plugin root:
```bash
npm install --save-dev vitest@^1.6.0
```
Expected: `vitest` appears in `devDependencies` in `package.json`, lockfile updated.

- [ ] **Step 2: Add `test` script to `package.json`**

Edit `package.json`. In the `"scripts"` object, add the `test` line so it looks like:
```json
"scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production",
    "test": "vitest run",
    "version": "node version-bump.mjs && git add manifest.json versions.json",
    "lint": "eslint ."
}
```

- [ ] **Step 3: Create minimal `vitest.config.ts`**

Create `vitest.config.ts` at the repo root:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Smoke-test the runner with a placeholder spec**

Create `src/lib/_vitest-smoke.test.ts` (will be deleted in Step 6):
```ts
import { describe, it, expect } from 'vitest';

describe('vitest smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run the smoke test**

Run: `npm test`
Expected: `1 passed`. The runner discovers `src/lib/_vitest-smoke.test.ts` and the assertion passes.

- [ ] **Step 6: Delete the smoke file and commit**

```bash
rm src/lib/_vitest-smoke.test.ts
git add package.json package-lock.json vitest.config.ts
git commit -m "test: add vitest runner for unit tests"
```

---

## Task 2: Add `_foreign` field to `RecitoSettings`

**Files:**
- Modify: `src/lib/types.ts`

Adds the opaque passthrough bag. No behavior change yet — just the type.

- [ ] **Step 1: Add the field to the interface**

Edit `src/lib/types.ts`. In the `RecitoSettings` interface, add `_foreign` as the last field:
```ts
export interface RecitoSettings {
  providers: ProviderConfig[];
  activeProviderGroup: string | null;
  activeVoiceId: string | null;
  playback: PlaybackSettings;
  highlight: HighlightSettings;
  accentColor: string | null;
  readingProgress: Record<string, ReadingProgress>;
  ui: UiSettings;
  /** Opaque passthrough for cross-tool import: foreign settings keys
   *  this side doesn't recognize, kept verbatim so they round-trip on
   *  re-export. */
  _foreign?: Record<string, unknown>;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: no errors. (`_foreign` is optional so `DEFAULT_SETTINGS` in `constants.ts` doesn't need to set it.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): add _foreign passthrough to RecitoSettings"
```

---

## Task 3: Write `settings-io.ts` tests (TDD)

**Files:**
- Create: `src/lib/settings-io.test.ts`

Write the full test suite first. All tests will fail at this stage because `settings-io.ts` doesn't exist yet.

- [ ] **Step 1: Create the test file**

Create `src/lib/settings-io.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildExport, applyImport } from './settings-io';
import type { RecitoSettings, ProviderConfig } from './types';

function makeSettings(overrides: Partial<RecitoSettings> = {}): RecitoSettings {
  return {
    providers: [],
    activeProviderGroup: null,
    activeVoiceId: null,
    accentColor: null,
    playback: {
      defaultSpeed: 1.0,
      defaultVolume: 1.0,
      bufferSize: 2,
      autoScrollEnabled: true,
    },
    highlight: {
      wordColor: null,
      sentenceColor: null,
      wordEnabled: true,
      sentenceEnabled: true,
      autoScroll: true,
    },
    readingProgress: {},
    ui: { artworkCollapsed: false },
    ...overrides,
  };
}

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p1',
    providerId: 'openai',
    name: 'OpenAI',
    apiKey: 'sk-test',
    ...overrides,
  };
}

describe('buildExport', () => {
  it('writes a v1 envelope with providers and settings', () => {
    const s = makeSettings({
      providers: [makeProvider()],
      activeProviderGroup: 'openai',
      accentColor: '#abcdef',
    });
    const env = buildExport(s);
    expect(env.version).toBe(1);
    expect(env.providers).toHaveLength(1);
    expect(env.providers[0]?.apiKey).toBe('sk-test');
    expect(env.settings.activeProviderGroup).toBe('openai');
    expect(env.settings.accentColor).toBe('#abcdef');
  });

  it('strips readingProgress from the exported settings', () => {
    const s = makeSettings({
      readingProgress: {
        'note.md': { notePath: 'note.md', chunkIndex: 3, totalChunks: 10, timestamp: 0 },
      },
    });
    const env = buildExport(s);
    expect(env.settings).not.toHaveProperty('readingProgress');
  });

  it('does not nest providers inside settings', () => {
    const s = makeSettings({ providers: [makeProvider()] });
    const env = buildExport(s);
    expect(env.settings).not.toHaveProperty('providers');
  });

  it('re-emits foreign keys at the top level of settings', () => {
    const s = makeSettings({
      _foreign: { theme: 'dark', onboardingComplete: true },
    });
    const env = buildExport(s);
    expect(env.settings.theme).toBe('dark');
    expect(env.settings.onboardingComplete).toBe(true);
    expect(env.settings).not.toHaveProperty('_foreign');
  });

  it('preserves ui.artworkCollapsed in the export', () => {
    const s = makeSettings({ ui: { artworkCollapsed: true } });
    const env = buildExport(s);
    expect((env.settings.ui as { artworkCollapsed: boolean }).artworkCollapsed).toBe(true);
  });
});

describe('applyImport', () => {
  it('copies recognized scalar fields', () => {
    const current = makeSettings();
    const env = {
      version: 1,
      providers: [makeProvider()],
      settings: {
        activeProviderGroup: 'openai',
        activeVoiceId: 'alloy',
        accentColor: '#123456',
      },
    };
    const { next, providerCount, warnings } = applyImport(current, env);
    expect(next.activeProviderGroup).toBe('openai');
    expect(next.activeVoiceId).toBe('alloy');
    expect(next.accentColor).toBe('#123456');
    expect(providerCount).toBe(1);
    expect(warnings).toEqual([]);
  });

  it('shallow-merges nested playback so omitted sub-fields keep current values', () => {
    const current = makeSettings({
      playback: {
        defaultSpeed: 1.0,
        defaultVolume: 0.7,
        bufferSize: 2,
        autoScrollEnabled: true,
      },
    });
    const env = {
      version: 1,
      providers: [],
      settings: { playback: { defaultSpeed: 1.5 } },
    };
    const { next } = applyImport(current, env);
    expect(next.playback.defaultSpeed).toBe(1.5);
    expect(next.playback.defaultVolume).toBe(0.7);
    expect(next.playback.bufferSize).toBe(2);
    expect(next.playback.autoScrollEnabled).toBe(true);
  });

  it('aliases themeColor → accentColor when accentColor is absent', () => {
    const current = makeSettings();
    const env = {
      version: 1,
      providers: [],
      settings: { themeColor: '#ff00ff' },
    };
    const { next } = applyImport(current, env);
    expect(next.accentColor).toBe('#ff00ff');
  });

  it('prefers accentColor over themeColor when both are present', () => {
    const current = makeSettings();
    const env = {
      version: 1,
      providers: [],
      settings: { accentColor: '#aaaaaa', themeColor: '#bbbbbb' },
    };
    const { next } = applyImport(current, env);
    expect(next.accentColor).toBe('#aaaaaa');
  });

  it('stashes unknown top-level keys in _foreign', () => {
    const current = makeSettings();
    const env = {
      version: 1,
      providers: [],
      settings: {
        theme: 'dark',
        onboardingComplete: true,
        playback: { skipReferences: true, defaultSpeed: 1.25 },
      },
    };
    const { next } = applyImport(current, env);
    expect(next._foreign?.theme).toBe('dark');
    expect(next._foreign?.onboardingComplete).toBe(true);
    // playback.skipReferences is NOT a foreign top-level key — it's a sub-key
    // of a recognized object, so it lives inside next.playback (as an extra
    // field that TypeScript doesn't know about but JS preserves).
    expect((next.playback as unknown as Record<string, unknown>).skipReferences).toBe(true);
    expect(next.playback.defaultSpeed).toBe(1.25);
  });

  it('round-trips foreign fields through buildExport → applyImport', () => {
    const initial = makeSettings({
      _foreign: { theme: 'dark', onboardingComplete: true },
    });
    const env = buildExport(initial);
    const { next } = applyImport(makeSettings(), JSON.parse(JSON.stringify(env)));
    expect(next._foreign?.theme).toBe('dark');
    expect(next._foreign?.onboardingComplete).toBe(true);
  });

  it('preserves the disabled flag on imported providers', () => {
    const current = makeSettings();
    const env = {
      version: 1,
      providers: [makeProvider({ disabled: true })],
      settings: {},
    };
    const { next } = applyImport(current, env);
    expect(next.providers[0]?.disabled).toBe(true);
  });

  it('does not modify current.readingProgress', () => {
    const current = makeSettings({
      readingProgress: {
        'note.md': { notePath: 'note.md', chunkIndex: 5, totalChunks: 10, timestamp: 123 },
      },
    });
    const env = {
      version: 1,
      providers: [],
      settings: { readingProgress: { 'other.md': { notePath: 'other.md', chunkIndex: 0, totalChunks: 1, timestamp: 0 } } },
    };
    const { next } = applyImport(current, env);
    expect(next.readingProgress).toEqual(current.readingProgress);
  });

  it('treats missing version as 1 (no warning)', () => {
    const current = makeSettings();
    const env = { providers: [], settings: {} };
    const { warnings } = applyImport(current, env);
    expect(warnings).toEqual([]);
  });

  it('warns but still imports when version > 1', () => {
    const current = makeSettings();
    const env = { version: 99, providers: [], settings: { activeVoiceId: 'x' } };
    const { next, warnings } = applyImport(current, env);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/version/i);
    expect(next.activeVoiceId).toBe('x');
  });

  it('clears activeVoiceId if activeProviderGroup is invalid after import', () => {
    const current = makeSettings({
      providers: [makeProvider({ id: 'p1' })],
      activeProviderGroup: 'openai',
      activeVoiceId: 'alloy',
    });
    const env = {
      version: 1,
      providers: [],
      settings: { activeProviderGroup: 'nonexistent' },
    };
    const { next } = applyImport(current, env);
    expect(next.activeProviderGroup).toBeNull();
    expect(next.activeVoiceId).toBeNull();
  });

  it('throws on non-object input', () => {
    const current = makeSettings();
    expect(() => applyImport(current, null)).toThrow();
    expect(() => applyImport(current, 'not an object')).toThrow();
    expect(() => applyImport(current, 42)).toThrow();
  });

  it('throws when providers is not an array', () => {
    const current = makeSettings();
    expect(() => applyImport(current, { providers: 'nope', settings: {} })).toThrow();
  });

  it('throws when settings is not an object', () => {
    const current = makeSettings();
    expect(() => applyImport(current, { providers: [], settings: 'nope' })).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests, expect all to fail**

Run: `npm test`
Expected: every test fails with a module-resolution error like `Cannot find module './settings-io'`. This is the failing-test stage of TDD.

- [ ] **Step 3: Commit the failing tests**

```bash
git add src/lib/settings-io.test.ts
git commit -m "test(settings-io): add failing tests for export/import"
```

---

## Task 4: Implement `settings-io.ts`

**Files:**
- Create: `src/lib/settings-io.ts`

Pure module: takes settings in, returns envelopes/settings out. No DOM, no `Notice`, no plugin reference.

- [ ] **Step 1: Create the module**

Create `src/lib/settings-io.ts`:
```ts
import type { ProviderConfig, RecitoSettings } from './types';

/** Cross-tool export envelope shape. Shared with the Chrome extension. */
export interface ExportEnvelope {
  version: 1;
  providers: ProviderConfig[];
  settings: Record<string, unknown>;
}

export interface ImportResult {
  next: RecitoSettings;
  providerCount: number;
  warnings: string[];
}

/** Recognized top-level keys inside `envelope.settings`. Anything else
 *  (other than the aliased themeColor and the never-nested providers)
 *  is stashed in `_foreign` for round-tripping. */
const RECOGNIZED_SETTINGS_KEYS = new Set([
  'activeProviderGroup',
  'activeVoiceId',
  'accentColor',
  'playback',
  'highlight',
  'ui',
]);

/** Build a portable export envelope from the current Obsidian settings.
 *  Strips reading progress; re-emits any opaque foreign fields. */
export function buildExport(settings: RecitoSettings): ExportEnvelope {
  // Deep clone so we never mutate caller state.
  const clone = JSON.parse(JSON.stringify(settings)) as RecitoSettings;

  // Pull providers out of the settings clone — they live at the envelope's
  // top level to match Chrome's existing format.
  const providers = clone.providers ?? [];

  const settingsOut: Record<string, unknown> = {
    activeProviderGroup: clone.activeProviderGroup,
    activeVoiceId: clone.activeVoiceId,
    accentColor: clone.accentColor,
    playback: clone.playback,
    highlight: clone.highlight,
    ui: clone.ui,
  };

  // Re-emit foreign fields at the top level so they round-trip out.
  if (clone._foreign) {
    for (const [key, value] of Object.entries(clone._foreign)) {
      if (!(key in settingsOut)) {
        settingsOut[key] = value;
      }
    }
  }

  return {
    version: 1,
    providers,
    settings: settingsOut,
  };
}

/** Apply an imported envelope on top of the current settings.
 *  Recognized fields are merged; unknown fields are stashed in `_foreign`.
 *  Reading progress on `current` is preserved untouched. */
export function applyImport(current: RecitoSettings, envelope: unknown): ImportResult {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Import file is not a JSON object.');
  }
  const env = envelope as Record<string, unknown>;

  if (!Array.isArray(env.providers)) {
    throw new Error('Import file is missing a `providers` array.');
  }
  if (!env.settings || typeof env.settings !== 'object') {
    throw new Error('Import file is missing a `settings` object.');
  }
  const importedSettings = env.settings as Record<string, unknown>;

  const warnings: string[] = [];
  const version = typeof env.version === 'number' ? env.version : 1;
  if (version > 1) {
    warnings.push(
      `Import file version is ${version}, but this version of Recito only understands version 1. Importing best-effort; some fields may be ignored.`,
    );
  }

  // Start from a deep clone of `current` so we don't mutate it.
  const next = JSON.parse(JSON.stringify(current)) as RecitoSettings;

  // Providers: verbatim copy, preserving any unknown per-provider fields.
  next.providers = (env.providers as ProviderConfig[]).map((p) => ({ ...p }));

  // Recognized scalar fields.
  if ('activeProviderGroup' in importedSettings) {
    next.activeProviderGroup = importedSettings.activeProviderGroup as string | null;
  }
  if ('activeVoiceId' in importedSettings) {
    next.activeVoiceId = importedSettings.activeVoiceId as string | null;
  }

  // accentColor / themeColor alias.
  if (typeof importedSettings.accentColor === 'string') {
    next.accentColor = importedSettings.accentColor;
  } else if (typeof importedSettings.themeColor === 'string') {
    next.accentColor = importedSettings.themeColor;
  }

  // Nested objects — shallow-merged so a partial import doesn't wipe sub-fields.
  if (importedSettings.playback && typeof importedSettings.playback === 'object') {
    next.playback = {
      ...next.playback,
      ...(importedSettings.playback as Record<string, unknown>),
    } as RecitoSettings['playback'];
  }
  if (importedSettings.highlight && typeof importedSettings.highlight === 'object') {
    next.highlight = {
      ...next.highlight,
      ...(importedSettings.highlight as Record<string, unknown>),
    } as RecitoSettings['highlight'];
  }
  if (importedSettings.ui && typeof importedSettings.ui === 'object') {
    next.ui = {
      ...next.ui,
      ...(importedSettings.ui as Record<string, unknown>),
    } as RecitoSettings['ui'];
  }

  // Foreign passthrough: every top-level key not recognized, not aliased,
  // and not the (defensively excluded) nested providers field.
  const foreign: Record<string, unknown> = { ...(next._foreign ?? {}) };
  for (const [key, value] of Object.entries(importedSettings)) {
    if (RECOGNIZED_SETTINGS_KEYS.has(key)) continue;
    if (key === 'accentColor' || key === 'themeColor') continue;
    if (key === 'providers') continue;
    foreign[key] = value;
  }
  if (Object.keys(foreign).length > 0) {
    next._foreign = foreign;
  }

  // Reading progress: keep current as-is. Import never touches it.
  next.readingProgress = current.readingProgress;

  // Ensure activeProviderGroup still points at an existing pool. If not,
  // null it out and clear the voice id (different pool, different voices).
  const groupExists =
    next.activeProviderGroup !== null &&
    next.providers.some((p) => groupKeyOf(p) === next.activeProviderGroup);
  if (!groupExists) {
    next.activeProviderGroup = next.providers[0] ? groupKeyOf(next.providers[0]) : null;
    next.activeVoiceId = null;
  }

  return { next, providerCount: next.providers.length, warnings };
}

/** Local copy of the group-key rule from `lib/group-key.ts`. Duplicated here
 *  to keep `settings-io.ts` free of any other module dependencies for unit
 *  testing — the rule is small and stable. */
function groupKeyOf(config: ProviderConfig): string {
  if (config.providerId === 'custom') {
    const normalized = (config.baseUrl || '').trim().replace(/\/+$/, '');
    return `custom:${normalized}`;
  }
  return config.providerId;
}
```

- [ ] **Step 2: Run the test suite**

Run: `npm test`
Expected: all tests in `settings-io.test.ts` pass.

- [ ] **Step 3: Type-check the whole project**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/settings-io.ts
git commit -m "feat(settings-io): implement export/import envelope module"
```

---

## Task 5: Add Backup section to the Obsidian settings tab

**Files:**
- Modify: `src/settings.ts`

Two buttons (Export, Import) under a new Backup section, plus a small `ConfirmImportModal` that follows the same pattern as the existing `ProviderModal`.

- [ ] **Step 1: Add the `settings-io` import**

Edit `src/settings.ts`. Add a new import line below the existing `./lib/group-key` import:
```ts
import { buildExport, applyImport } from './lib/settings-io';
```

- [ ] **Step 2: Wire the new section into `display()`**

In `display()`, after the existing `this.renderAppearanceSection(containerEl);` line, add:
```ts
this.renderBackupSection(containerEl);
```

- [ ] **Step 3: Implement `renderBackupSection`**

Add this method at the bottom of the `RecitoSettingTab` class (just before the closing `}`):
```ts
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
```

- [ ] **Step 4: Add the `ConfirmImportModal` class**

At the very bottom of `src/settings.ts` (after the existing `ProviderModal` class), add:
```ts
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
```

- [ ] **Step 5: Type-check**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: no errors.

- [ ] **Step 6: Build to confirm esbuild is happy**

Run: `npm run build`
Expected: build succeeds, `main.js` regenerated.

- [ ] **Step 7: Manual smoke test in Obsidian**

Reload the plugin in Obsidian (or restart Obsidian). Open Settings → Recito. Scroll to the new Backup section. Click Export — verify a `recito-settings.json` file downloads and contains `{"version": 1, "providers": [...], "settings": {...}}`. Click Import, pick that same file, confirm in the modal. Verify the Notice "Settings imported." appears and providers/voice/playback values are unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/settings.ts
git commit -m "feat(settings): add Backup section with export/import"
```

---

## Task 6: Update the Chrome extension's import/export

**Files:**
- Modify: `/Users/yuhanli/allgemeiner-intellekt/immersive-reader/src/options/Options.tsx`

Three small additions inside the existing `exportSettings` and `importSettings` functions.

- [ ] **Step 1: Add `version: 1` to the export envelope**

In `src/options/Options.tsx`, find the `exportSettings` function. Replace its body's `Blob` construction:

The current code:
```ts
const exportSettings = () => {
    const blob = new Blob([JSON.stringify({ providers, settings }, null, 2)], {
      type: 'application/json',
    });
```
becomes:
```ts
const exportSettings = () => {
    const blob = new Blob(
      [JSON.stringify({ version: 1, providers, settings }, null, 2)],
      { type: 'application/json' },
    );
```

- [ ] **Step 2: Add version handling and accentColor alias to import**

In the same file, find the `importSettings` function. The current `try` block is:
```ts
try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data.settings && typeof data.settings === 'object') {
      const merged = { ...DEFAULT_SETTINGS, ...data.settings };
      await saveSettings(merged);
      setSettings(merged);
    }
    if (Array.isArray(data.providers)) {
      await chrome.storage.local.set({ 'ir-providers': data.providers });
      setProviders(data.providers);
    }
  } catch {
    alert('Failed to import settings. Please check the file is valid JSON.');
  }
```

Replace it with:
```ts
try {
    const text = await file.text();
    const data = JSON.parse(text);

    const version = typeof data.version === 'number' ? data.version : 1;
    if (version > 1) {
      console.warn(
        `Recito: import file version ${version} is newer than supported (1). Importing best-effort.`,
      );
    }

    if (data.settings && typeof data.settings === 'object') {
      const merged = { ...DEFAULT_SETTINGS, ...data.settings };
      // Cross-tool alias: Obsidian writes `accentColor`; Chrome reads `themeColor`.
      if (
        typeof data.settings.accentColor === 'string' &&
        typeof data.settings.themeColor !== 'string'
      ) {
        merged.themeColor = data.settings.accentColor;
      }
      await saveSettings(merged);
      setSettings(merged);
    }
    if (Array.isArray(data.providers)) {
      await chrome.storage.local.set({ 'ir-providers': data.providers });
      setProviders(data.providers);
    }
  } catch {
    alert('Failed to import settings. Please check the file is valid JSON.');
  }
```

- [ ] **Step 3: Type-check the Chrome extension**

Run from the Chrome extension repo root:
```bash
cd /Users/yuhanli/allgemeiner-intellekt/immersive-reader && npm run typecheck
```
Expected: no errors.

- [ ] **Step 4: Run the Chrome extension test suite to confirm nothing else broke**

Still in the Chrome extension repo:
```bash
npm test
```
Expected: all existing tests pass.

- [ ] **Step 5: Manual end-to-end smoke test (cross-tool)**

1. In **Obsidian**, set a distinctive accent color (e.g. `#ff00ff`). Click Export. Save the file somewhere accessible.
2. In the **Chrome extension**, open Options → Settings → Backup. Click Import Settings, pick the file from step 1.
3. Verify in Chrome's Appearance section that the theme/accent color is now `#ff00ff` (the alias worked).
4. Click Export Settings in Chrome to get a fresh file.
5. Back in **Obsidian**, click Import in the Backup section, pick the Chrome-exported file. Confirm.
6. Verify the accent color is still `#ff00ff` and providers are intact.
7. Open Obsidian's `data.json` (under `.obsidian/plugins/Recito-in-Obsidian/data.json`) and confirm `_foreign` contains `theme` and `onboardingComplete` from the Chrome side.

- [ ] **Step 6: Commit (Chrome extension repo)**

```bash
cd /Users/yuhanli/allgemeiner-intellekt/immersive-reader
git add src/options/Options.tsx
git commit -m "feat(options): add version field and cross-tool accentColor alias to import/export"
```

---

## Self-review notes

- **Spec coverage:** Every spec section maps to a task. Format envelope → Task 4. `_foreign` field → Task 2. `buildExport` / `applyImport` → Tasks 3 & 4. Test list → Task 3. UI placement and confirm modal → Task 5. Chrome's `version` + alias → Task 6. Reading-progress exclusion → covered in `buildExport` and asserted in tests.
- **Type consistency:** `ExportEnvelope`, `ImportResult`, `buildExport`, `applyImport` use the same names in tests, implementation, and the settings tab caller. The `_foreign` field is declared once in `types.ts` and used consistently.
- **Placeholder scan:** No "TBD" / "implement later" / "similar to". All code blocks are complete.
