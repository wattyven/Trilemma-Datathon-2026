// JSON GET with an in-memory LRU cache, in-flight de-duplication and abort/timeout handling.
// Deliberately never sets `referrerPolicy`: the DataBC WFS only sends CORS headers when the
// browser includes a Referer (see docs/DATA_SOURCES.md §3).
import { REQUEST_TIMEOUT_MS } from '../config';

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string) {
    super(`HTTP ${status} from ${new URL(url).host}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export class TimeoutError extends Error {
  constructor(url: string) {
    super(`Timed out waiting for ${new URL(url).host}`);
    this.name = 'TimeoutError';
  }
}

export function abortError(): DOMException {
  return new DOMException('The request was aborted', 'AbortError');
}

export function isAbortError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError';
}

interface Inflight {
  promise: Promise<unknown>;
  controller: AbortController;
  waiters: number;
}

const MAX_CACHE_ENTRIES = 200;
const cache = new Map<string, unknown>();
const inflight = new Map<string, Inflight>();

function remember(url: string, value: unknown) {
  cache.set(url, value);
  if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
}

export function clearHttpCache() {
  cache.clear();
}

export interface GetOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}

/**
 * Callers sharing a URL share one network request. Aborting one caller only rejects that
 * caller; the request itself is cancelled once every waiting caller has aborted.
 */
export function getJson<T>(url: string, { signal, timeoutMs = REQUEST_TIMEOUT_MS }: GetOptions = {}): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (cache.has(url)) {
    const value = cache.get(url);
    cache.delete(url); // refresh LRU position
    cache.set(url, value);
    return Promise.resolve(value as T);
  }

  let entry = inflight.get(url);
  if (!entry) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const promise = fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new HttpError(res.status, url);
        return res.json() as Promise<unknown>;
      })
      .then((value) => {
        remember(url, value);
        return value;
      })
      .catch((e: unknown) => {
        throw timedOut ? new TimeoutError(url) : e;
      })
      .finally(() => {
        clearTimeout(timer);
        if (inflight.get(url) === entry) inflight.delete(url);
      });
    entry = { promise, controller, waiters: 0 };
    inflight.set(url, entry);
  }

  const shared = entry;
  shared.waiters++;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      shared.waiters--;
      if (shared.waiters === 0) {
        inflight.delete(url);
        shared.controller.abort();
      }
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    shared.promise.then(
      (value) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value as T);
      },
      (err: unknown) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
