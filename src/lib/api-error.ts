export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly providerId: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static fromResponse(status: number, body: string, providerId: string, headers?: Headers): ApiError {
    const retryable = status === 429 || status === 403 || status >= 500;
    let retryAfterMs: number | undefined;
    if (headers) {
      const ra = headers.get('retry-after');
      if (ra) {
        const seconds = parseInt(ra, 10);
        if (!isNaN(seconds)) {
          retryAfterMs = seconds * 1000;
        } else {
          const date = Date.parse(ra);
          if (!isNaN(date)) retryAfterMs = Math.max(0, date - Date.now());
        }
      }
    }
    return new ApiError(body || `HTTP ${status}`, status, providerId, retryable, retryAfterMs);
  }

  static fromNetworkError(err: unknown, providerId: string): ApiError {
    const message = err instanceof Error ? err.message : String(err);
    return new ApiError(`Network error: ${message}`, 0, providerId, true);
  }
}
