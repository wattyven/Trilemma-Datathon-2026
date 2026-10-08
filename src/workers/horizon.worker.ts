// Helper thread for big lots: computes horizons for one slice of the cells (spawned by
// shade.worker.ts). Same function as the single-threaded path, so results are identical.
import { computeHorizons, type HorizonParams } from '../engine/horizon';

export interface HorizonJob {
  dsm: Float32Array;
  width: number;
  height: number;
  px: Float32Array;
  py: Float32Array;
  z0: Float32Array;
  params: HorizonParams;
  zmax: number;
  chunk: number;
}

export type HorizonReply = { type: 'progress'; done: number } | { type: 'done'; horizons: Float32Array };

interface Scope {
  postMessage(message: HorizonReply, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<HorizonJob>) => void) | null;
}
const scope = self as unknown as Scope;

scope.onmessage = async (ev) => {
  const j = ev.data;
  const n = j.px.length;
  const out = new Float32Array(n * j.params.sectors);
  const input = { dsm: { width: j.width, height: j.height, data: j.dsm }, px: j.px, py: j.py, z0: j.z0, count: n };
  for (let start = 0; start < n; start += j.chunk) {
    const end = Math.min(n, start + j.chunk);
    computeHorizons(input, j.params, out, start, end, j.zmax);
    scope.postMessage({ type: 'progress', done: end });
    await new Promise((r) => setTimeout(r, 0));
  }
  scope.postMessage({ type: 'done', horizons: out }, [out.buffer]);
};
