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

  // Ensure activeProviderGroup still points at an existing pool. If it was
  // set to a non-null value but that group no longer exists in the imported
  // providers, fall back to the first provider and clear the voice id
  // (different pool, different voices). If activeProviderGroup is already
  // null, leave the voice id alone — it may be valid once a group is chosen.
  if (next.activeProviderGroup !== null) {
    const groupExists = next.providers.some(
      (p) => groupKeyOf(p) === next.activeProviderGroup,
    );
    if (!groupExists) {
      next.activeProviderGroup = next.providers[0] ? groupKeyOf(next.providers[0]) : null;
      next.activeVoiceId = null;
    }
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
