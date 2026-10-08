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

/** Land is one quiet "clay model" colour (roofs and canopy read through light and shadow); water is blue. */
export interface TerrainColors {
  ground: [number, number, number];
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
    const s = t.dsm[k]!;
    const water = Number.isNaN(s);
    const z = water ? 0 : s - t.base; // water lies flat at the base level
    const px = cc + 0.5, py = rr + 0.5;
    const [x, y, zz] = localToScene(applyAffine(t.affine, [px, py]), z - drop);
    pos.push(x, y, zz);
    const c3 = water ? colors.water : colors.ground;
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

/**
 * A "terraced" mesh over the cells of `rect` (inclusive, at `step` pixels): each cell is a flat-ish
 * top at its true footprint, and where neighbouring cells differ by more than `wallM` they get a
 * vertical wall between them, so buildings read as buildings instead of 1-cell ramps.
 *
 * A cell's corner sits at the mean height of the cells around that corner that are within `wallM`
 * of it, so continuous ground and roofs share corners (smooth shading, no seams) and only real
 * steps split. Rough cells (tree crowns: no plane fits the cell and its same-level neighbours to
 * within `roughM`) blend with all their neighbours instead, so trees stay soft rather than blocky. Wall quads join any shared edge whose two sides disagree, which keeps the surface
 * closed. Walls get their own vertices (flat lighting) and face the lower side. UVs sit on pixel
 * edges, so a texture's texels land exactly on cells. `walls: false` gives the tops only (for
 * overlays). Rendering only: the shading engine never sees this mesh.
 */
export function buildTerraced(t: TerrainInput, rect: PixelRect, step: number, colors: TerrainColors, opts: { wallM: number; roughM?: number; skirtM?: number; walls?: boolean }): MeshArrays {
  const cols = Math.floor((rect.c1 - rect.c0) / step) + 1;
  const rows = Math.floor((rect.r1 - rect.r0) / step) + 1;
  const pos: number[] = [], col: number[] = [], uv: number[] = [], idx: number[] = [];

  // Cell heights above the base (water: flat at 0), the highest pixel of each block.
  const h = new Float32Array(cols * rows), water = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      let m = -Infinity;
      for (let r = rect.r0 + j * step; r < rect.r0 + (j + 1) * step; r++)
        for (let c = rect.c0 + i * step; c < rect.c0 + (i + 1) * step; c++) {
          const v = t.dsm[Math.min(t.height - 1, r) * t.width + Math.min(t.width - 1, c)]!;
          if (v > m) m = v;
        }
      const k = j * cols + i;
      water[k] = m === -Infinity ? 1 : 0;
      h[k] = water[k] ? 0 : m - t.base;
    }

