// Pure pixel-window maths for the HRDEM mosaic tiles (EPSG:3979, 1 m, north-up grid).
//
// Continuous pixel coordinates inside a window: px = (X − x0) / res, py = (y0 − Y) / res,
// so pixel (c, r) is centred at (c + 0.5, r + 0.5) and grid north is −py.
import type { Position, Ring } from '../geo/polygon';
import type { GridCrs } from '../geo/proj';

/** Tile geometry, read from the COG header (authoritative; STAC's proj:transform order varies). */
export interface TileGrid {
  crs: GridCrs;
  originX: number; // 3979 x of the tile's left edge
  originY: number; // 3979 y of the tile's top edge
  res: number; // metres per pixel
  width: number;
  height: number;
}

export interface PixelWindow {
  crs: GridCrs;
  col0: number;
  row0: number;
  width: number;
  height: number;
  /** 3979 coordinates of the window's top-left corner. */
  x0: number;
  y0: number;
  res: number;
}

export interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class TileEdgeError extends Error {
  constructor() {
    super('Analysis window crosses the edge of the elevation tile');
    this.name = 'TileEdgeError';
  }
}

/** Lot bbox (3979) grown by the buffer, snapped outward to whole pixels, and checked against the tile. */
export function lotWindow(lot: Bbox, bufferM: number, tile: TileGrid): PixelWindow {
  const col0 = Math.floor((lot.minX - bufferM - tile.originX) / tile.res);
  const col1 = Math.ceil((lot.maxX + bufferM - tile.originX) / tile.res);
  const row0 = Math.floor((tile.originY - (lot.maxY + bufferM)) / tile.res);
  const row1 = Math.ceil((tile.originY - (lot.minY - bufferM)) / tile.res);
  if (col0 < 0 || row0 < 0 || col1 > tile.width || row1 > tile.height) throw new TileEdgeError();
  return {
    crs: tile.crs,
    col0,
    row0,
    width: col1 - col0,
    height: row1 - row0,
    x0: tile.originX + col0 * tile.res,
    y0: tile.originY - row0 * tile.res,
    res: tile.res,
  };
}

/** A window snapped to multiples of `res` in its CRS, for grids we build ourselves (no source tile). */
export function alignedWindow(lot: Bbox, bufferM: number, res: number, crs: GridCrs): PixelWindow {
  const x0 = Math.floor((lot.minX - bufferM) / res) * res;
  const x1 = Math.ceil((lot.maxX + bufferM) / res) * res;
  const y1 = Math.ceil((lot.maxY + bufferM) / res) * res;
  const y0 = Math.floor((lot.minY - bufferM) / res) * res;
  return { crs, col0: 0, row0: 0, width: Math.round((x1 - x0) / res), height: Math.round((y1 - y0) / res), x0, y0: y1, res };
}

export function toPixel(w: PixelWindow, [x, y]: Position): Position {
  return [(x - w.x0) / w.res, (w.y0 - y) / w.res];
}

export function fromPixel(w: PixelWindow, [px, py]: Position): Position {
  return [w.x0 + px * w.res, w.y0 - py * w.res];
}

export function ringsToPixel(w: PixelWindow, polygons: Ring[][]): Ring[][] {
  return polygons.map((rings) => rings.map((ring) => ring.map((p) => toPixel(w, p))));
}

export function bboxOf(polygons: Ring[][]): Bbox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rings of polygons) {
    for (const [x, y] of rings[0] ?? []) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Copy a smaller window's raster into an outer window's grid (NaN elsewhere), so code that indexes
 * the outer window keeps working. Used to read the DTM only around the lot.
 */
export function embedWindow(outer: PixelWindow, inner: PixelWindow, data: Float32Array): Float32Array {
  const out = new Float32Array(outer.width * outer.height).fill(NaN);
  const dc = inner.col0 - outer.col0, dr = inner.row0 - outer.row0;
  for (let r = 0; r < inner.height; r++) {
    const y = r + dr;
    if (y < 0 || y >= outer.height) continue;
    for (let c = 0; c < inner.width; c++) {
      const x = c + dc;
      if (x >= 0 && x < outer.width) out[y * outer.width + x] = data[r * inner.width + c]!;
    }
  }
  return out;
}
