// Per-cell colouring shared by the 2D map and the 3D overlay: values → RGBA in window pixel space,
// with covered cells (roof or canopy overhead) hatched. Also the pixel → cell lookup for picking.
import { CLASS_THRESHOLDS, type Thresholds } from '../config';
import { CLASS_RGB, SHADE_RGB, SUN_RGB, WATER_RGB, cividis, type Rgb } from './colors';

export const HOURS_SCALE_MAX = 16;

export type LayerKind = 'hours' | 'moment' | 'percent';

export interface Layer {
  kind: LayerKind;
  values: Float32Array | Uint8Array;
  asClasses: boolean;
  /** Class boundaries when `asClasses` (defaults to 6 h / 3 h). */
  thresholds?: Thresholds;
}

export interface CellGrid {
  width: number; // window pixels
  height: number;
  px: Float32Array; // cell centres, continuous pixel coords
  py: Float32Array;
  covered: Uint8Array;
  step: number; // cell size in pixels
}

export function layerColor(layer: Layer, i: number): Rgb {
  const v = layer.values[i]!;
  if (layer.kind === 'moment') return v ? SUN_RGB : SHADE_RGB;
  if (layer.kind === 'percent') return Number.isNaN(v) ? WATER_RGB : cividis(1 - v / 100);
  if (layer.asClasses) {
    const t = layer.thresholds ?? CLASS_THRESHOLDS;
    return CLASS_RGB[v >= t.fullSunH ? 2 : v >= t.partSunH ? 1 : 0];
  }
  return cividis(v / HOURS_SCALE_MAX);
}

/** Pixel rectangle covered by cell i (a block when the grid was coarsened). */
export function cellBlock(g: CellGrid, i: number) {
  const x0 = Math.max(0, Math.round(g.px[i]! - g.step / 2));
  const y0 = Math.max(0, Math.round(g.py[i]! - g.step / 2));
  return { x0, y0, x1: Math.min(g.width, x0 + g.step), y1: Math.min(g.height, y0 + g.step) };
}

/** Window pixel → cell index (−1 outside the lot). */
export function buildCellIndex(g: CellGrid): Int32Array {
  const idx = new Int32Array(g.width * g.height).fill(-1);
  for (let i = 0; i < g.px.length; i++) {
    const b = cellBlock(g, i);
    for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) idx[y * g.width + x] = i;
  }
  return idx;
}

export function cellAtPixel(g: CellGrid, index: Int32Array, px: number, py: number): number | null {
  const x = Math.floor(px), y = Math.floor(py);
  if (x < 0 || y < 0 || x >= g.width || y >= g.height) return null;
  const i = index[y * g.width + x]!;
  return i >= 0 ? i : null;
}

/** RGBA for every cell's block; transparent elsewhere. `color(i)` returns null to leave a cell clear. */
export function paintCellsRgba(g: CellGrid, color: (i: number) => { rgb: Rgb; alpha: number } | null, hatchCovered = true): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0; i < g.px.length; i++) {
    const c = color(i);
    if (!c) continue;
    const [r, gg, b] = c.rgb;
    const blk = cellBlock(g, i);
    for (let y = blk.y0; y < blk.y1; y++) {
      for (let x = blk.x0; x < blk.x1; x++) {
        const k = hatchCovered && g.covered[i] && (x + y) % 4 === 0 ? 0.45 : 1;
        data.set([r * k, gg * k, b * k, c.alpha], (y * g.width + x) * 4);
      }
    }
  }
  return data;
}

export function layerRgba(g: CellGrid, layer: Layer, alpha = 235): Uint8ClampedArray<ArrayBuffer> {
  return paintCellsRgba(g, (i) => ({ rgb: layerColor(layer, i), alpha }));
}

/**
 * A mask as a translucent hatch: lines running "\" (the covered-cell hatch runs "/"), so the two
 * never read alike. Window-sized RGBA for a canvas or texture.
 */
export function hatchMaskRgba(mask: Uint8Array, width: number, height: number, rgb: Rgb, alpha: number, period = 6): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const k = y * width + x;
      if (!mask[k]) continue;
      const line = (((x - y) % period) + period) % period < 2;
      out.set([rgb[0], rgb[1], rgb[2], line ? alpha : Math.round(alpha * 0.25)], 4 * k);
    }
  return out;
}

/** Pixel bounding box of a mask's set cells (exclusive ends), or null when empty. */
export function maskBounds(mask: Uint8Array, width: number, height: number): { c0: number; r0: number; c1: number; r1: number } | null {
  let c0 = width, r0 = height, c1 = -1, r1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (mask[y * width + x]) {
        if (x < c0) c0 = x;
        if (x > c1) c1 = x;
        if (y < r0) r0 = y;
        if (y > r1) r1 = y;
      }
  return c1 < 0 ? null : { c0, r0, c1: c1 + 1, r1: r1 + 1 };
}
