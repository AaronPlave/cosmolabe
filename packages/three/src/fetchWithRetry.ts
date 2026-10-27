/**
 * `fetch` that retries transient failures — network errors, HTTP 5xx and 429 —
 * with exponential backoff capped at `maxDelayMs`, up to `tries` attempts
 * (Infinity: until it succeeds), and gives up at once when `init.signal` aborts.
 * Every other answer (including 404) is returned as it is.
 *
 * For tiles this keeps a request "in flight" across a transient error, so the
 * tile renderer keeps drawing the parent instead of treating the failed child as
 * ready and leaving a hole (#149).
 */
export async function fetchWithRetry(
  url: string, init: RequestInit = {},
  { tries = 4, baseMs = 500, maxDelayMs = 30_000, fetchImpl = fetch }: { tries?: number; baseMs?: number; maxDelayMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetchImpl(url, init);
      if (attempt >= tries || (response.status < 500 && response.status !== 429)) return response;
    } catch (error) {
      if (init.signal?.aborted || attempt >= tries) throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const signal = init.signal;
      const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.min(maxDelayMs, baseMs * 2 ** (attempt - 1)));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** Complete a successful response body within the caller's fetch retry boundary.
 * The viewer uses this adapter for small CPU grids and their manifest. It keeps
 * body-transfer failures retryable without changing grid decoding or sampling.
 */
export async function fetchCompleteResponse(
  input: RequestInfo | URL, init?: RequestInit, fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const response = await fetchImpl(input, init);
  if (!response.ok || !response.body) return response;
  const body = await response.arrayBuffer();
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
