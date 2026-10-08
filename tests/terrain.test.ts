import { describe, expect, it } from 'vitest';
import { applyAffine, type GridAffine } from '../src/geo/gridAffine';
import { baseLevel, buildGrid, innerRect, type TerrainInput } from '../src/scene/terrain';

// A window rotated 25° like EPSG:3979 at Vancouver: +1 px column = 1 m at bearing 65°, +1 px row = bearing 155°.
const g = (25 * Math.PI) / 180;
const AFFINE: GridAffine = { origin: [-20, 20], col: [Math.cos(g), -Math.sin(g)], row: [-Math.sin(g), -Math.cos(g)] };
const W = 40, H = 32;
const dsm = new Float32Array(W * H).fill(105);
const dtm = new Float32Array(W * H).fill(100);
dsm[5 * W + 5] = NaN; // water
const input: TerrainInput = { width: W, height: H, dsm, dtm, affine: AFFINE, base: 100 };
const COLORS = { ground: [1, 0, 0] as [number, number, number], raised: [0, 1, 0] as [number, number, number], water: [0, 0, 1] as [number, number, number] };

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

  it('colours raised surfaces and water, and puts water at base level', () => {
    expect(Array.from(m.colors.slice(0, 3))).toEqual([0, 1, 0]); // DSM − DTM = 5 m: raised
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
