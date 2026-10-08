// Terrain meshes from the DSM window: 1 m around the lot, 4 m farther out. Pure array
// builders (no three.js), so geometry is unit-testable; view3d.ts wraps them in BufferGeometry.
//
// Vertices sit on pixel centres (c + 0.5, r + 0.5) and are placed with the grid → local affine,
// so the mesh carries the ~25° grid convergence and lines up with the lot outline and the engine.
import { applyAffine, type GridAffine } from '../geo/gridAffine';
import { localToScene } from './frame';

export interface PixelRect {
  c0: number;
  r0: number;
  c1: number; // exclusive bounds in pixels
  r1: number;
}

export interface TerrainInput {
  width: number;
  height: number;
  dsm: Float32Array; // NaN = nodata
  dtm: Float32Array;
  affine: GridAffine;
  /** Metres subtracted from elevations so the scene sits near y = 0. */
  base: number;
}

export interface MeshArrays {
  positions: Float32Array; // xyz per vertex
  colors: Float32Array; // rgb per vertex, linear 0–1
  uvs: Float32Array; // grid-space texture coords (u = px / width, v = py / height)
  indices: Uint32Array;
  /** First vertex of the skirt (its own vertices, so it doesn't bend the surface's normals). */
  skirtStart: number;
}

export interface TerrainColors {
  ground: [number, number, number];
  raised: [number, number, number];
  water: [number, number, number];
}

/** 5th-percentile DSM: a base level that ignores the odd deep pit. */
export function baseLevel(dsm: Float32Array): number {
  const v = Array.from(dsm).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length * 0.05)]! : 0;
}

/** Lot bounds (pixels) + margin, snapped outward to multiples of `align` and clipped to the window. */
export function innerRect(lot: PixelRect, marginPx: number, align: number, width: number, height: number): PixelRect {
  const snapDown = (v: number) => Math.max(0, Math.floor(v / align) * align);
  const snapUp = (v: number, max: number) => Math.min(Math.floor((max - 1) / align) * align, Math.ceil(v / align) * align);
  return {
    c0: snapDown(lot.c0 - marginPx),
    r0: snapDown(lot.r0 - marginPx),
    c1: snapUp(lot.c1 + marginPx, width),
    r1: snapUp(lot.r1 + marginPx, height),
  };
}

/**
 * A regular vertex grid over `rect` at `step` pixels (vertices at rect corners inclusive).
 * Quads entirely inside `hole` are skipped (the outer mesh leaves room for the inner one).
 * `skirtM` adds a vertical curtain around the edge to hide cracks where meshes meet.
 */
export function buildGrid(t: TerrainInput, rect: PixelRect, step: number, colors: TerrainColors, opts: { hole?: PixelRect; skirtM?: number } = {}): MeshArrays {
  const cols = Math.floor((rect.c1 - rect.c0) / step) + 1;
  const rows = Math.floor((rect.r1 - rect.r0) / step) + 1;
  const pos: number[] = [], col: number[] = [], uv: number[] = [], idx: number[] = [];

  const vertex = (c: number, r: number, drop = 0) => {
    const cc = Math.min(t.width - 1, Math.max(0, c)), rr = Math.min(t.height - 1, Math.max(0, r));
    const k = rr * t.width + cc;
    const s = t.dsm[k]!, g = t.dtm[k]!;
    const water = Number.isNaN(s);
    const z = water ? 0 : s - t.base; // water lies flat at the base level
    const px = cc + 0.5, py = rr + 0.5;
    const [x, y, zz] = localToScene(applyAffine(t.affine, [px, py]), z - drop);
    pos.push(x, y, zz);
    const c3 = water ? colors.water : !Number.isNaN(g) && s - g > 2 ? colors.raised : colors.ground;
    col.push(...c3);
    uv.push(px / t.width, py / t.height);
    return pos.length / 3 - 1;
  };

  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) vertex(rect.c0 + i * step, rect.r0 + j * step);
  const at = (i: number, j: number) => j * cols + i;
  const h = opts.hole;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const c = rect.c0 + i * step, r = rect.r0 + j * step;
      if (h && c >= h.c0 && c + step <= h.c1 && r >= h.r0 && r + step <= h.r1) continue;
      const a = at(i, j), b = at(i + 1, j), d = at(i, j + 1), e = at(i + 1, j + 1);
      // Counter-clockwise when seen from above (+Y), so normals point up.
      idx.push(a, d, b, b, d, e);
    }
  }

  const skirtStart = pos.length / 3;
  if (opts.skirtM) {
    const ring: [number, number][] = [];
    for (let i = 0; i < cols; i++) ring.push([i, 0]);
    for (let j = 1; j < rows; j++) ring.push([cols - 1, j]);
    for (let i = cols - 2; i >= 0; i--) ring.push([i, rows - 1]);
    for (let j = rows - 2; j > 0; j--) ring.push([0, j]);
    ring.push(ring[0]!);
    for (let n = 0; n < ring.length - 1; n++) {
      const [i0, j0] = ring[n]!, [i1, j1] = ring[n + 1]!;
      const top0 = vertex(rect.c0 + i0 * step, rect.r0 + j0 * step);
      const top1 = vertex(rect.c0 + i1 * step, rect.r0 + j1 * step);
      const low0 = vertex(rect.c0 + i0 * step, rect.r0 + j0 * step, opts.skirtM);
      const low1 = vertex(rect.c0 + i1 * step, rect.r0 + j1 * step, opts.skirtM);
      idx.push(top0, low0, top1, top1, low0, low1, top0, top1, low0, top1, low1, low0); // both faces
    }
  }

  return { positions: Float32Array.from(pos), colors: Float32Array.from(col), uvs: Float32Array.from(uv), indices: Uint32Array.from(idx), skirtStart };
}
