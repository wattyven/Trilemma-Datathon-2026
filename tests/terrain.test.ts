import { describe, expect, it } from 'vitest';
import { applyAffine, type GridAffine } from '../src/geo/gridAffine';
import { baseLevel, buildGrid, innerRect, type TerrainInput } from '../src/scene/terrain';
import { meshSteps } from '../src/scene/view3d';

// A window rotated 25° like EPSG:3979 at Vancouver: +1 px column = 1 m at bearing 65°, +1 px row = bearing 155°.
const g = (25 * Math.PI) / 180;
const AFFINE: GridAffine = { origin: [-20, 20], col: [Math.cos(g), -Math.sin(g)], row: [-Math.sin(g), -Math.cos(g)] };
const W = 40, H = 32;
const dsm = new Float32Array(W * H).fill(105);
const dtm = new Float32Array(W * H).fill(100);
dsm[5 * W + 5] = NaN; // water
const input: TerrainInput = { width: W, height: H, dsm, dtm, affine: AFFINE, base: 100 };
const COLORS = { ground: [1, 0, 0] as [number, number, number], water: [0, 0, 1] as [number, number, number] };

describe('buildGrid', () => {
  const rect = { c0: 8, r0: 8, c1: 16, r1: 16 };
  const m = buildGrid(input, rect, 1, COLORS);

  it('puts vertices on pixel centres through the grid → local affine (north = −Z)', () => {
    expect(m.positions.length / 3).toBe(9 * 9);
    const [ex, ey] = applyAffine(AFFINE, [8.5, 8.5]);
    expect(m.positions[0]).toBeCloseTo(ex, 5);
    expect(m.positions[1]).toBeCloseTo(5, 5); // 105 − base
    expect(m.positions[2]).toBeCloseTo(-ey, 5);
  });

  it('maps UVs to grid pixels', () => {
    expect(m.uvs[0]).toBeCloseTo(8.5 / W, 6);
    expect(m.uvs[1]).toBeCloseTo(8.5 / H, 6);
  });

  it('winds triangles so normals point up', () => {
    const p = (v: number) => [m.positions[3 * v]!, m.positions[3 * v + 1]!, m.positions[3 * v + 2]!];
    const [a, b, c] = [p(m.indices[0]!), p(m.indices[1]!), p(m.indices[2]!)];
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const ny = u[2]! * v[0]! - u[0]! * v[2]!;
    expect(ny).toBeGreaterThan(0);
  });

  it('colours land one neutral tone, water blue, and puts water at base level', () => {
    expect(Array.from(m.colors.slice(0, 3))).toEqual([1, 0, 0]);
    const w = buildGrid(input, { c0: 5, r0: 5, c1: 6, r1: 6 }, 1, COLORS);
    expect(Array.from(w.colors.slice(0, 3))).toEqual([0, 0, 1]);
    expect(w.positions[1]).toBeCloseTo(0, 6);
  });

  it('leaves a hole for the inner mesh and adds a skirt with its own vertices', () => {
    const inner = { c0: 8, r0: 8, c1: 16, r1: 16 };
    const outer = buildGrid(input, { c0: 0, r0: 0, c1: 36, r1: 28 }, 4, COLORS, { hole: inner });
    const full = buildGrid(input, { c0: 0, r0: 0, c1: 36, r1: 28 }, 4, COLORS);
    expect(full.indices.length - outer.indices.length).toBe(4 * 6); // 2 × 2 quads of 4 m removed
    const skirted = buildGrid(input, inner, 1, COLORS, { skirtM: 3 });
    expect(skirted.skirtStart).toBe(81);
    expect(skirted.positions.length / 3).toBeGreaterThan(81);
    // Skirt bottoms sit 3 m below the surface.
    const ys = Array.from(skirted.positions.filter((_, i) => i % 3 === 1).slice(81));
    expect(Math.min(...ys)).toBeCloseTo(2, 5);
  });
});

describe('innerRect and baseLevel', () => {
  it('snaps outward to the outer grid and stays inside the window', () => {
    expect(innerRect({ c0: 10, r0: 9, c1: 13, r1: 14 }, 3, 4, W, H)).toEqual({ c0: 4, r0: 4, c1: 16, r1: 20 });
    const edge = innerRect({ c0: 1, r0: 1, c1: 39, r1: 31 }, 40, 4, W, H);
    expect(edge).toEqual({ c0: 0, r0: 0, c1: 36, r1: 28 });
  });

  it('uses the 5th percentile, ignoring nodata', () => {
    const v = Float32Array.from([...Array.from({ length: 100 }, (_, i) => i), NaN]);
    expect(baseLevel(v)).toBe(5);
  });
});

describe('mesh spacing follows the grid resolution', () => {
  it('keeps 1 m grids as before and densifies 0.5 m grids near the lot', () => {
    expect(meshSteps({ c0: 200, r0: 200, c1: 240, r1: 240 }, 1)).toEqual({ innerStep: 1, outerStep: 4, marginPx: 40 });
    expect(meshSteps({ c0: 400, r0: 400, c1: 480, r1: 480 }, 0.5)).toEqual({ innerStep: 1, outerStep: 8, marginPx: 80 });
    // A 300 m lot at 0.5 m would need ~580k vertices at native resolution: step to 1 m.
    expect(meshSteps({ c0: 0, r0: 0, c1: 600, r1: 600 }, 0.5).innerStep).toBe(2);
  });
});

