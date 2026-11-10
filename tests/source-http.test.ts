import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceFetch } from '../src/main/source-http';
import { TingwuSourceAdapter } from '../src/main/source-adapters';

afterEach(() => vi.useRealTimers());

describe('source transport recovery', () => {
  it('stops the connection timer after headers so a large transcript can finish downloading', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    const primary = vi.fn(async (_input, options) => {
      requestSignal = options?.signal;
      return new Response('large transcript');
    });
    const response = await createSourceFetch(primary, vi.fn())('https://tingwu.aliyun.com/example');
    await vi.advanceTimersByTimeAsync(21000);
    expect(requestSignal?.aborted).toBe(false);
    await expect(response.text()).resolves.toBe('large transcript');
  });
  it('automatically tries a second transport after a connection failure, retaining the original request', async () => {
    const primary = vi.fn().mockRejectedValue(new TypeError('net::ERR_CONNECTION_RESET'));
    const response = new Response('available');
    const secondary = vi.fn().mockResolvedValue(response);
    const request = createSourceFetch(primary, secondary);
    const body = JSON.stringify({ action: 'getTransResult', transId: 'example' });
    await expect((await request('https://tingwu.aliyun.com/api/trans/getTransResult', { method: 'POST', body })).text()).resolves.toBe('available');
    expect(secondary).toHaveBeenCalledWith('https://tingwu.aliyun.com/api/trans/getTransResult',
      expect.objectContaining({ method: 'POST', body }));
  });

  it('returns permission denials without retrying through another transport', async () => {
    const response = new Response('permission deny', { status: 403 });
    const primary = vi.fn().mockResolvedValue(response);
    const secondary = vi.fn();
    const denied = await createSourceFetch(primary, secondary)('https://open.feishu.cn/open-apis/minutes/v1/minutes/example/transcript');
    expect(denied.status).toBe(403);
    expect(secondary).not.toHaveBeenCalled();
  });

  it('uses the second transport when the response body disconnects after successful headers', async () => {
    const interrupted = new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('fetch failed')); } }));
    const primary = vi.fn().mockResolvedValue(interrupted);
    const secondary = vi.fn().mockResolvedValue(new Response('full transcript'));
    const response = await createSourceFetch(primary, secondary)('https://tingwu.aliyun.com/example');
    await expect(response.text()).resolves.toBe('full transcript');
    expect(secondary).toHaveBeenCalledTimes(1);
  });

  it('retries a Tingwu response interrupted while reading its JSON body', async () => {
    vi.useFakeTimers();
    const payload = { code: '0', data: { result: JSON.stringify({ pg: [{ sc: [
      { bt: 1000, et: 3000, tc: '只用本场原话。' },
    ] }] }) } };
    const request = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => { throw new TypeError('terminated'); } })
      .mockResolvedValueOnce(new Response(JSON.stringify(payload)));
    const progress = vi.fn();
    const work = new TingwuSourceAdapter(async () => undefined, request)
      .readTranscript('https://tingwu.aliyun.com/doc/transcripts/example', progress);
    await vi.advanceTimersByTimeAsync(2100);
    await expect(work).resolves.toMatchObject([{ text: '只用本场原话。' }]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('2/3'));
  });
});
