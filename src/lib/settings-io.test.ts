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