describe('buildTerraced (vertical walls)', async () => {
  const { buildTerraced } = await import('../src/scene/terrain');
  const N = 6; // 6 × 6 pixels, north-up 1 m grid
  const NORTH_UP: GridAffine = { origin: [0, 0], col: [1, 0], row: [0, -1] };
  const make = (f: (c: number, r: number) => number) => {
    const z = new Float32Array(N * N);
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) z[r * N + c] = f(c, r);
    return { width: N, height: N, dsm: z, dtm: z, affine: NORTH_UP, base: 100 } satisfies TerrainInput;
  };
  const RECT = { c0: 1, r0: 1, c1: 4, r1: 4 }; // cells 1..4 inclusive: 4 × 4 cells
  const vertexCount = (m: { positions: Float32Array }) => m.positions.length / 3;

  it('shares corners on flat ground: one vertex per corner, no walls', () => {
    const m = buildTerraced(make(() => 105), RECT, 1, COLORS, { wallM: 2 });
    expect(vertexCount(m)).toBe(25);
    expect(m.indices.length).toBe(16 * 6);
    // Corners sit on pixel edges: the first at (1, 1) → x = 1, z = 1 (north = −Z, row 1 is 1 m south).
    expect([m.positions[0], m.positions[1], m.positions[2]]).toEqual([1, 5, 1]);
    expect(m.uvs[0]).toBeCloseTo(1 / N, 6);
    expect(m.uvs[1]).toBeCloseTo(1 / N, 6);
  });

  it('gives a building vertical walls that face outwards', () => {
    const M = 10, BIG = { c0: 1, r0: 1, c1: 8, r1: 8 }; // 8 × 8 cells around a 4 × 4 m building
    const z = new Float32Array(M * M);
    for (let r = 0; r < M; r++) for (let c = 0; c < M; c++) z[r * M + c] = c >= 3 && c <= 6 && r >= 3 && r <= 6 ? 115 : 105;
    const m = buildTerraced({ width: M, height: M, dsm: z, dtm: z, affine: NORTH_UP, base: 100 }, BIG, 1, COLORS, { wallM: 2 });
    const tops = 64 * 6;
    expect((m.indices.length - tops) / 3).toBe(16 * 2); // 16 outer edges, one quad each
    const p = (v: number) => [m.positions[3 * v]!, m.positions[3 * v + 1]!, m.positions[3 * v + 2]!];
    for (let t = tops; t < m.indices.length; t += 3) {
      const [a, b, c] = [p(m.indices[t]!), p(m.indices[t + 1]!), p(m.indices[t + 2]!)];
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
      expect(Math.abs(n[1]!)).toBeLessThan(1e-9); // vertical
      // Outwards: away from the building's centre (x = 5, z = 5 in the scene).
      const mid = [(a[0]! + b[0]! + c[0]!) / 3, (a[2]! + b[2]! + c[2]!) / 3];
      expect(n[0]! * (mid[0]! - 5) + n[2]! * (mid[1]! - 5)).toBeGreaterThan(0);
    }
    // The roof stays flat at 15 m and the ground at 5 m (no ramps).
    const heights = new Set(Array.from(m.positions.filter((_, i) => i % 3 === 1)).map((y) => Math.round(y * 1000) / 1000));
    expect([...heights].sort((a, b) => a - b)).toEqual([5, 15]);
  });

  it('keeps tree crowns soft: rough cells blend instead of getting walls', () => {
    const M = 10, BIG = { c0: 1, r0: 1, c1: 8, r1: 8 };
    const z = new Float32Array(M * M);
    // A crown of irregular heights (114–120 m, like canopy returns) over flat ground.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let r = 0; r < M; r++) for (let c = 0; c < M; c++) z[r * M + c] = c >= 3 && c <= 6 && r >= 3 && r <= 6 ? 114 + 6 * rnd() : 105;
    const m = buildTerraced({ width: M, height: M, dsm: z, dtm: z, affine: NORTH_UP, base: 100 }, BIG, 1, COLORS, { wallM: 2 });
    const wallTris = (m.indices.length - 64 * 6) / 3;
    expect(wallTris).toBeLessThan(8); // a building this size gets 32
  });

  it('keeps gentle slopes smooth, puts water at base level and can leave walls out', () => {
    const slope = buildTerraced(make((c) => 100 + 0.5 * c), RECT, 1, COLORS, { wallM: 2 });
    expect(vertexCount(slope)).toBe(25);
    const wet = make(() => 105);
    wet.dsm[2 * N + 2] = NaN;
    const w = buildTerraced(wet, { c0: 2, r0: 2, c1: 2, r1: 2 }, 1, COLORS, { wallM: 2 });
    expect(Array.from(w.colors.slice(0, 3))).toEqual([0, 0, 1]);
    expect(w.positions[1]).toBe(0);
    const box = make((c, r) => (c === 2 && r === 2 ? 115 : 105));
    expect(buildTerraced(box, RECT, 1, COLORS, { wallM: 2, walls: false }).indices.length).toBe(16 * 6);
  });

  it('fits planes to roofs and ground but not to crowns', async () => {
    const { planeResidual } = await import('../src/scene/terrain');
    const roof: [number, number, number][] = [];
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) roof.push([x, y, 10 + 0.7 * x]); // a 35° pitch
    expect(planeResidual(roof)).toBeLessThan(1e-9);
    expect(planeResidual([[0, 0, 1], [1, 0, 4], [0, 1, 0], [1, 1, 1], [-1, 0, 3]])).toBeGreaterThan(0.5);
    expect(planeResidual([[0, 0, 1], [1, 0, 1], [2, 0, 1]])).toBe(Infinity); // collinear: a thin line
  });

  it('hangs a skirt with its own vertices around the edge', () => {
    const m = buildTerraced(make(() => 105), RECT, 1, COLORS, { wallM: 2, skirtM: 3 });
    expect(m.skirtStart).toBe(25);
    const ys = Array.from(m.positions.filter((_, i) => i % 3 === 1).slice(25));
    expect(Math.min(...ys)).toBeCloseTo(2, 5);
  });
});
