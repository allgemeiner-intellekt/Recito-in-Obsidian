import type { TTSProvider, ProviderConfig, Voice, SynthesisResult, SynthesisOptions } from '../lib/types';
import { buildOpenAICompatibleUrl, validateOpenAICompatibleSpeech } from './openai-compatible';
import { ApiError } from '../lib/api-error';
import { httpFetch, type HttpResponse } from '../lib/http';

export const customProvider: TTSProvider = {
  id: 'custom',
  name: 'Custom (OpenAI-compatible)',

  async listVoices(config: ProviderConfig): Promise<Voice[]> {
    if (!config.baseUrl) return [];
    try {
      const response = await httpFetch(buildOpenAICompatibleUrl(config.baseUrl, '/audio/voices'), {
        headers: { 'Authorization': `Bearer ${config.apiKey}` },
      });
      if (!response.ok) return [];
      const data = await response.json<{ voices?: { id: string; name?: string }[] }>();
      return (data.voices ?? []).map((v: { id: string; name?: string }) => ({
        id: v.id,
        name: v.name ?? v.id,
      }));
    } catch {
      return [];
    }
  },

  async synthesize(
    text: string,
    voice: Voice,
    config: ProviderConfig,
    options?: SynthesisOptions,
  ): Promise<SynthesisResult> {
    if (!config.baseUrl) {
      throw new Error('Custom provider requires a baseUrl.');
    }

    const speed = options?.speed ?? 1.0;
    const format = options?.format ?? 'mp3';

    let response: HttpResponse;
    try {
      response = await httpFetch(buildOpenAICompatibleUrl(config.baseUrl, '/audio/speech'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: (config.extraParams?.model as string) ?? 'tts-1',
          input: text,
          voice: voice.id,
          response_format: format,
          speed,
        }),
      });
    } catch (err) {
      throw ApiError.fromNetworkError(err, 'custom');
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      if (response.status === 401) {
        throw new ApiError('Invalid API key. Please check your API key.', 401, 'custom', false);
      }
      if (response.status === 429) {
        throw new ApiError('Rate limit exceeded. Please try again later.', 429, 'custom', true);
      }
      throw ApiError.fromResponse(response.status, errBody || response.statusText, 'custom', response.headers);
    }

    const audioData = await response.arrayBuffer();
    return { audioData, format };
  },

  async validateKey(config: ProviderConfig): Promise<boolean> {
    if (!config.baseUrl) return false;
    const voices = await this.listVoices(config);
    const voiceId = voices[0]?.id ?? 'alloy';
    const model = (config.extraParams?.model as string) ?? 'tts-1';

    return validateOpenAICompatibleSpeech(
      config.baseUrl,
      {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      {
        model,
        input: 'test',
        voice: voiceId,
        response_format: 'mp3',
      },
    );
  },
};
