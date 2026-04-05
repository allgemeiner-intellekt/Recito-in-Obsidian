import type { Voice } from '../lib/types';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  voices: Voice[];
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

export function getCachedVoices(configId: string): Voice[] | null {
  const entry = cache.get(configId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    cache.delete(configId);
    return null;
  }
  return entry.voices;
}

export function setCachedVoices(configId: string, voices: Voice[]): void {
  cache.set(configId, { voices, cachedAt: Date.now() });
}

export function invalidateVoiceCache(configId?: string): void {
  if (configId) {
    cache.delete(configId);
  } else {
    cache.clear();
  }
}
