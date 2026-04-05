import type { ProviderConfig } from '../lib/types';

function hasPrefixAndLength(apiKey: string, prefix: string, minLength: number): boolean {
  const trimmed = apiKey.trim();
  return trimmed.startsWith(prefix) && trimmed.length >= minLength;
}

export function hasLikelyValidApiKeyFormat(config: ProviderConfig): boolean {
  const apiKey = config.apiKey.trim();
  if (!apiKey) {
    return false;
  }

  switch (config.providerId) {
    case 'openai':
      return hasPrefixAndLength(apiKey, 'sk-', 20);
    case 'groq':
      return hasPrefixAndLength(apiKey, 'gsk_', 20);
    case 'elevenlabs':
    case 'mimo':
      return apiKey.length >= 16;
    case 'custom':
      return apiKey.length >= 3;
    default:
      return apiKey.length >= 8;
  }
}
