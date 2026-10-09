// Where an aerial photo sits relative to the elevation grid and the local frame. Pure maths: over a
// few hundred metres, grid → Web Mercator is affine to well under a pixel, so three points fix it.
import type { PixelWindow } from '../elevation/window';
import { fromPixel } from '../elevation/window';
import type { GridAffine } from '../geo/gridAffine';
import type { LocalFrame } from '../geo/local';
import type { Position, Ring } from '../geo/polygon';
import { fromCrs, toCrs, type GridCrs } from '../geo/proj';
import type { Bbox3857 } from './sources';

function affineFrom3(f: (p: Position) => Position, w: number, h: number): GridAffine {
  const o = f([0, 0]), c = f([w, 0]), r = f([0, h]);
  return { origin: o, col: [(c[0] - o[0]) / w, (c[1] - o[1]) / w], row: [(r[0] - o[0]) / h, (r[1] - o[1]) / h] };
}

/** Elevation-grid pixel → photo texture coordinates (u right, v down, 0–1 across the photo). */
export function gridToPhotoUv(w: PixelWindow, box: Bbox3857): GridAffine {
  return affineFrom3(
    (p) => {
      const [x, y] = toCrs('EPSG:3857', fromCrs(w.crs, fromPixel(w, p)));
      return [(x - box.minX) / (box.maxX - box.minX), (box.maxY - y) / (box.maxY - box.minY)];
    },
    w.width,
    w.height,
  );
}

/** Photo pixel → local metres (x east, y north), for drawing it on the 2D map. */
export function photoToLocal(box: Bbox3857, width: number, height: number, frame: LocalFrame): GridAffine {
  return affineFrom3(
    ([px, py]) => frame.toLocal(fromCrs('EPSG:3857', [box.minX + (px / width) * (box.maxX - box.minX), box.maxY - (py / height) * (box.maxY - box.minY)])),
    width,
    height,
  );
}

/**
 * The Web Mercator box a photo should cover: the lot's bounding box grown by `marginM`, taken in
 * both grids the analysis can use (so it holds after a refinement changes grids) and projected.
 */
export function photoBox(lotLonLat: Ring[][], marginM: number): Bbox3857 {
  const pts: Position[] = [];
  for (const crs of ['EPSG:3979', 'EPSG:3157'] as GridCrs[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const rings of lotLonLat)
      for (const p of rings[0] ?? []) {
        const [x, y] = toCrs(crs, p);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    for (const c of [[minX - marginM, minY - marginM], [maxX + marginM, minY - marginM], [minX - marginM, maxY + marginM], [maxX + marginM, maxY + marginM]] as Position[])
      pts.push(toCrs('EPSG:3857', fromCrs(crs, c)));
  }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}
