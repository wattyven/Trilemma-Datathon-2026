// Resample a raster from one grid into another (e.g. the 1 m EPSG:3979 HRDEM into a 0.5 m UTM 10N
// grid). Over a few hundred metres the map between two conformal projections is affine to well
// under a centimetre, so we solve that affine from three projected points and then sample
// bilinearly (NaN-aware) at every target pixel centre.
import { bilinear, type Raster } from '../engine/grid';
import type { Position } from '../geo/polygon';
import { fromCrs, toCrs } from '../geo/proj';
import { fromPixel, toPixel, type PixelWindow } from './window';

export interface PixelAffine {
  // source = origin + tx * col + ty * row, for a target pixel coordinate (tx, ty)
  origin: Position;
  col: Position;
  row: Position;
}

/** Target pixel coordinates → source pixel coordinates. */
export function windowAffine(target: PixelWindow, source: PixelWindow): PixelAffine {
  const map = (p: Position): Position => {
    const xy = fromPixel(target, p);
    const sameCrs = target.crs === source.crs;
    return toPixel(source, sameCrs ? xy : toCrs(source.crs, fromCrs(target.crs, xy)));
  };
  const o = map([0, 0]);
  const c = map([target.width, 0]);
  const r = map([0, target.height]);
  return {
    origin: o,
    col: [(c[0] - o[0]) / target.width, (c[1] - o[1]) / target.width],
    row: [(r[0] - o[0]) / target.height, (r[1] - o[1]) / target.height],
  };
}

export interface Region {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

/**
 * Sample `source` into a new target-sized raster (NaN outside `region` and wherever the source
 * has no data). Pass `into` to fill an existing array instead.
 */
export function resampleInto(target: PixelWindow, source: PixelWindow, data: Float32Array, region?: Region, into?: Float32Array): Float32Array {
  const out = into ?? new Float32Array(target.width * target.height).fill(NaN);
  const a = windowAffine(target, source);
  const src: Raster = { width: source.width, height: source.height, data };
  const rg = region ?? { c0: 0, r0: 0, c1: target.width, r1: target.height };
  for (let r = Math.max(0, rg.r0); r < Math.min(target.height, rg.r1); r++) {
    const ty = r + 0.5;
    for (let c = Math.max(0, rg.c0); c < Math.min(target.width, rg.c1); c++) {
      const tx = c + 0.5;
      const v = bilinear(src, a.origin[0] + tx * a.col[0] + ty * a.row[0], a.origin[1] + tx * a.col[1] + ty * a.row[1]);
      if (v === v) out[r * target.width + c] = v; // skip NaN: keep what's there
    }
  }
  return out;
}

/** Pixel region of `target` covered by a box in the target's CRS (clipped to the window). */
export function regionOfBox(target: PixelWindow, box: { minX: number; minY: number; maxX: number; maxY: number }): Region {
  const [c0, r0] = toPixel(target, [box.minX, box.maxY]);
  const [c1, r1] = toPixel(target, [box.maxX, box.minY]);
  return {
    c0: Math.max(0, Math.floor(c0)),
    r0: Math.max(0, Math.floor(r0)),
    c1: Math.min(target.width, Math.ceil(c1)),
    r1: Math.min(target.height, Math.ceil(r1)),
  };
}
