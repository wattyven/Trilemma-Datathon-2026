// Affine map from a window's continuous pixel coordinates to the lot's local metric frame
// (x = east, y = TRUE north). Solved from three projected corners, so it carries the grid
// convergence (~25° here) and the projection's scale factor. Good to ~cm over a lot window.
import type { PixelWindow } from '../elevation/window';
import { fromPixel } from '../elevation/window';
import type { LocalFrame } from './local';
import type { Position } from './polygon';
import { fromLcc } from './proj';

export interface GridAffine {
  /** Local position of pixel (0, 0), the window's top-left corner. */
  origin: Position;
  /** Local displacement of +1 pixel in column / row. */
  col: Position;
  row: Position;
}

export function gridToLocalAffine(w: PixelWindow, frame: LocalFrame): GridAffine {
  const at = (px: number, py: number) => frame.toLocal(fromLcc(fromPixel(w, [px, py])));
  const o = at(0, 0);
  const c = at(w.width, 0);
  const r = at(0, w.height);
  return {
    origin: o,
    col: [(c[0] - o[0]) / w.width, (c[1] - o[1]) / w.width],
    row: [(r[0] - o[0]) / w.height, (r[1] - o[1]) / w.height],
  };
}

export function applyAffine(a: GridAffine, [px, py]: Position): Position {
  return [a.origin[0] + px * a.col[0] + py * a.row[0], a.origin[1] + px * a.col[1] + py * a.row[1]];
}

export function invertAffine(a: GridAffine, [x, y]: Position): Position {
  const dx = x - a.origin[0], dy = y - a.origin[1];
  const det = a.col[0] * a.row[1] - a.row[0] * a.col[1];
  return [(dx * a.row[1] - dy * a.row[0]) / det, (a.col[0] * dy - a.col[1] * dx) / det];
}
