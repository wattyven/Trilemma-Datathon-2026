// Elevation rasters and analysis cells. All coordinates are continuous pixel
// coordinates in the window: pixel (c, r) is centred at (c + 0.5, r + 0.5); NaN means nodata.
import { HEATMAP } from '../config';
import { pointInGeometry, type AreaGeometry, type Ring } from '../geo/polygon';

export interface Raster {
  width: number;
  height: number;
  data: Float32Array;
}

export interface Observer {
  mode: 'ground' | 'surface';
  heightM: number;
}

export interface CellSet {
  count: number;
  px: Float32Array;
  py: Float32Array;
  /** Observer height (metres, CGVD2013). */
  z0: Float32Array;
  dsm: Float32Array;
  dtm: Float32Array;
  /** 1 where DSM − DTM exceeds the covered threshold: a roof or canopy overhead. */
  covered: Uint8Array;
  /** Cell spacing in pixels: 1 normally, >1 when a big lot was coarsened. */
  step: number;
  /** Candidate cells dropped because the lot itself had no elevation data there. */
  dropped: number;
  candidates: number;
}

export class NoLidarError extends Error {
  constructor(readonly reason: 'lot-nodata' | 'no-cells') {
    super(reason === 'no-cells' ? 'The lot covers no elevation cells' : 'No LiDAR coverage for this lot');
    this.name = 'NoLidarError';
  }
}

/** NaN-aware bilinear sample between pixel centres. NaN outside the raster or next to nodata. */
export function bilinear(r: Raster, px: number, py: number): number {
  const x = px - 0.5;
  const y = py - 0.5;
  if (!(x >= 0 && y >= 0 && x <= r.width - 1 && y <= r.height - 1)) return NaN;
  const i0 = Math.min(Math.floor(x), r.width - 2);
  const j0 = Math.min(Math.floor(y), r.height - 2);
  const fx = x - i0;
  const fy = y - j0;
  const d = r.data;
  const k = j0 * r.width + i0;
  // Zero-weight neighbours are skipped so an exact pixel centre next to a nodata pixel stays
  // valid; any nodata neighbour that does carry weight makes the sample NaN.
  let z = 0;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  if (w00 > 0) z += w00 * d[k]!;
  if (w10 > 0) z += w10 * d[k + 1]!;
  if (w01 > 0) z += w01 * d[k + r.width]!;
  if (w11 > 0) z += w11 * d[k + r.width + 1]!;
  return z;
}

export function nodataFraction(r: Raster): number {
  let n = 0;
  for (const v of r.data) if (Number.isNaN(v)) n++;
  return r.data.length ? n / r.data.length : 0;
}

export function maxValue(r: Raster): number {
  let m = -Infinity;
  for (const v of r.data) if (v > m) m = v; // NaN comparisons are false
  return m;
}

export interface CellOptions {
  cap: number;
  observer: Observer;
  coveredM: number;
  lotNodataMax: number;
}

/**
 * Cells whose centres fall inside the lot (polygons given in pixel coordinates). Above `cap`
 * the grid coarsens to f × f blocks, f = ⌈√(n / cap)⌉, sampled at block centres.
 */
export function selectCells(dsm: Raster, dtm: Raster, lot: Ring[][], o: CellOptions): CellSet {
  const geom: AreaGeometry = { type: 'MultiPolygon', coordinates: lot };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rings of lot) {
    for (const [x, y] of rings[0] ?? []) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const c0 = Math.max(0, Math.floor(minX)), c1 = Math.min(dsm.width, Math.ceil(maxX));
  const r0 = Math.max(0, Math.floor(minY)), r1 = Math.min(dsm.height, Math.ceil(maxY));

  const centresAt = (step: number) => {
    const xs: number[] = [], ys: number[] = [];
    for (let r = r0; r < r1; r += step) {
      for (let c = c0; c < c1; c += step) {
        const x = c + step / 2, y = r + step / 2;
        if (pointInGeometry([x, y], geom)) {
          xs.push(x);
          ys.push(y);
        }
      }
    }
    return { xs, ys };
  };

  let step = 1;
  let { xs, ys } = centresAt(1);
  if (xs.length > o.cap) {
    step = Math.ceil(Math.sqrt(xs.length / o.cap));
    ({ xs, ys } = centresAt(step));
  }
  const candidates = xs.length;
  if (candidates === 0) throw new NoLidarError('no-cells');

  const keep: number[] = [];
  const dsmV: number[] = [], dtmV: number[] = [];
  for (let i = 0; i < candidates; i++) {
    const s = bilinear(dsm, xs[i]!, ys[i]!);
    const t = bilinear(dtm, xs[i]!, ys[i]!);
    if (Number.isNaN(s) || Number.isNaN(t)) continue;
    keep.push(i);
    dsmV.push(s);
    dtmV.push(t);
  }
  const dropped = candidates - keep.length;
  if (dropped / candidates > o.lotNodataMax) throw new NoLidarError('lot-nodata');

  const n = keep.length;
  const cells: CellSet = {
    count: n,
    px: new Float32Array(n),
    py: new Float32Array(n),
    z0: new Float32Array(n),
    dsm: Float32Array.from(dsmV),
    dtm: Float32Array.from(dtmV),
    covered: new Uint8Array(n),
    step,
    dropped,
    candidates,
  };
  keep.forEach((src, i) => {
    cells.px[i] = xs[src]!;
    cells.py[i] = ys[src]!;
    const s = dsmV[i]!, t = dtmV[i]!;
    cells.z0[i] = o.observer.mode === 'surface' ? s + o.observer.heightM : t + o.observer.heightM;
    cells.covered[i] = s - t > o.coveredM ? 1 : 0;
  });
  return cells;
}

