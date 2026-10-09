// The lot's sunniest and shadiest patches, and a cell inside each for a pin. Pure: per-cell values
// and the cell grid in, two patches out. The headline (lotSummary.ts) and the pins on the view both
// use them, so they always point at the same places.

export type SpotMode = 'season' | 'day' | 'shade';

export interface Spot {
  /** Where the pin goes: the patch cell farthest from the patch's edge. */
  cell: number;
  /** That cell's value: hours (day, season) or % of the time shaded (shade). */
  value: number;
  areaM2: number;
  /** Every cell in the patch. */
  cells: number[];
}

export interface Spots {
  sunniest: Spot | null;
  shadiest: Spot | null;
}

export interface SpotsInput {
  mode: SpotMode;
  /** Hours (day, season) or % of the time shaded (shade) per cell; NaN = no data. */
  values: ArrayLike<number>;
  /** 1 = under a roof or tree, left out (pass zeros to count every surface). */
  covered: ArrayLike<number>;
  /** Cell centres in window pixels, on a lattice `step` pixels apart. */
  px: ArrayLike<number>;
  py: ArrayLike<number>;
  step: number;
  cellAreaM2: number;
  /**
   * The single most and least sunny spots instead of broad patches: cells within a hair (TIGHT) of
   * the lot's maximum and minimum, then the largest group of those and its deepest cell.
   */
  tight?: boolean;
  /**
   * With `tight`: compare blocks of this many cells a side (about 2 m × 2 m, a small garden bed),
   * valued at their mean, instead of single cells. Falls back to cells where no block fits.
   */
  blockCells?: number;
}

/** Below this difference between the sunniest and shadiest ground (95th and 5th percentiles), sun counts as even: no spots. */
export const EVEN_BELOW: Record<SpotMode, number> = { season: 1, day: 1, shade: 10 };
/** The widest a band can be: values this close to the top (or bottom) count as sunniest (or shadiest). */
const BAND: Record<SpotMode, number> = { season: 0.5, day: 0.5, shade: 5 };
/** With `tight`, values this close to the maximum (or minimum) count as ties. */
const TIGHT: Record<SpotMode, number> = { season: 0.05, day: 0.05, shade: 0.5 };

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

