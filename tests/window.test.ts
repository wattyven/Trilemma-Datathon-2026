import { describe, expect, it } from 'vitest';
import { bboxOf, fromPixel, lotWindow, ringsToPixel, TileEdgeError, toPixel, type TileGrid } from '../src/elevation/window';
import { applyAffine, gridToLocalAffine, invertAffine } from '../src/geo/gridAffine';
import { localFrame } from '../src/geo/local';
import { convergenceDeg, fromLcc, toLcc } from '../src/geo/proj';
import pointsJson from './fixtures/points.json';

const TILE: TileGrid = { originX: -2_000_000, originY: 500_000, res: 1, width: 500_000, height: 500_000 };

describe('lotWindow', () => {
  it('adds the buffer and snaps outward to whole pixels', () => {
    const w = lotWindow({ minX: -1_978_400.4, minY: 473_500.2, maxX: -1_978_350.7, maxY: 473_560.9 }, 200, TILE);
    expect(w.x0).toBe(-1_978_601);
    expect(w.y0).toBe(473_761);
    expect(w.width).toBe(-1_978_150 - -1_978_601);
    expect(w.height).toBe(473_761 - 473_300);
    expect(Number.isInteger(w.col0) && Number.isInteger(w.row0)).toBe(true);
    expect(w.col0).toBe(w.x0 - TILE.originX);
  });

  it('refuses windows that cross the tile edge', () => {
    expect(() => lotWindow({ minX: -1_999_900, minY: 300_000, maxX: -1_999_850, maxY: 300_050 }, 200, TILE)).toThrow(TileEdgeError);
    expect(() => lotWindow({ minX: -1_900_000, minY: 499_850, maxX: -1_899_950, maxY: 499_900 }, 200, TILE)).toThrow(TileEdgeError);
  });

  it('round-trips pixel coordinates (y flips: grid north is −py)', () => {
    const w = lotWindow({ minX: -1_978_400, minY: 473_500, maxX: -1_978_350, maxY: 473_560 }, 10, TILE);
    expect(toPixel(w, [w.x0 + 3.5, w.y0 - 2.5])).toEqual([3.5, 2.5]);
    expect(fromPixel(w, [3.5, 2.5])).toEqual([w.x0 + 3.5, w.y0 - 2.5]);
    const px = ringsToPixel(w, [[[[w.x0, w.y0], [w.x0 + 1, w.y0 - 1]]]]);
    expect(px[0]![0]).toEqual([[0, 0], [1, 1]]);
    expect(bboxOf([[[[1, 2], [3, -4], [0, 0]]]])).toEqual({ minX: 0, minY: -4, maxX: 3, maxY: 2 });
  });
});

describe('grid → local affine', () => {
  const van = pointsJson.van as [number, number];
  const [cx, cy] = toLcc(van);
  const w = lotWindow({ minX: cx - 20, minY: cy - 20, maxX: cx + 20, maxY: cy + 20 }, 200, TILE);
  const frame = localFrame(van);
  const a = gridToLocalAffine(w, frame);
  const gamma = convergenceDeg(van);
  const bearing = ([x, y]: [number, number]) => (Math.atan2(x, y) * 180) / Math.PI;

  it('turns grid east into true bearing 90° − γ, and grid south into 180° − γ', () => {
    expect(bearing(a.col)).toBeCloseTo(90 - gamma, 1);
    expect(bearing(a.row)).toBeCloseTo(180 - gamma, 1);
    // A 1 m EPSG:3979 pixel is ~1.001 m on the ground here: the Lambert scale factor at 49.26°N,
    // just inside the 49° standard parallel, is ~0.999.
    expect(Math.hypot(...a.col)).toBeGreaterThan(1.0005);
    expect(Math.hypot(...a.col)).toBeLessThan(1.0015);
  });

  it('agrees with proj4 at an arbitrary pixel and inverts', () => {
    const p: [number, number] = [123.4, 210.9];
    const exact = frame.toLocal(fromLcc(fromPixel(w, p)));
    const viaAffine = applyAffine(a, p);
    expect(Math.hypot(exact[0] - viaAffine[0], exact[1] - viaAffine[1])).toBeLessThan(0.02);
    const back = invertAffine(a, viaAffine);
    expect(back[0]).toBeCloseTo(p[0], 6);
    expect(back[1]).toBeCloseTo(p[1], 6);
  });
});
