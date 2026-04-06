import type { ProviderConfig } from './types';

/**
 * The "group key" identifies an API key pool.
 *
 * - Built-in providers (openai, elevenlabs, groq, mimo): one pool per provider type.
 *   Group key is the providerId.
 * - Custom providers: one pool per baseUrl, since two custom keys hitting different
 *   endpoints aren't interchangeable. Group key is `custom@<normalizedBaseUrl>`.
 *
 * The group key is what `RecitoSettings.activeProviderGroup` stores.
 */

export function normalizeBaseUrl(url?: string | null): string {
  return (url || '').trim().replace(/\/+$/, '');
}

export function getGroupKey(config: ProviderConfig): string {
  if (config.providerId === 'custom') {
    return `custom@${normalizeBaseUrl(config.baseUrl)}`;
  }
  return config.providerId;
}

export function isCustomGroupKey(groupKey: string): boolean {
  return groupKey.startsWith('custom@');
}

export function getCustomBaseUrlFromGroupKey(groupKey: string): string {
  return groupKey.startsWith('custom@') ? groupKey.slice('custom@'.length) : '';
}

/** Configs that share the same pool as `groupKey`, ignoring disabled state. */
export function configsInGroup(
  configs: ProviderConfig[],
  groupKey: string,
): ProviderConfig[] {
  return configs.filter((c) => getGroupKey(c) === groupKey);
}
