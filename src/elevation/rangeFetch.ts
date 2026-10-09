// Byte-range reads that survive a browser cache bug: Chrome's HTTP cache occasionally answers a
// re-read range with the wrong number of bytes (seen when a lot's refinement re-reads HRDEM tiles
// the first result already fetched: 3,137 bytes for a 1.1 MB range). A wrong-sized body is fetched
// again, bypassing the cache.

export interface RangeResult {
  response: Response;
  data: ArrayBuffer;
}

/** GET bytes [start, end] (inclusive) of `url`. */
export async function fetchRange(url: string, start: number, end: number, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<RangeResult> {
  const headers = { ...init.headers, Range: `bytes=${start}-${end}` };
  let response = await fetch(url, { headers, signal: init.signal });
  let data = await response.arrayBuffer();
  if (response.status === 206 && data.byteLength !== end - start + 1 && !atEnd(response, start + data.byteLength)) {
    console.warn(`VanShade: ${data.byteLength} bytes for a ${end - start + 1}-byte range of ${url}; fetching it again`);
    response = await fetch(url, { headers, signal: init.signal, cache: 'reload' });
    data = await response.arrayBuffer();
  }
  return { response, data };
}

/** A short body is fine at the end of the file (when the server says how big the file is). */
function atEnd(response: Response, end: number): boolean {
  const total = Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]);
  return Number.isFinite(total) && end >= total;
}
