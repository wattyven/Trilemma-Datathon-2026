import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRange } from '../src/elevation/rangeFetch';

const partial = (bytes: number, contentRange: string) => new Response(new Uint8Array(bytes), { status: 206, headers: { 'content-range': contentRange } });

describe('byte-range reads', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refetches, bypassing the cache, when a range comes back the wrong size', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push(init);
      return calls.length === 1 ? partial(3137, 'bytes 1000-4136/9000000') : partial(1000, 'bytes 1000-1999/9000000');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { data } = await fetchRange('https://x/a.tif', 1000, 1999);
    expect(data.byteLength).toBe(1000);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.cache).toBe('reload');
    expect((calls[0]!.headers as Record<string, string>).Range).toBe('bytes=1000-1999');
  });

  it('accepts a short body at the end of the file', async () => {
    const fetchMock = vi.fn(async () => partial(10, 'bytes 990-999/1000'));
    vi.stubGlobal('fetch', fetchMock);
    const { data } = await fetchRange('https://x/a.tif', 990, 1999);
    expect(data.byteLength).toBe(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
