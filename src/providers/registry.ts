import type { TTSProvider } from '../lib/types';
import { openaiProvider } from './openai';
import { elevenlabsProvider } from './elevenlabs';
import { groqProvider } from './groq';
import { customProvider } from './custom';
import { mimoProvider } from './mimo';

export interface ProviderMeta {
  id: string;
  name: string;
  description: string;
  website: string;
}

const providerMap: Record<string, TTSProvider> = {
  openai: openaiProvider,
  elevenlabs: elevenlabsProvider,
  groq: groqProvider,
  mimo: mimoProvider,
  custom: customProvider,
};

export function getProvider(providerId: string): TTSProvider {
  const provider = providerMap[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  return provider;
}

export interface ChunkLimits {
  minWords: number;
  maxWords: number;
  splitThreshold: number;
}

export function getChunkLimits(providerId: string): ChunkLimits {
  switch (providerId) {
    case 'groq':
      return { minWords: 15, maxWords: 25, splitThreshold: 50 };
    default:
      // Cloud providers benefit from larger chunks (better prosody, fewer API calls)
      return { minWords: 30, maxWords: 50, splitThreshold: 80 };
  }
}

export const PROVIDER_LIST: ProviderMeta[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'High-quality TTS with 6 built-in voices',
    website: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    description: 'Premium voice cloning and synthesis',
    website: 'https://elevenlabs.io/app/settings/api-keys',
  },
  {
    id: 'groq',
    name: 'Groq',
    description: 'Ultra-fast inference with PlayAI voices',
    website: 'https://console.groq.com/keys',
  },
  {
    id: 'mimo',
    name: 'Xiaomi Mimo',
    description: 'Multilingual TTS with emotion and dialect support',
    website: 'https://platform.xiaomimimo.com',
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    description: 'Any OpenAI-compatible TTS endpoint',
    website: '',
  },
];
