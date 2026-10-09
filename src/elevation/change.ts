// "Best of both": the 2016 point cloud's 0.5 m detail wherever nothing changed, and the newer 1 m
// LidarBC survey wherever something did. Pure array maths on a lot's 0.5 m grid and the 1 m grid
// that lines up with it (each 1 m cell is exactly 2 × 2 cells; see build.ts utmWindow).
import type { Region } from './resample';

export interface ChangeOptions {
  /** Height difference that counts as a change (m). */
  thresholdM: number;
  /** Changed areas smaller than this many 1 m cells are ignored. */
  minAreaCells: number;
  /** Changed areas grow by this many cells, so seams fall on unchanged ground. */
  growCells: number;
}

/** A 0.5 m surface on the 1 m grid: the highest of each 1 m cell's four cells (NaN where all four are). */
export function maxPool2(z05: Float32Array, w1: number, h1: number): Float32Array {
  const w05 = 2 * w1;
  const out = new Float32Array(w1 * h1).fill(NaN);
  for (let r = 0; r < h1; r++)
    for (let c = 0; c < w1; c++) {
      const k = 2 * r * w05 + 2 * c;
      let m = -Infinity;
      for (const v of [z05[k]!, z05[k + 1]!, z05[k + w05]!, z05[k + w05 + 1]!]) if (v > m) m = v;
      if (m > -Infinity) out[r * w1 + c] = m;
    }
  return out;
}

/** A 1 m grid on the 0.5 m grid, each value copied to its 2 × 2 cells (nearest: walls stay walls). */
export function upsampleNearest(z1: Float32Array, w1: number, h1: number): Float32Array {
  const w05 = 2 * w1;
  const out = new Float32Array(w05 * 2 * h1);
  for (let r = 0; r < 2 * h1; r++) for (let c = 0; c < w05; c++) out[r * w05 + c] = z1[(r >> 1) * w1 + (c >> 1)]!;
  return out;
}

/** Halve a 0.5 m region into the 1 m cells it fully contains. */
export function regionToCoarse(r: Region): Region {
  return { c0: Math.ceil(r.c0 / 2), r0: Math.ceil(r.r0 / 2), c1: Math.floor(r.c1 / 2), r1: Math.floor(r.r1 / 2) };
}

function morph(src: Uint8Array, w: number, h: number, region: Region, erode: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let r = region.r0; r < region.r1; r++)
    for (let c = region.c0; c < region.c1; c++) {
      let all = 1, any = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          const v = rr >= region.r0 && cc >= region.c0 && rr < region.r1 && cc < region.c1 ? src[rr * w + cc]! : 0;
          all &= v;
          any |= v;
        }
      out[r * w + c] = erode ? all : any;
    }
  return out;
}

/**
 * Where the newer survey differs from the older one, on the 1 m grid within `region`.
 * 1. A cell is changed when the new height is more than `thresholdM` above or below every older
 *    height in its 3 × 3 neighbourhood. The slack absorbs the surveys' small horizontal offset,
 *    which would otherwise flag every wall and roof edge.
 * 2. A 3 × 3 opening drops one-cell slivers; areas under `minAreaCells` are dropped.
 * 3. What's left grows by `growCells`, so the switch between surveys happens on unchanged ground.
 */
export function changeMask(old1: Float32Array, new1: Float32Array, w: number, h: number, region: Region, o: ChangeOptions): { mask: Uint8Array; areas: number } {
  const rg = { c0: Math.max(0, region.c0), r0: Math.max(0, region.r0), c1: Math.min(w, region.c1), r1: Math.min(h, region.r1) };
  const raw = new Uint8Array(w * h);
  for (let r = rg.r0; r < rg.r1; r++)
    for (let c = rg.c0; c < rg.c1; c++) {
      const k = r * w + c, z = new1[k]!;
      if (z !== z || old1[k] !== old1[k]) continue; // a survey has no data here: nothing to compare
      let lo = Infinity, hi = -Infinity;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
          const v = old1[rr * w + cc]!;
          if (v !== v) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      if (z > hi + o.thresholdM || z < lo - o.thresholdM) raw[k] = 1;
    }
  let mask = morph(morph(raw, w, h, rg, true), w, h, rg, false);

  // Keep connected areas (4-neighbour) of at least minAreaCells.
  const seen = new Uint8Array(w * h);
  let areas = 0;
  for (let k = 0; k < w * h; k++) {
    if (!mask[k] || seen[k]) continue;
    const cells: number[] = [k];
    seen[k] = 1;
    for (let i = 0; i < cells.length; i++) {
      const q = cells[i]!, qr = Math.floor(q / w), qc = q % w;
      for (const [rr, cc] of [[qr + 1, qc], [qr - 1, qc], [qr, qc + 1], [qr, qc - 1]] as const) {
        const j = rr * w + cc;
        if (rr >= 0 && cc >= 0 && rr < h && cc < w && mask[j] && !seen[j]) {
          seen[j] = 1;
          cells.push(j);
        }
      }
    }
    if (cells.length < o.minAreaCells) for (const q of cells) mask[q] = 0;
    else areas++;
  }
  for (let i = 0; i < o.growCells; i++) mask = morph(mask, w, h, rg, false);
  return { mask, areas };
}

export interface Composed {
  dsm: Float32Array;
  /** 1 where the surface came from the newer survey because something changed (0.5 m grid). */
  changed: Uint8Array;
  /** Share of the compared area (`region05`) that changed. */
  changedShare: number;
}

/**
 * The "best of both" surface on the 0.5 m grid:
 * - inside `region05` (where both surveys exist): the newer survey where the mask says it changed,
 *   otherwise the older one (the newer one where the older has a hole, then `base`);
 * - outside it: the newer survey, then `base`.
 * The newer 1 m survey is copied to 2 × 2 cells, not interpolated, so walls stay vertical.
 */
export function composeSurface(o: { w1: number; h1: number; region05: Region; old05: Float32Array; new1: Float32Array; mask1: Uint8Array; base05: Float32Array }): Composed {
  const w05 = 2 * o.w1, h05 = 2 * o.h1;
  const dsm = new Float32Array(w05 * h05);
  const changed = new Uint8Array(w05 * h05);
  const rg = o.region05;
  let inside = 0, swapped = 0;
  for (let r = 0; r < h05; r++)
    for (let c = 0; c < w05; c++) {
      const k = r * w05 + c, k1 = (r >> 1) * o.w1 + (c >> 1);
      const newer = o.new1[k1]!, older = o.old05[k]!, base = o.base05[k]!;
      if (r >= rg.r0 && r < rg.r1 && c >= rg.c0 && c < rg.c1) {
        inside++;
        if (o.mask1[k1] && newer === newer) {
          dsm[k] = newer;
          changed[k] = 1;
          swapped++;
        } else dsm[k] = older === older ? older : newer === newer ? newer : base;
      } else dsm[k] = newer === newer ? newer : base;
    }
  return { dsm, changed, changedShare: inside ? swapped / inside : 0 };
}
