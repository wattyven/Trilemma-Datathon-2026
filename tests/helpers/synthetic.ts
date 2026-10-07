// Synthetic DSMs and helpers for engine tests.
import type { Raster } from '../../src/engine/grid';
import { computeHorizons, type HorizonParams } from '../../src/engine/horizon';
import type { Horizons } from '../../src/engine/outputs';
import { HORIZON } from '../../src/config';

export const PARAMS: HorizonParams = { sectors: HORIZON.sectors, minStepM: HORIZON.minStepM, stepFrac: HORIZON.stepFrac };

export function flatRaster(width: number, height: number, z = 0): Raster {
  return { width, height, data: new Float32Array(width * height).fill(z) };
}

/** Raise pixels [c0, c1) × [r0, r1) to `top` metres (absolute). */
export function addBox(r: Raster, c0: number, r0: number, c1: number, r1: number, top: number) {
  for (let y = r0; y < r1; y++) for (let x = c0; x < c1; x++) r.data[y * r.width + x] = Math.max(r.data[y * r.width + x]!, top);
}

export interface TestCells {
  px: Float32Array;
  py: Float32Array;
  z0: Float32Array;
  count: number;
  col: Int32Array;
  row: Int32Array;
}

/** One cell per pixel centre in the region, observer at ground (DTM) + h. */
export function regionCells(ground: Raster, c0: number, r0: number, c1: number, r1: number, h = 0, skip?: (c: number, r: number) => boolean): TestCells {
  const px: number[] = [], py: number[] = [], z0: number[] = [], col: number[] = [], row: number[] = [];
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      if (skip?.(c, r)) continue;
      px.push(c + 0.5);
      py.push(r + 0.5);
      z0.push(ground.data[r * ground.width + c]! + h);
      col.push(c);
      row.push(r);
    }
  }
  return { px: Float32Array.from(px), py: Float32Array.from(py), z0: Float32Array.from(z0), count: px.length, col: Int32Array.from(col), row: Int32Array.from(row) };
}

export function horizonsFor(dsm: Raster, cells: TestCells, params: HorizonParams = PARAMS): Horizons {
  const data = new Float32Array(cells.count * params.sectors);
  computeHorizons({ dsm, px: cells.px, py: cells.py, z0: cells.z0, count: cells.count }, params, data);
  return { data, count: cells.count, sectors: params.sectors };
}

/** Deterministic PRNG so failures reproduce. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
