import type { TTSProvider, ProviderConfig, Voice, SynthesisResult, SynthesisOptions } from '../lib/types';
import { hasLikelyValidApiKeyFormat } from './api-key-format';
import { ApiError } from '../lib/api-error';
import { httpFetch, type HttpResponse } from '../lib/http';

const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';
const DEFAULT_MODEL = 'mimo-v2-tts';

const MIMO_VOICES: Voice[] = [
  { id: 'mimo_default', name: 'Mimo Default' },
  { id: 'default_zh', name: 'Chinese Female', language: 'zh' },
  { id: 'default_en', name: 'English Female', language: 'en' },
];

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'api-key': apiKey.trim(),
    'Content-Type': 'application/json',
  };
}

function buildRequestBody(text: string, voiceId: string): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    modalities: ['text', 'audio'],
    audio: { voice: voiceId, format: 'mp3' },
    thinking: { type: 'disabled' },
    messages: [
      { role: 'user', content: 'Read the following text aloud.' },
      { role: 'assistant', content: text },
    ],
  };
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export const mimoProvider: TTSProvider = {
  id: 'mimo',
  name: 'Xiaomi Mimo',

  async listVoices(_config: ProviderConfig): Promise<Voice[]> {
    return MIMO_VOICES;
  },

  async synthesize(
    text: string,
    voice: Voice,
    config: ProviderConfig,
    _options?: SynthesisOptions,
  ): Promise<SynthesisResult> {
    const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    const body = buildRequestBody(text, voice.id);

    let response: HttpResponse;
    try {
      response = await httpFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: buildHeaders(config.apiKey),
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw ApiError.fromNetworkError(err, 'mimo');
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      if (response.status === 401) {
        throw new ApiError('Invalid API key. Please check your Mimo API key.', 401, 'mimo', false);
      }
      if (response.status === 429) {
        throw new ApiError('Rate limit exceeded. Please try again later.', 429, 'mimo', true);
      }
      throw ApiError.fromResponse(response.status, errBody || response.statusText, 'mimo', response.headers);
    }

    let json: Record<string, unknown>;
    try {
      json = await response.json<Record<string, unknown>>();
    } catch {
      throw new ApiError('Failed to parse Mimo response as JSON.', 0, 'mimo', true);
    }

    // Extract base64 audio from choices[0].message.audio.data
    const choices = json.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const audio = message?.audio as Record<string, unknown> | undefined;
    const audioBase64 = audio?.data as string | undefined;

    if (!audioBase64) {
      throw new ApiError(
        'Mimo response missing audio data at choices[0].message.audio.data.',
        0,
        'mimo',
        true,
      );
    }

    const audioData = base64ToArrayBuffer(audioBase64);
    return { audioData, format: 'mp3' };
  },

  async validateKey(config: ProviderConfig): Promise<boolean> {
    if (!hasLikelyValidApiKeyFormat(config)) {
      return false;
    }

    const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    const body = buildRequestBody('test', MIMO_VOICES[0]!.id);

    try {
      const response = await httpFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: buildHeaders(config.apiKey),
        body: JSON.stringify(body),
      });
      return response.ok;
    } catch {
      return false;
    }
  },
};
