// The engine works in metres whatever the grid's pixel size: a 0.5 m point-cloud grid must give the
// same shadows as a 1 m one, and grids in UTM 10N carry their own (small) convergence.
import { describe, expect, it } from 'vitest';
import { alignedWindow } from '../src/elevation/window';
import { computeHorizons } from '../src/engine/horizon';
import { momentMask, prepareSamples } from '../src/engine/outputs';
import { momentSample } from '../src/engine/sun';
import { convergenceDeg } from '../src/geo/proj';
import { flatRaster, PARAMS } from './helpers/synthetic';
import pointsJson from './fixtures/points.json';

const points = pointsJson as unknown as Record<string, [number, number]>;

/** Box shadow length (metres) on a grid with `res` m pixels; box is 4 m × 4 m × 10 m. */
function shadowLength(res: number, sun: { altDeg: number; azTrueDeg: number; time: number; weightH: number }) {
  const W = Math.round(60 / res), half = W / 2, b = Math.round(2 / res); // the shadow is ~14 m long
  const dsm = flatRaster(W, W, 0);
  for (let y = half - b; y < half + b; y++) for (let x = half - b; x < half + b; x++) dsm.data[y * W + x] = 10;
  const px: number[] = [], py: number[] = [];
  const stride = Math.max(1, Math.round(1 / res)); // cells every metre: this tests DSM detail, not cell density
  for (let y = 2; y < W - 2; y += stride) for (let x = 2; x < W - 2; x += stride) {
    if (x >= half - b && x < half + b && y >= half - b && y < half + b) continue;
    px.push(x + 0.5);
    py.push(y + 0.5);
  }
  const n = px.length;
  const h = new Float32Array(n * PARAMS.sectors);
  computeHorizons({ dsm, px: Float32Array.from(px), py: Float32Array.from(py), z0: new Float32Array(n), count: n, res }, PARAMS, h);
  const lit = momentMask({ data: h, count: n, sectors: PARAMS.sectors }, prepareSamples([sun], 0, PARAMS.sectors)[0]!);
  const a = (sun.azTrueDeg * Math.PI) / 180, away = [-Math.sin(a), Math.cos(a)];
  // Distance (m) from the box's full-height top corner (pixel centres) to the farthest shaded cell.
  const topEdge = Math.max(...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => (sx! * (b - 0.5) * away[0]! + sy! * (b - 0.5) * away[1]!) * res));
  let tip = -Infinity;
  for (let i = 0; i < n; i++) if (!lit[i]) tip = Math.max(tip, ((px[i]! - half) * away[0]! + (py[i]! - half) * away[1]!) * res);
  return tip - topEdge;
}

// The 0.5 m case marches ~4× the rays: give slow CI runners room.
describe('grid resolution', { timeout: 30_000 }, () => {
  const sun = momentSample({ year: 2026, month: 3, day: 20 }, 15 * 60, 49.2613, -123.1139);
  const expected = 10 / Math.tan((sun.altDeg * Math.PI) / 180);
  const lengths = new Map<number, number>();
  const length = (res: number) => lengths.get(res) ?? lengths.set(res, shadowLength(res, sun)).get(res)!;

  it.each([1, 0.5])('casts a 10 / tan(alt) shadow in metres on a %s m grid (within 1 m)', (res) => {
    expect(Math.abs(length(res) - expected)).toBeLessThanOrEqual(1);
  });

  it('a 0.5 m grid is at least as close to the exact length as a 1 m grid (within half a metre)', () => {
    expect(Math.abs(length(0.5) - expected)).toBeLessThanOrEqual(Math.abs(length(1) - expected) + 0.5);
  });
});

describe('UTM 10N grids', () => {
  it('have a small convergence at Vancouver (and EPSG:3979 a large one)', () => {
    const g = convergenceDeg(points.van!, 'EPSG:3157');
    expect(Math.abs(g)).toBeLessThan(0.3);
    expect(convergenceDeg(points.van!, 'EPSG:3979')).toBeGreaterThan(24.8);
  });

  it('snap windows to the pixel size', () => {
    const w = alignedWindow({ minX: 491_234.3, minY: 5_456_101.9, maxX: 491_290.1, maxY: 5_456_150.2 }, 200, 0.5, 'EPSG:3157');
    expect(w.crs).toBe('EPSG:3157');
    expect(w.x0).toBe(491_034);
    expect(w.y0).toBe(5_456_350.5);
    expect(w.width).toBe((491_490.5 - 491_034) / 0.5);
    expect(w.height).toBe((5_456_350.5 - 5_455_901.5) / 0.5);
  });
});
