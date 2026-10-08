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
