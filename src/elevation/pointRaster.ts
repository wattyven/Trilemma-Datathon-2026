// Pure helpers for turning LiDAR points into a surface model (DSM) grid: highest non-noise return
// per cell, small-hole filling, and a vertical datum check against a reference ground model.
import type { Region } from './resample';

/** ASPRS classes we drop: 7 low noise, 18 high noise. Everything else is part of the surface. */
export const NOISE_CLASSES = new Set([7, 18]);
export const GROUND_CLASS = 2;

export interface PointGrid {
  width: number;
  height: number;
  /** Highest return per cell (NaN = no points). */
  zmax: Float32Array;
  points: number;
}

export function createPointGrid(width: number, height: number): PointGrid {
  return { width, height, zmax: new Float32Array(width * height).fill(NaN), points: 0 };
}

/** Add one point at continuous pixel coordinates (px, py); ignores points outside the region. */
export function addPoint(g: PointGrid, region: Region, px: number, py: number, z: number) {
  const c = Math.floor(px), r = Math.floor(py);
  if (c < region.c0 || r < region.r0 || c >= region.c1 || r >= region.r1) return;
  const k = r * g.width + c;
  const cur = g.zmax[k]!;
  if (!(cur >= z)) g.zmax[k] = z; // also true when cur is NaN
  g.points++;
}

/**
 * Fill empty cells inside the region from the mean of filled 8-neighbours, a few passes deep
 * (point spacing leaves scattered gaps at 0.5 m). Cells still empty stay NaN for the caller.
 */
export function fillHoles(g: PointGrid, region: Region, passes = 2): number {
  let filled = 0;
  for (let pass = 0; pass < passes; pass++) {
    const src = g.zmax.slice();
    for (let r = region.r0; r < region.r1; r++) {
      for (let c = region.c0; c < region.c1; c++) {
        const k = r * g.width + c;
        if (src[k] === src[k]) continue;
        let sum = 0, n = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= g.height || cc >= g.width || (dr === 0 && dc === 0)) continue;
            const v = src[rr * g.width + cc]!;
            if (v === v) {
              sum += v;
              n++;
            }
          }
        }
        if (n >= 3) {
          g.zmax[k] = sum / n;
          filled++;
        }
      }
    }
  }
  return filled;
}

/** Median of a sample (NaNs ignored); null when empty. */
export function median(values: number[]): number | null {
  const v = values.filter((x) => x === x).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

/** Keeps at most `size` items with equal probability (reservoir sampling), deterministic seed. */
export class Reservoir<T> {
  private seen = 0;
  private seed = 0x9e3779b9;
  readonly items: T[] = [];
  constructor(private size: number) {}
  add(item: T) {
    this.seen++;
    if (this.items.length < this.size) {
      this.items.push(item);
      return;
    }
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    const j = this.seed % this.seen;
    if (j < this.size) this.items[j] = item;
  }
}
