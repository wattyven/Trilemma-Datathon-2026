// Main-thread wrapper around the shade worker: promise per request, progress callbacks, and
// "newest load wins" (a new lot cancels the previous one's horizon precompute).
import { abortError } from '../data/http';
import type { ComputeRequest, ComputeResult, ErrorCode, FromWorker, LoadedMessage, LoadRequest, ToWorker } from './protocol';

export class EngineError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

export type Progress = { stage: 'elevation' | 'horizon'; done: number; total: number };

interface Pending {
  resolve: (msg: FromWorker) => void;
  reject: (e: unknown) => void;
  onProgress?: ((p: Progress) => void) | undefined;
}

export class ShadeEngine {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private currentLoad = 0;

  constructor() {
    // Vite rewrites this to a hashed asset under the Pages base path (docs/DEVELOPMENT.md, gotcha 7).
    this.worker = new Worker(new URL('../workers/shade.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.dispatch(ev.data);
    this.worker.onerror = (ev) => {
      for (const p of this.pending.values()) p.reject(new EngineError('internal', ev.message || 'Worker failed'));
      this.pending.clear();
    };
  }

  private dispatch(msg: FromWorker) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') {
      p.onProgress?.({ stage: msg.stage, done: msg.done, total: msg.total });
      return;
    }
    this.pending.delete(msg.id);
    if (msg.type === 'error') {
      p.reject(msg.code === 'cancelled' ? abortError() : new EngineError(msg.code, msg.message));
    } else {
      p.resolve(msg);
    }
  }

  private send(msg: ToWorker, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<FromWorker> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      this.pending.set(msg.id, { resolve, reject, onProgress });
      signal?.addEventListener(
        'abort',
        () => {
          if (this.pending.delete(msg.id)) reject(abortError());
        },
        { once: true },
      );
      this.worker.postMessage(msg);
    });
  }

  /** Open the elevation files early (no reply); `load` reuses them. */
  prefetch(...urls: string[]) {
    this.worker.postMessage({ type: 'prefetch', id: 0, urls } satisfies ToWorker);
  }

  /** Fetch elevation and precompute horizons. Supersedes any load still in progress. */
  async load(request: LoadRequest, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<LoadedMessage> {
    const id = ++this.seq;
    const previous = this.currentLoad;
    this.currentLoad = id;
    const old = this.pending.get(previous);
    if (old) {
      this.pending.delete(previous);
      old.reject(abortError());
    }
    return (await this.send({ type: 'load', id, request }, onProgress, signal)) as LoadedMessage;
  }

  async compute(request: ComputeRequest, signal?: AbortSignal): Promise<{ result: ComputeResult; ms: number }> {
    const id = ++this.seq;
    const msg = await this.send({ type: 'compute', id, request }, undefined, signal);
    if (msg.type !== 'result') throw new EngineError('internal', 'Unexpected worker reply');
    return { result: msg.result, ms: msg.ms };
  }
}