/** Pixel step that covers a window in at most HEATMAP.cap samples, and at least HEATMAP.minM on the ground. */
export function heatmapStep(width: number, height: number, resM: number): number {
  const minPx = Math.max(1, Math.ceil(HEATMAP.minM / Math.max(resM, 0.01)));
  const cap = HEATMAP.cap;
  if (Math.ceil(width / minPx) * Math.ceil(height / minPx) <= cap) return minPx;
  return Math.max(minPx, Math.ceil(Math.sqrt((width * height) / cap)));
}

/**
 * One sample per `step`×`step` block across the whole raster, not only the lot.
 * Blocks with no elevation are left out; the rest cover the loaded landscape.
 */
export function selectWindowCells(dsm: Raster, dtm: Raster, step: number, observer: Observer, coveredM: number): CellSet {
  const size = Math.max(1, Math.round(step));
  const xs: number[] = [];
  const ys: number[] = [];
  const dsmV: number[] = [];
  const dtmV: number[] = [];
  // The ground model is only stored near the lot. Farther out the 3D view is still the surface, so a
  // block counts when any pixel has a surface; the observer stands on the ground where we have it.
  for (let r0 = 0; r0 < dsm.height; r0 += size) {
    const r1 = Math.min(dsm.height, r0 + size);
    for (let c0 = 0; c0 < dsm.width; c0 += size) {
      const c1 = Math.min(dsm.width, c0 + size);
      let px = 0, py = 0, s = NaN, t = NaN, both = false;
      for (let r = r0; r < r1 && !both; r++) {
        for (let c = c0; c < c1; c++) {
          const sv = dsm.data[r * dsm.width + c]!;
          if (Number.isNaN(sv)) continue;
          const tv = dtm.data[r * dtm.width + c]!;
          if (!Number.isNaN(tv)) {
            px = c + 0.5; py = r + 0.5; s = sv; t = tv; both = true;
            break;
          }
          if (Number.isNaN(s)) { px = c + 0.5; py = r + 0.5; s = sv; t = sv; }
        }
      }
      if (Number.isNaN(s)) continue;
      xs.push(px); ys.push(py); dsmV.push(s); dtmV.push(t);
    }
  }
  const n = xs.length;
  const blocks = Math.ceil(dsm.height / size) * Math.ceil(dsm.width / size);
  const cells: CellSet = {
    count: n,
    px: Float32Array.from(xs),
    py: Float32Array.from(ys),
    z0: new Float32Array(n),
    dsm: Float32Array.from(dsmV),
    dtm: Float32Array.from(dtmV),
    covered: new Uint8Array(n),
    step: size,
    dropped: blocks - n,
    candidates: blocks,
  };
  for (let i = 0; i < n; i++) {
    const s = dsmV[i]!, t = dtmV[i]!;
    cells.z0[i] = observer.mode === 'surface' ? s + observer.heightM : t + observer.heightM;
    cells.covered[i] = s - t > coveredM ? 1 : 0;
  }
  return cells;
}

/** Recompute observer heights for a new observer without re-selecting cells. */
export function withObserver(cells: CellSet, observer: Observer): CellSet {
  const z0 = new Float32Array(cells.count);
  for (let i = 0; i < cells.count; i++) {
    z0[i] = observer.mode === 'surface' ? cells.dsm[i]! + observer.heightM : cells.dtm[i]! + observer.heightM;
  }
  return { ...cells, z0 };
}
