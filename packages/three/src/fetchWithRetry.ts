/**
 * `fetch` that retries transient failures — network errors, HTTP 5xx and 429 —
 * with exponential backoff, and gives up at once when `init.signal` aborts.
 * Every other answer (including 404) is returned as it is.
 *
 * For tiles this keeps a request "in flight" across a transient error, so the
 * tile renderer keeps drawing the parent instead of treating the failed child as
 * ready and leaving a hole (#149).
 */
export async function fetchWithRetry(
  url: string, init: RequestInit = {}, { tries = 4, baseMs = 500, fetchImpl = fetch }: { tries?: number; baseMs?: number; fetchImpl?: typeof fetch } = {},
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
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, baseMs * 2 ** (attempt - 1));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
