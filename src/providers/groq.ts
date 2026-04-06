import type { TTSProvider, ProviderConfig, Voice, SynthesisResult, SynthesisOptions } from '../lib/types';
import { buildOpenAICompatibleUrl, validateOpenAICompatibleSpeech } from './openai-compatible';
import { hasLikelyValidApiKeyFormat } from './api-key-format';
import { ApiError } from '../lib/api-error';
import { httpFetch, type HttpResponse } from '../lib/http';

const DEFAULT_BASE_URL = 'https://api.groq.com/openai';

const GROQ_VOICES: Voice[] = [
  { id: 'autumn', name: 'Autumn', language: 'en' },
  { id: 'diana', name: 'Diana', language: 'en' },
  { id: 'hannah', name: 'Hannah', language: 'en' },
  { id: 'austin', name: 'Austin', language: 'en' },
  { id: 'daniel', name: 'Daniel', language: 'en' },
  { id: 'troy', name: 'Troy', language: 'en' },
  { id: 'fahad', name: 'Fahad', language: 'ar-SA' },
  { id: 'sultan', name: 'Sultan', language: 'ar-SA' },
  { id: 'lulwa', name: 'Lulwa', language: 'ar-SA' },
  { id: 'noura', name: 'Noura', language: 'ar-SA' },
];

const DEFAULT_MODEL = 'canopylabs/orpheus-v1-english';

export const groqProvider: TTSProvider = {
  id: 'groq',
  name: 'Groq',

  async listVoices(_config: ProviderConfig): Promise<Voice[]> {
    return GROQ_VOICES;
  },

  async synthesize(
    text: string,
    voice: Voice,
    config: ProviderConfig,
    options?: SynthesisOptions,
  ): Promise<SynthesisResult> {
    const baseUrl = config.baseUrl || DEFAULT_BASE_URL;

    // Pick model based on voice language
    const isArabic = voice.language === 'ar-SA';
    const defaultModel = isArabic ? 'canopylabs/orpheus-arabic-saudi' : DEFAULT_MODEL;
    const model = (config.extraParams?.model as string) ?? defaultModel;

    const body: Record<string, unknown> = {
      model,
      input: text,
      voice: voice.id,
      response_format: 'wav',
    };

    if (options?.speed && options.speed !== 1.0) {
      body.speed = options.speed;
    }

    let response: HttpResponse;
    try {
      response = await httpFetch(buildOpenAICompatibleUrl(baseUrl, '/audio/speech'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw ApiError.fromNetworkError(err, 'groq');
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      if (response.status === 401) {
        throw new ApiError('Invalid API key. Please check your Groq API key.', 401, 'groq', false);
      }
      if (response.status === 429) {
        throw new ApiError('Rate limit exceeded. Please try again later.', 429, 'groq', true);
      }
      throw ApiError.fromResponse(response.status, errBody || response.statusText, 'groq', response.headers);
    }

    const audioData = await response.arrayBuffer();
    return { audioData, format: 'wav' };
  },

  async validateKey(config: ProviderConfig): Promise<boolean> {
    if (!hasLikelyValidApiKeyFormat(config)) {
      return false;
    }
    const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    return validateOpenAICompatibleSpeech(
      baseUrl,
      {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      {
        model: DEFAULT_MODEL,
        input: '.',
        voice: GROQ_VOICES[0]?.id ?? 'autumn',
        response_format: 'wav',
      },
    );
  },
};
