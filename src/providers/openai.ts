import type { TTSProvider, ProviderConfig, Voice, SynthesisResult, SynthesisOptions } from '../lib/types';
import { buildOpenAICompatibleUrl, validateOpenAICompatibleKey } from './openai-compatible';
import { hasLikelyValidApiKeyFormat } from './api-key-format';
import { ApiError } from '../lib/api-error';
import { httpFetch, type HttpResponse } from '../lib/http';

const DEFAULT_BASE_URL = 'https://api.openai.com';

const OPENAI_VOICES: Voice[] = [
  { id: 'alloy', name: 'Alloy' },
  { id: 'echo', name: 'Echo' },
  { id: 'fable', name: 'Fable' },
  { id: 'onyx', name: 'Onyx' },
  { id: 'nova', name: 'Nova' },
  { id: 'shimmer', name: 'Shimmer' },
];

export const openaiProvider: TTSProvider = {
  id: 'openai',
  name: 'OpenAI',

  async listVoices(_config: ProviderConfig): Promise<Voice[]> {
    return OPENAI_VOICES;
  },

  async synthesize(
    text: string,
    voice: Voice,
    config: ProviderConfig,
    options?: SynthesisOptions,
  ): Promise<SynthesisResult> {
    const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    const speed = options?.speed ?? 1.0;
    const format = options?.format ?? 'mp3';

    let response: HttpResponse;
    try {
      response = await httpFetch(buildOpenAICompatibleUrl(baseUrl, '/audio/speech'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: text,
          voice: voice.id,
          response_format: format,
          speed,
        }),
      });
    } catch (err) {
      throw ApiError.fromNetworkError(err, 'openai');
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      if (response.status === 401) {
        throw new ApiError('Invalid API key. Please check your OpenAI API key.', 401, 'openai', false);
      }
      if (response.status === 429) {
        throw new ApiError('Rate limit exceeded. Please try again later.', 429, 'openai', true);
      }
      throw ApiError.fromResponse(response.status, errBody || response.statusText, 'openai', response.headers);
    }

    const audioData = await response.arrayBuffer();
    return { audioData, format };
  },

  async validateKey(config: ProviderConfig): Promise<boolean> {
    if (!hasLikelyValidApiKeyFormat(config)) {
      return false;
    }
    const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    return validateOpenAICompatibleKey(baseUrl, {
      'Authorization': `Bearer ${config.apiKey}`,
    });
  },
};
