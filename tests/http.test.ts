import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, TimeoutError, clearHttpCache, getJson, isAbortError } from '../src/data/http';

const fetchMock = vi.fn();
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** A fetch that only settles when we say so, and rejects like the real one when aborted. */
function deferredFetch() {
  let release!: (r: Response) => void;
  let signal: AbortSignal | undefined;
  fetchMock.mockImplementation(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        signal = init?.signal ?? undefined;
        release = resolve;
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  );
  return { release: (r: Response) => release(r), signal: () => signal };
}

beforeEach(() => {
  clearHttpCache();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('getJson', () => {
  it('caches responses in memory', async () => {
    fetchMock.mockResolvedValue(ok({ a: 1 }));
    expect(await getJson('https://x.test/a')).toEqual({ a: 1 });
    expect(await getJson('https://x.test/a')).toEqual({ a: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one request between concurrent callers', async () => {
    const d = deferredFetch();
    const p1 = getJson('https://x.test/b');
    const p2 = getJson('https://x.test/b');
    d.release(ok({ b: 2 }));
    expect(await Promise.all([p1, p2])).toEqual([{ b: 2 }, { b: 2 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborting one caller leaves the shared request running for the other', async () => {
    const d = deferredFetch();
    const c1 = new AbortController();
    const p1 = getJson('https://x.test/c', { signal: c1.signal });
    const p2 = getJson('https://x.test/c');
    c1.abort();
    await expect(p1).rejects.toSatisfy(isAbortError);
    expect(d.signal()?.aborted).toBe(false);
    d.release(ok({ c: 3 }));
    expect(await p2).toEqual({ c: 3 });
  });

  it('cancels the request when its only caller aborts', async () => {
    const d = deferredFetch();
    const c = new AbortController();
    const p = getJson('https://x.test/d', { signal: c.signal });
    c.abort();
    await expect(p).rejects.toSatisfy(isAbortError);
    expect(d.signal()?.aborted).toBe(true);
  });

  it('rejects immediately with an already-aborted signal', async () => {
    const c = new AbortController();
    c.abort();
    await expect(getJson('https://x.test/e', { signal: c.signal })).rejects.toSatisfy(isAbortError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns HTTP errors into HttpError and does not cache them', async () => {
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 })).mockResolvedValueOnce(ok({ f: 1 }));
    await expect(getJson('https://x.test/f')).rejects.toBeInstanceOf(HttpError);
    expect(await getJson('https://x.test/f')).toEqual({ f: 1 });
  });

  it('times out', async () => {
    deferredFetch();
    await expect(getJson('https://x.test/g', { timeoutMs: 20 })).rejects.toBeInstanceOf(TimeoutError);
  });

  it('passes network TypeErrors through untouched (the WFS JSONP fallback relies on this)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(getJson('https://x.test/h')).rejects.toBeInstanceOf(TypeError);
  });
});
