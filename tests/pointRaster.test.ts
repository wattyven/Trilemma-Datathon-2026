import { describe, expect, it } from 'vitest';
import { patchSurface } from '../src/elevation/build';
import { addPoint, createPointGrid, fillHoles, median, Reservoir } from '../src/elevation/pointRaster';
import { fromPixel, type PixelWindow } from '../src/elevation/window';

const W: PixelWindow = { crs: 'EPSG:3157', col0: 0, row0: 0, width: 20, height: 20, x0: 490_000, y0: 5_455_010, res: 0.5 };
const ALL = { c0: 0, r0: 0, c1: 20, r1: 20 };

describe('point rasterization', () => {
  it('keeps the highest return per cell and ignores points outside the region', () => {
    const g = createPointGrid(20, 20);
    addPoint(g, ALL, 3.2, 4.9, 10);
    addPoint(g, ALL, 3.7, 4.1, 12);
    addPoint(g, ALL, 3.5, 4.5, 11);
    addPoint(g, { c0: 0, r0: 0, c1: 2, r1: 2 }, 3.5, 4.5, 99);
    expect(g.zmax[4 * 20 + 3]).toBe(12);
    expect(g.points).toBe(3);
    expect(Number.isNaN(g.zmax[0]!)).toBe(true);
  });

  it('fills isolated holes from their neighbours but leaves big gaps', () => {
    const g = createPointGrid(20, 20);
    for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) if (!(r === 5 && c === 5) && !(r >= 12 && c >= 12)) g.zmax[r * 20 + c] = 7;
    const filled = fillHoles(g, ALL, 1);
    expect(g.zmax[5 * 20 + 5]).toBe(7);
    expect(Number.isNaN(g.zmax[16 * 20 + 16]!)).toBe(true); // 8 × 8 gap: only its rim fills
    expect(filled).toBeGreaterThan(1);
  });

  it('takes medians and samples evenly', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2, NaN])).toBe(2.5);
    expect(median([])).toBeNull();
    const r = new Reservoir<number>(10);
    for (let i = 0; i < 1000; i++) r.add(i);
    expect(r.items.length).toBe(10);
    expect(Math.max(...r.items)).toBeGreaterThan(100); // not just the first ten
  });
});

describe('patching a point surface onto HRDEM', () => {
  const n = W.width * W.height;
  it('removes the vertical datum offset measured on ground points', () => {
    const base = { dsm: new Float32Array(n).fill(20), dtm: new Float32Array(n).fill(20) };
    const patch = new Float32Array(n).fill(20.4); // same ground, heights 0.4 m high
    patch[10 * 20 + 10] = 26.4; // a post
    const ground: [number, number, number][] = [];
    for (let i = 0; i < 100; i++) {
      const [x, y] = fromPixel(W, [2 + (i % 16), 2 + Math.floor(i / 16)]);
      ground.push([x, y, 20.4 + (i % 3 === 0 ? 0.02 : -0.02)]);
    }
    const s = patchSurface(W, base, patch, ALL, ground);
    expect(s.datumFrom).toBe('ground');
    expect(s.datumOffsetM).toBeCloseTo(0.4, 1);
    expect(base.dsm[0]).toBeCloseTo(20, 1);
    expect(base.dsm[10 * 20 + 10]).toBeCloseTo(26, 1);
  });

  it('falls back to the surface median without ground points, and rejects sparse patches', () => {
    const base = { dsm: new Float32Array(n).fill(5), dtm: new Float32Array(n).fill(5) };
    const patch = new Float32Array(n).fill(4.5);
    expect(patchSurface(W, base, patch, ALL, []).datumFrom).toBe('surface');
    expect(base.dsm[7]).toBeCloseTo(5, 5);
    const sparse = new Float32Array(n).fill(NaN);
    sparse.fill(5, 0, 50);
    expect(() => patchSurface(W, { dsm: new Float32Array(n).fill(5), dtm: new Float32Array(n).fill(5) }, sparse, ALL, [])).toThrow(/covers only/);
  });
});

describe('how much of the point cloud to read', () => {
  it('reads the levels that give the most density per point read', async () => {
    const { levelsForDensity } = await import('../src/elevation/copc');
    // Real level densities from a FHIMP 2023 tile under a 200 m box: shallow levels are a few huge nodes.
    const level = (depth: number, size: number, nodes: number, ptsPerNode: number) =>
      Array.from({ length: nodes }, () => ({ depth, size, points: ptsPerNode }));
    const nodes = [
      ...level(0, 1000, 1, 49_000), // 0.05 pts/m²
      ...level(1, 500, 1, 132_000), // 0.53
      ...level(2, 250, 4, 102_000), // 1.6
      ...level(3, 125, 9, 71_000), // 4.5
      ...level(4, 62.5, 16, 24_000), // 6.1
      ...level(5, 31.25, 49, 6_000), // 6.1
    ];
    expect([...levelsForDensity(nodes, 8)].sort()).toEqual([4, 5]);
    expect([...levelsForDensity(nodes, 100)].sort()).toEqual([0, 1, 2, 3, 4, 5]); // never reached: read everything
  });

  it('shrinks the margin around big lots to cap the area read', async () => {
    const { refineMargin } = await import('../src/elevation/build');
    const box = (w: number, h: number) => ({ minX: 0, minY: 0, maxX: w, maxY: h });
    expect(refineMargin(box(15, 40))).toBe(60); // 135 × 160 m = 21 600 m²
    const m = refineMargin(box(100, 100));
    expect(m).toBe(50); // 200 × 200 m = 40 000 m²
    expect(refineMargin(box(300, 300))).toBe(20); // never below the minimum
  });
});

describe('spike removal', () => {
  const W2 = 12, ALL2 = { c0: 0, r0: 0, c1: 12, r1: 12 };
  const flat = () => new Float32Array(W2 * W2).fill(10);
  it('removes a wire and a pole', async () => {
    const { removeSpikes } = await import('../src/elevation/pointRaster');
    const z = flat();
    for (let c = 0; c < W2; c++) z[5 * W2 + c] = 18; // a wire across the grid
    z[9 * W2 + 9] = 20; // a pole
    expect(removeSpikes(z, W2, W2, ALL2, 2.5)).toBeGreaterThan(W2 - 2);
    expect(Math.max(...z)).toBeCloseTo(10, 5);
  });

  it('keeps roof edges, a 2 × 2 chimney and NaN cells', async () => {
    const { removeSpikes } = await import('../src/elevation/pointRaster');
    const z = flat();
    for (let r = 0; r < W2; r++) for (let c = 6; c < W2; c++) z[r * W2 + c] = 20; // a roof
    z[2 * W2 + 2] = z[2 * W2 + 3] = z[3 * W2 + 2] = z[3 * W2 + 3] = 14; // chimney
    z[8 * W2 + 2] = NaN;
    const before = z.slice();
    expect(removeSpikes(z, W2, W2, ALL2, 2.5)).toBe(0);
    expect(Array.from(z)).toEqual(Array.from(before));
  });
});
