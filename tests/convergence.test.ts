// put the synthetic box at Vancouver in EPSG:3979. The solar-noon shadow must point
// to TRUE north, which in the EPSG:3979 grid is rotated ~25° clockwise from grid north.
import { describe, expect, it } from 'vitest';
import { momentMask, prepareSamples } from '../src/engine/outputs';
import { sunPosition, sunTimes } from '../src/engine/sun';
import { convergenceDeg, fromLcc, toLcc } from '../src/geo/proj';
import { addBox, flatRaster, horizonsFor, regionCells, PARAMS } from './helpers/synthetic';
import pointsJson from './fixtures/points.json';

const W = 80;
const BOX = { c0: 37, r0: 37, c1: 43, r1: 43, height: 10 };

describe('grid convergence', () => {
  // Window around Vancouver City Hall, snapped to the 1 m mosaic grid.
  const [cx, cy] = toLcc(pointsJson.van as [number, number]);
  const x0 = Math.floor(cx) - W / 2, y0 = Math.floor(cy) + W / 2;
  const centre = fromLcc([x0 + W / 2, y0 - W / 2]);
  const gamma = convergenceDeg(centre);

  it('is about +25° at Vancouver, computed rather than assumed', () => {
    expect(gamma).toBeGreaterThan(24.8);
    expect(gamma).toBeLessThan(25.6);
  });

  it.each(Object.entries(pointsJson))('stays within Metro Vancouver range at %s', (_k, ll) => {
    const g = convergenceDeg(ll as [number, number]);
    expect(g).toBeGreaterThan(24.8);
    expect(g).toBeLessThan(25.6);
  });

  it('solar-noon shadow points to true north, not grid north', () => {
    const date = { year: 2026, month: 3, day: 20 };
    const [lon, lat] = centre;
    const noon = sunTimes(date, lat, lon).solarNoon;
    const p = sunPosition(noon, lat, lon);
    expect(Math.abs(p.azTrueDeg - 180)).toBeLessThan(0.5);

    const ground = flatRaster(W, W, 0);
    const dsm = flatRaster(W, W, 0);
    addBox(dsm, BOX.c0, BOX.r0, BOX.c1, BOX.r1, BOX.height);
    const inBox = (c: number, r: number) => c >= BOX.c0 && c < BOX.c1 && r >= BOX.r0 && r < BOX.r1;
    const cells = regionCells(ground, 1, 1, W - 1, W - 1, 0, inBox);
    const h = horizonsFor(dsm, cells);
    const [s] = prepareSamples([{ time: noon.getTime(), altDeg: p.altDeg, azTrueDeg: p.azTrueDeg, weightH: 0 }], gamma, PARAMS.sectors);
    const lit = momentMask(h, s!);

    // Centroid of the shadow relative to the box, as a grid bearing (clockwise from grid north = −y).
    const bx = (BOX.c0 + BOX.c1) / 2, by = (BOX.r0 + BOX.r1) / 2;
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < cells.count; i++) {
      if (lit[i]) continue;
      sx += cells.px[i]! - bx;
      sy += cells.py[i]! - by;
      n++;
    }
    expect(n).toBeGreaterThan(10);
    const bearing = (Math.atan2(sx / n, -(sy / n)) * 180) / Math.PI;
    expect(Math.abs(bearing - gamma)).toBeLessThan(3); // true north, in grid terms
    expect(Math.abs(bearing)).toBeGreaterThan(20); // and clearly not grid north
  });
});
