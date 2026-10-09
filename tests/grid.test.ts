import { describe, expect, it } from 'vitest';
import { bilinear, maxValue, NoLidarError, nodataFraction, selectCells, withObserver, type Raster } from '../src/engine/grid';
import type { Ring } from '../src/geo/polygon';
import { flatRaster } from './helpers/synthetic';

const square = (x0: number, y0: number, s: number): Ring[][] => [[[[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]]]];
const opts = { cap: 20_000, observer: { mode: 'ground' as const, heightM: 0.3 }, coveredM: 2, lotNodataMax: 0.5 };

describe('bilinear', () => {
  const r: Raster = { width: 2, height: 2, data: Float32Array.of(0, 10, 20, 30) };

  it('is exact at pixel centres and interpolates between them', () => {
    expect(bilinear(r, 0.5, 0.5)).toBe(0);
    expect(bilinear(r, 1.5, 1.5)).toBe(30);
    expect(bilinear(r, 1, 1)).toBe(15);
    expect(bilinear(r, 1, 0.5)).toBe(5);
  });

  it('returns NaN outside the centres and next to nodata', () => {
    expect(bilinear(r, 0.2, 0.5)).toBeNaN();
    expect(bilinear(r, 1.6, 1)).toBeNaN();
    const holed: Raster = { width: 2, height: 2, data: Float32Array.of(0, NaN, 20, 30) };
    expect(bilinear(holed, 1, 1)).toBeNaN();
    expect(bilinear(holed, 0.5, 1.5)).toBe(20); // exactly on a valid centre still fine
  });

  it('summarises nodata and the maximum', () => {
    const r2: Raster = { width: 2, height: 2, data: Float32Array.of(1, NaN, 5, NaN) };
    expect(nodataFraction(r2)).toBe(0.5);
    expect(maxValue(r2)).toBe(5);
  });
});

describe('selectCells', () => {
  const dtm = flatRaster(40, 40, 10);
  const dsm = flatRaster(40, 40, 10);
  for (let y = 12; y < 15; y++) for (let x = 12; x < 15; x++) dsm.data[y * 40 + x] = 18; // a shed roof

  it('takes pixel centres inside the lot only', () => {
    const c = selectCells(dsm, dtm, square(10, 10, 10), opts);
    expect(c.count).toBe(100);
    expect(c.step).toBe(1);
    expect(Math.min(...c.px)).toBe(10.5);
    expect(Math.max(...c.px)).toBe(19.5);
  });

  it('marks covered cells and sets observer heights', () => {
    const c = selectCells(dsm, dtm, square(10, 10, 10), opts);
    expect(c.covered.reduce((a, v) => a + v, 0)).toBe(9);
    expect(c.z0[0]).toBeCloseTo(10.3, 5); // ground + 0.3 m
    const roof = selectCells(dsm, dtm, square(10, 10, 10), { ...opts, observer: { mode: 'surface', heightM: 0.1 } });
    const i = Array.from(roof.covered).indexOf(1);
    expect(roof.z0[i]).toBeCloseTo(18.1, 5); // surface + 0.1 m
    expect(withObserver(roof, { mode: 'ground', heightM: 1.2 }).z0[i]).toBeCloseTo(11.2, 5);
  });

  it('coarsens big lots to stay under the cap', () => {
    const big = flatRaster(400, 400, 0);
    const c = selectCells(big, big, square(0, 0, 400), { ...opts, cap: 20_000 });
    expect(c.step).toBe(3); // ⌈√(160000 / 20000)⌉
    expect(c.count).toBeLessThanOrEqual(20_000);
    expect(c.px[0]).toBe(1.5);
  });

  it('drops a few nodata cells but refuses a lot that is mostly nodata', () => {
    const holed: Raster = { ...dsm, data: dsm.data.slice() };
    for (let x = 10; x < 20; x++) holed.data[10 * 40 + x] = NaN; // one row of the lot
    const c = selectCells(holed, dtm, square(10, 10, 10), opts);
    expect(c.dropped).toBeGreaterThan(0);
    expect(c.count).toBe(c.candidates - c.dropped);

    const empty: Raster = { ...dsm, data: new Float32Array(1600).fill(NaN) };
    expect(() => selectCells(empty, dtm, square(10, 10, 10), opts)).toThrow(NoLidarError);
  });

  it('refuses a lot that covers no pixel centre', () => {
    expect(() => selectCells(dsm, dtm, square(10.6, 10.6, 0.2), opts)).toThrow(NoLidarError);
  });
});