  // Rough cells: no plane fits the cell and its neighbours on the same level (within wallM) to
  // within roughM, or it has fewer than 3 such neighbours (a post, a thin hedge). Roofs, pitched
  // ones included, and ground are planar; tree crowns aren't.
  const roughM = opts.roughM ?? 0.5;
  const rough = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i, hk = h[k]!;
      const pts: [number, number, number][] = [[0, 0, hk]];
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if ((di === 0 && dj === 0) || ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
          const v = h[jj * cols + ii]!;
          if (Math.abs(v - hk) <= opts.wallM) pts.push([di, dj, v]);
        }
      const onEdge = i === 0 || j === 0 || i === cols - 1 || j === rows - 1;
      if (pts.length < 4) {
        rough[k] = onEdge ? 0 : 1; // the rect's edge cells just have fewer neighbours
        continue;
      }
      rough[k] = planeResidual(pts) > roughM ? 1 : 0;
    }
  // Smooth areas narrower than 3 × 3 cells (a sliver between a tree and a wall, a lucky patch of
  // canopy) blend too: an opening of the smooth mask. Otherwise they leave stray wall fragments.
  const smoothAt = (src: Uint8Array, i: number, j: number) => i < 0 || j < 0 || i >= cols || j >= rows || !src[j * cols + i];
  const eroded = new Uint8Array(cols * rows); // 1 = rough after eroding the smooth mask
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      let all = true;
      for (let dj = -1; dj <= 1 && all; dj++) for (let di = -1; di <= 1 && all; di++) all = smoothAt(rough, i + di, j + dj);
      eroded[j * cols + i] = all ? 0 : 1;
    }
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      if (rough[j * cols + i]) continue;
      let any = false;
      for (let dj = -1; dj <= 1 && !any; dj++)
        for (let di = -1; di <= 1 && !any; di++) {
          const ii = i + di, jj = j + dj;
          any = ii >= 0 && jj >= 0 && ii < cols && jj < rows && !eroded[jj * cols + ii];
        }
      if (!any) rough[j * cols + i] = 1;
    }

  // Corner (ci, cj) of the corner grid, for cell k: mean of the cells around the corner on k's
  // level (within wallM), or of all of them when any is rough, so every cell agrees there.
  const cornerHeight = (k: number, ci: number, cj: number) => {
    const hk = h[k]!;
    const around: number[] = [];
    for (const [i, j] of [[ci - 1, cj - 1], [ci, cj - 1], [ci - 1, cj], [ci, cj]] as const) if (i >= 0 && j >= 0 && i < cols && j < rows) around.push(j * cols + i);
    const blend = around.some((c) => rough[c]);
    let sum = 0, n = 0;
    for (const c of around) {
      const v = h[c]!;
      if (blend || Math.abs(v - hk) <= opts.wallM) {
        sum += v;
        n++;
      }
    }
    return sum / n;
  };
  const place = (ci: number, cj: number, height: number, isWater: boolean) => {
    const px = rect.c0 + ci * step, py = rect.r0 + cj * step;
    const [x, y, z] = localToScene(applyAffine(t.affine, [px, py]), height);
    pos.push(x, y, z);
    col.push(...(isWater ? colors.water : colors.ground));
    uv.push(px / t.width, py / t.height);
    return pos.length / 3 - 1;
  };
  const shared = new Map<string, number>();
  const topVertex = (k: number, ci: number, cj: number) => {
    const height = cornerHeight(k, ci, cj);
    const key = `${ci},${cj},${height.toFixed(3)},${water[k]}`;
    let v = shared.get(key);
    if (v === undefined) shared.set(key, (v = place(ci, cj, height, !!water[k])));
    return v;
  };

  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const a = topVertex(k, i, j), b = topVertex(k, i + 1, j), d = topVertex(k, i, j + 1), e = topVertex(k, i + 1, j + 1);
      idx.push(a, d, b, b, d, e); // counter-clockwise from above, as in buildGrid
    }

  if (opts.walls !== false) {
    const P = (v: number): [number, number, number] => [pos[3 * v]!, pos[3 * v + 1]!, pos[3 * v + 2]!];
    // A triangle facing `towards` (a scene-space horizontal direction), whatever order it came in.
    const facing = (v0: number, v1: number, v2: number, towards: [number, number]) => {
      const [a, b, c] = [P(v0), P(v1), P(v2)];
      const u: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const w: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const nx = u[1] * w[2] - u[2] * w[1], nz = u[0] * w[1] - u[1] * w[0];
      idx.push(...(nx * towards[0] + nz * towards[1] >= 0 ? [v0, v1, v2] : [v0, v2, v1]));
    };
    const wall = (k: number, n: number, [c1i, c1j]: [number, number], [c2i, c2j]: [number, number]) => {
      const k1 = cornerHeight(k, c1i, c1j), k2 = cornerHeight(k, c2i, c2j);
      const n1 = cornerHeight(n, c1i, c1j), n2 = cornerHeight(n, c2i, c2j);
      const same1 = Math.abs(k1 - n1) < 1e-3, same2 = Math.abs(k2 - n2) < 1e-3;
      if (same1 && same2) return;
      // Face the lower cell: from the higher cell's centre towards the lower one's, in the scene.
      const [hi, lo] = k1 + k2 >= n1 + n2 ? [k, n] : [n, k];
      const centre = (c: number) => localToScene(applyAffine(t.affine, [rect.c0 + ((c % cols) + 0.5) * step, rect.r0 + (Math.floor(c / cols) + 0.5) * step]), 0);
      const ch = centre(hi), cl = centre(lo);
      const towards: [number, number] = [cl[0] - ch[0], cl[2] - ch[2]];
      if (same1 || same2) {
        // Where a step runs into blended ground (a tree), only a sliver needs filling: reuse the
        // tops' own vertices so it shades smoothly with them instead of as a flat shard.
        facing(topVertex(k, c1i, c1j), topVertex(k, c2i, c2j), same1 ? topVertex(n, c2i, c2j) : topVertex(n, c1i, c1j), towards);
        return;
      }
      const q = [place(c1i, c1j, k1, false), place(c2i, c2j, k2, false), place(c2i, c2j, n2, false), place(c1i, c1j, n1, false)];
      facing(q[0]!, q[1]!, q[2]!, towards);
      facing(q[0]!, q[2]!, q[3]!, towards);
    };
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        if (i + 1 < cols) wall(k, k + 1, [i + 1, j], [i + 1, j + 1]); // east neighbour
        if (j + 1 < rows) wall(k, k + cols, [i, j + 1], [i + 1, j + 1]); // south neighbour
      }
  }

  const skirtStart = pos.length / 3;
  if (opts.skirtM) {
    // Around the outside: each edge cell's own corner heights, and the same 3 m lower.
    const edges: [number, [number, number], [number, number]][] = [];
    for (let i = 0; i < cols; i++) edges.push([i, [i, 0], [i + 1, 0]], [(rows - 1) * cols + i, [i, rows], [i + 1, rows]]);
    for (let j = 0; j < rows; j++) edges.push([j * cols, [0, j], [0, j + 1]], [j * cols + cols - 1, [cols, j], [cols, j + 1]]);
    for (const [k, [ai, aj], [bi, bj]] of edges) {
      const ha = cornerHeight(k, ai, aj), hb = cornerHeight(k, bi, bj), wet = !!water[k];
      const t0 = place(ai, aj, ha, wet), t1 = place(bi, bj, hb, wet), l0 = place(ai, aj, ha - opts.skirtM, wet), l1 = place(bi, bj, hb - opts.skirtM, wet);
      idx.push(t0, l0, t1, t1, l0, l1, t0, t1, l0, t1, l1, l0); // both faces
    }
  }

  return { positions: Float32Array.from(pos), colors: Float32Array.from(col), uvs: Float32Array.from(uv), indices: Uint32Array.from(idx), skirtStart };
}

/** RMS distance (in z) of points (x, y, z) from their least-squares plane; Infinity when they're collinear. */
export function planeResidual(pts: [number, number, number][]): number {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0;
  for (const [x, y, z] of pts) {
    n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sz += z; sxz += x * z; syz += y * z;
  }
  // Normal equations [n sx sy; sx sxx sxy; sy sxy syy] · [a b c] = [sz sxz syz], by Cramer's rule.
  const det = n * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy);
  if (Math.abs(det) < 1e-9) return Infinity;
  const a = (sz * (sxx * syy - sxy * sxy) - sx * (sxz * syy - sxy * syz) + sy * (sxz * sxy - sxx * syz)) / det;
  const b = (n * (sxz * syy - syz * sxy) - sz * (sx * syy - sxy * sy) + sy * (sx * syz - sxz * sy)) / det;
  const c = (n * (sxx * syz - sxy * sxz) - sx * (sx * syz - sxz * sy) + sz * (sx * sxy - sxx * sy)) / det;
  let ss = 0;
  for (const [x, y, z] of pts) ss += (z - (a + b * x + c * y)) ** 2;
  return Math.sqrt(ss / n);
}