export function findSpots(input: SpotsInput): Spots {
  const { mode, values, covered, px, py, step, cellAreaM2 } = input;
  const none: Spots = { sunniest: null, shadiest: null };
  const open: number[] = [];
  for (let i = 0; i < values.length; i++) if (!covered[i] && values[i] === values[i]) open.push(i);
  if (!open.length) return none;

  // The cell lattice: cells sit `step` pixels apart, some missing (outside the lot or without data).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of open) {
    minX = Math.min(minX, px[i]!);
    minY = Math.min(minY, py[i]!);
    maxX = Math.max(maxX, px[i]!);
    maxY = Math.max(maxY, py[i]!);
  }
  const w = Math.round((maxX - minX) / step) + 1, h = Math.round((maxY - minY) / step) + 1;
  const key = (i: number) => Math.round((py[i]! - minY) / step) * w + Math.round((px[i]! - minX) / step);

  // Blocks of open ground k cells a side, each known by its north-west cell and valued at its mean.
  const k = input.tight ? Math.max(1, Math.round(input.blockCells ?? 1)) : 1;
  const blocks = new Map<number, number[]>();
  if (k > 1) {
    const openAt = new Int32Array(w * h).fill(-1);
    for (const i of open) openAt[key(i)] = i;
    for (const i of open) {
      const c0 = key(i) % w, r0 = Math.floor(key(i) / w);
      if (c0 + k > w || r0 + k > h) continue;
      const cells: number[] = [];
      for (let dr = 0; dr < k; dr++)
        for (let dc = 0; dc < k; dc++) {
          const j = openAt[(r0 + dr) * w + c0 + dc]!;
          if (j >= 0) cells.push(j);
        }
      if (cells.length === k * k) blocks.set(i, cells);
    }
  }
  const blockMean = new Map<number, number>();
  for (const [a, cells] of blocks) blockMean.set(a, cells.reduce((s, j) => s + values[j]!, 0) / cells.length);
  const candidates = blocks.size ? [...blocks.keys()] : open;
  const value = (i: number) => blockMean.get(i) ?? values[i]!;

  // "Sunnier" is more hours, or less of the time in shade.
  const g = (i: number) => (mode === 'shade' ? -value(i) : value(i));
  const sorted = candidates.map(g).sort((a, b) => a - b);
  // Bands near the top and the bottom. Percentiles rather than counts: unobstructed cells all share
  // exactly the same top value, so a "top quarter" can't be told apart from the rest, and a small
  // sunny patch would vanish into a quarter of the lot.
  const hi = quantile(sorted, input.tight ? 1 : 0.95), lo = quantile(sorted, input.tight ? 0 : 0.05);
  if (hi - lo < EVEN_BELOW[mode]) return none;
  const band = input.tight ? TIGHT[mode] : Math.min(BAND[mode], (hi - lo) / 4);

  /** The largest 4-connected patch of `cells`, with its pin cell. */
  const largestPatch = (cells: number[]): Spot | null => {
    const at = new Int32Array(w * h).fill(-1);
    for (const i of cells) at[key(i)] = i;
    const seen = new Uint8Array(w * h);
    let best: number[] = [];
    for (const start of cells) {
      if (seen[key(start)]) continue;
      const patch = [key(start)];
      seen[patch[0]!] = 1;
      for (let n = 0; n < patch.length; n++) {
        const k = patch[n]!, c = k % w;
        for (const j of [c > 0 ? k - 1 : -1, c < w - 1 ? k + 1 : -1, k - w, k + w]) {
          if (j >= 0 && j < w * h && at[j]! >= 0 && !seen[j]) {
            seen[j] = 1;
            patch.push(j);
          }
        }
      }
      if (patch.length > best.length) best = patch;
    }
    if (!best.length) return null;

    // Distance from the patch's edge (in cells), spreading inward from the edge cells.
    const dist = new Map<number, number>();
    const queue: number[] = [];
    const inPatch = (j: number, c: number, dc: number) => c + dc >= 0 && c + dc < w && j >= 0 && j < w * h && at[j]! >= 0;
    const neighbours = (k: number): number[] => {
      const c = k % w;
      return [[k - 1, -1], [k + 1, 1], [k - w, 0], [k + w, 0]].filter(([j, dc]) => inPatch(j!, c, dc!)).map(([j]) => j!);
    };
    for (const k of best) {
      if (neighbours(k).length < 4) {
        dist.set(k, 0);
        queue.push(k);
      }
    }
    for (let n = 0; n < queue.length; n++) {
      const k = queue[n]!;
      for (const j of neighbours(k)) {
        if (!dist.has(j)) {
          dist.set(j, dist.get(k)! + 1);
          queue.push(j);
        }
      }
    }
    // The deepest cell; ties go to the one nearest the patch's centre.
    const cellsOf = best.map((k) => at[k]!);
    const cx = cellsOf.reduce((s, i) => s + px[i]!, 0) / cellsOf.length, cy = cellsOf.reduce((s, i) => s + py[i]!, 0) / cellsOf.length;
    let pin = best[0]!;
    for (const k of best) {
      const dk = dist.get(k) ?? 0, dp = dist.get(pin) ?? 0;
      const i = at[k]!, p = at[pin]!;
      if (dk > dp || (dk === dp && Math.hypot(px[i]! - cx, py[i]! - cy) < Math.hypot(px[p]! - cx, py[p]! - cy))) pin = k;
    }
    const cell = at[pin]!;
    return { cell, value: value(cell), areaM2: cellsOf.length * cellAreaM2, cells: cellsOf };
  };

  /** A chosen block: its mean, and a pin on the block cell closest to that mean (so its month chart agrees). */
  const asBlock = (s: Spot | null): Spot | null => {
    const cells = s && blocks.get(s.cell);
    if (!s || !cells) return s;
    const m = blockMean.get(s.cell)!;
    const cx = cells.reduce((t, j) => t + px[j]!, 0) / cells.length, cy = cells.reduce((t, j) => t + py[j]!, 0) / cells.length;
    const score = (j: number) => Math.abs(values[j]! - m) * 1000 + Math.hypot(px[j]! - cx, py[j]! - cy);
    const pin = cells.reduce((a, j) => (score(j) < score(a) ? j : a));
    return { cell: pin, value: m, areaM2: cells.length * cellAreaM2, cells };
  };

  return {
    sunniest: asBlock(largestPatch(candidates.filter((i) => g(i) >= hi - band))),
    shadiest: asBlock(largestPatch(candidates.filter((i) => g(i) <= lo + band))),
  };
}
