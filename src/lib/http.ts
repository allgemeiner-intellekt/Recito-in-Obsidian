import { requestUrl } from 'obsidian';

/**
 * Thin fetch-shaped wrapper around Obsidian's `requestUrl`.
 *
 * Renderer-side `fetch` is subject to CORS, which breaks calls to providers
 * that don't whitelist `app://obsidian.md` (OpenAI, ElevenLabs, self-hosted
 * endpoints, etc.). `requestUrl` runs in Electron's main process and bypasses
 * CORS entirely. This wrapper exposes a small Response-like surface so the
 * provider modules can keep using `response.ok`, `response.status`,
 * `response.arrayBuffer()`, `response.text()`, etc.
 */

export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string> | HeadersInit;
  body?: string | ArrayBuffer;
  /** Ignored — kept for fetch compatibility (requestUrl doesn't support abort). */
  signal?: AbortSignal;
}

function normalizeHeaders(input?: HttpRequestInit['headers']): Record<string, string> {
  if (!input) return {};
  if (input instanceof Headers) {
    const out: Record<string, string> = {};
    input.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(input)) {
    return Object.fromEntries(input);
  }
  return { ...(input as Record<string, string>) };
}

export async function httpFetch(
  url: string,
  init: HttpRequestInit = {},
): Promise<HttpResponse> {
  const res = await requestUrl({
    url,
    method: init.method ?? 'GET',
    headers: normalizeHeaders(init.headers),
    body: init.body,
    throw: false,
  });

  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers ?? {})) {
    headers.set(key, String(value));
  }

  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    statusText: '',
    headers,
    arrayBuffer: async () => res.arrayBuffer,
    text: async () => res.text,
    json: async <T = unknown>() => res.json as T,
  };
}
