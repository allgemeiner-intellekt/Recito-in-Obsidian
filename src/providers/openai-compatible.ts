export function buildOpenAICompatibleUrl(baseUrl: string, path: string): string {
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  const baseWithVersion = /\/v1$/i.test(trimmedBaseUrl) ? trimmedBaseUrl : `${trimmedBaseUrl}/v1`;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  return `${baseWithVersion}${normalizedPath}`;
}

export async function validateOpenAICompatibleKey(
  baseUrl: string,
  headers: HeadersInit,
): Promise<boolean> {
  return validateOpenAICompatibleSpeech(baseUrl, headers, {
    model: 'tts-1',
    input: '.',
    voice: 'alloy',
    response_format: 'mp3',
  });
}

export async function validateOpenAICompatibleSpeech(
  baseUrl: string,
  headers: HeadersInit,
  body: Record<string, unknown>,
): Promise<boolean> {
  try {
    const response = await fetch(buildOpenAICompatibleUrl(baseUrl, '/audio/speech'), {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return false;
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType && !contentType.startsWith('audio/') && !contentType.startsWith('application/octet-stream')) {
      return false;
    }

    const audioData = await response.arrayBuffer().catch(() => null);
    return audioData instanceof ArrayBuffer && audioData.byteLength > 0;
  } catch {
    return false;
  }
}
