import type { ProviderConfig } from '../lib/types';
import type { Voice } from '../lib/types';
import { ApiError } from '../lib/api-error';
import { getProvider } from './registry';
import { getCachedVoices, setCachedVoices } from './voice-cache';

export interface ConfigHealth {
  status: 'healthy' | 'cooldown' | 'failed';
  lastError?: { message: string; status: number; timestamp: number };
  cooldownUntil?: number;
  failCount: number;
}

const healthMap = new Map<string, ConfigHealth>();

// Cooldown durations in ms
const COOLDOWN_429 = 60_000;       // 1 minute for rate limits
const COOLDOWN_403 = 5 * 60_000;   // 5 minutes for quota
const COOLDOWN_5XX = 30_000;       // 30 seconds for server errors
const COOLDOWN_NETWORK = 30_000;   // 30 seconds for network errors

function getOrCreateHealth(configId: string): ConfigHealth {
  let health = healthMap.get(configId);
  if (!health) {
    health = { status: 'healthy', failCount: 0 };
    healthMap.set(configId, health);
  }
  // Auto-expire cooldowns
  if (health.status === 'cooldown' && health.cooldownUntil && Date.now() >= health.cooldownUntil) {
    health.status = 'healthy';
    health.cooldownUntil = undefined;
    health.failCount = 0;
  }
  return health;
}

export function getCooldownDuration(error: ApiError): number {
  if (error.retryAfterMs) return error.retryAfterMs;
  if (error.status === 429) return COOLDOWN_429;
  if (error.status === 403) return COOLDOWN_403;
  if (error.status >= 500) return COOLDOWN_5XX;
  if (error.status === 0) return COOLDOWN_NETWORK; // network error
  return COOLDOWN_5XX; // default
}

export function markFailed(configId: string, error: ApiError): void {
  const health = getOrCreateHealth(configId);
  health.failCount++;
  health.lastError = { message: error.message, status: error.status, timestamp: Date.now() };

  if (error.status === 401) {
    // Permanent failure — bad key
    health.status = 'failed';
  } else {
    // Transient — cooldown
    const duration = getCooldownDuration(error);
    health.status = 'cooldown';
    health.cooldownUntil = Date.now() + duration;
  }
}

export function isHealthy(configId: string): boolean {
  return getOrCreateHealth(configId).status === 'healthy';
}

export function getHealth(configId: string): ConfigHealth {
  return getOrCreateHealth(configId);
}

export function getAllHealth(): Record<string, ConfigHealth> {
  // Refresh all entries (auto-expire cooldowns)
  for (const key of healthMap.keys()) {
    getOrCreateHealth(key);
  }
  return Object.fromEntries(healthMap);
}

export function clearHealth(configId: string): void {
  healthMap.delete(configId);
}

export function resetAllHealth(): void {
  healthMap.clear();
}

export interface PlaybackSession {
  config: ProviderConfig;
  voice: Voice;
  providerId: string;
  generation: number;
}

/**
 * Find the next healthy candidate config that is compatible with the current session.
 * Returns null if no candidates are available.
 */
export async function getNextCandidate(
  session: PlaybackSession,
  failedConfigId: string,
  allConfigs: ProviderConfig[],
): Promise<ProviderConfig | null> {
  // Filter to same provider type (and same baseUrl for custom)
  const candidates = allConfigs.filter((c) => {
    if (c.id === failedConfigId) return false;
    if (c.providerId !== session.providerId) return false;
    // For custom providers, must share the same base URL
    if (c.providerId === 'custom') {
      const normalize = (url?: string) => (url || '').trim().replace(/\/+$/, '');
      if (normalize(c.baseUrl) !== normalize(session.config.baseUrl)) return false;
    }
    return true;
  });

  for (const candidate of candidates) {
    const health = getOrCreateHealth(candidate.id);
    if (health.status === 'failed' || (health.status === 'cooldown' && health.cooldownUntil && Date.now() < health.cooldownUntil)) {
      continue;
    }

    // For ElevenLabs, verify the target voice is available on this account
    if (candidate.providerId === 'elevenlabs') {
      let voices = getCachedVoices(candidate.id);
      if (!voices) {
        try {
          const provider = getProvider(candidate.providerId);
          voices = await provider.listVoices(candidate);
          setCachedVoices(candidate.id, voices);
        } catch {
          continue; // Can't list voices — skip this candidate
        }
      }
      if (!voices.some((v) => v.id === session.voice.id)) {
        continue; // Target voice not available on this account
      }
    }

    return candidate;
  }

  return null;
}
