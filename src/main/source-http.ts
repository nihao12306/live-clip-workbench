export type SourceFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function sourceNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = error.cause as { code?: string } | undefined;
  return /fetch failed|terminated|network|socket|ECONN|ETIMEDOUT|UND_ERR|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_PROXY|ERR_TUNNEL|ERR_FAILED|ERR_INTERNET_DISCONNECTED|ERR_TIMED_OUT|timeout|timed out/i
    .test(error.message + ' ' + (cause?.code ?? ''));
}

/** Use Chromium's system networking first, with a second transport for connection failures. */
export function createSourceFetch(browserFetch: SourceFetch, nodeFetch: SourceFetch): SourceFetch {
  return async (input, init = {}) => {
    const attempt = async (request: SourceFetch) => {
      const connecting = new AbortController();
      const idleTimeout = () => connecting.abort(new DOMException('Source connection timed out', 'TimeoutError'));
      let timer = setTimeout(idleTimeout, 20_000);
      const signal = init.signal ? AbortSignal.any([init.signal, connecting.signal]) : connecting.signal;
      try {
        const response = await request(input, { ...init, signal });
        // Transcript requests are small enough to buffer. Keep body failures
        // inside the transport recovery block, rather than returning early at headers.
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        if (reader) {
          while (true) {
            clearTimeout(timer);
            timer = setTimeout(idleTimeout, 20_000);
            const next = await reader.read();
            if (next.done) break;
            chunks.push(next.value);
            length += next.value.length;
          }
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
          status: response.status, statusText: response.statusText, headers: response.headers,
        });
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      return await attempt(browserFetch);
    } catch (error) {
      if (init.signal?.aborted || !sourceNetworkError(error)) throw error;
      return attempt(nodeFetch);
    }
  };
}
