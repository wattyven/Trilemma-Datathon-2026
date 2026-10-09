// Flat ground with one 10 m box. The ground shadow is ≈ 10 / tan(alt) long (± one cell along
// the shadow) and points away from the sun. Grid aligned with true north here (γ = 0); see convergence.test.ts.
import { describe, expect, it } from 'vitest';
import { momentMask, prepareSamples } from '../src/engine/outputs';
import { momentSample } from '../src/engine/sun';
import { addBox, flatRaster, horizonsFor, regionCells, PARAMS } from './helpers/synthetic';

const W = 100;
const BOX = { c0: 48, r0: 48, c1: 52, r1: 52, height: 10 };
const inBox = (c: number, r: number) => c >= BOX.c0 && c < BOX.c1 && r >= BOX.r0 && r < BOX.r1;

describe.each([
  ['spring afternoon', { year: 2026, month: 3, day: 20 }, 15 * 60],
  ['summer morning', { year: 2026, month: 6, day: 21 }, 9 * 60 + 30],
  ['winter noon', { year: 2026, month: 12, day: 21 }, 12 * 60 + 10],
])('synthetic box shadow, %s', (_name, date, minute) => {
  const ground = flatRaster(W, W, 0);
  const dsm = flatRaster(W, W, 0);
  addBox(dsm, BOX.c0, BOX.r0, BOX.c1, BOX.r1, BOX.height);
  const cells = regionCells(ground, 2, 2, W - 2, W - 2, 0, inBox); // observer on the ground, h = 0
  const h = horizonsFor(dsm, cells);
  const sun = momentSample(date, minute, 49.2613, -123.1139); // Vancouver City Hall
  const [s] = prepareSamples([sun], 0, PARAMS.sectors);
  const lit = momentMask(h, s!);

  const a = (sun.azTrueDeg * Math.PI) / 180;
  const toSun: [number, number] = [Math.sin(a), -Math.cos(a)]; // pixel coords: grid north is −y
  const away: [number, number] = [-toSun[0], -toSun[1]];
  const cx = (BOX.c0 + BOX.c1) / 2, cy = (BOX.r0 + BOX.r1) / 2;
  const proj = (x: number, y: number, u: [number, number]) => (x - cx) * u[0] + (y - cy) * u[1];

  const shaded: number[] = [];
  for (let i = 0; i < cells.count; i++) if (!lit[i]) shaded.push(i);

  it('casts a shadow at all', () => {
    expect(sun.altDeg).toBeGreaterThan(10);
    expect(shaded.length).toBeGreaterThan(4);
  });

  // The DSM is sampled at pixel centres and interpolated bilinearly, so the box's
  // full 10 m top spans the centres of its outer pixels, not the pixel edges.
  const top = [[BOX.c0 + 0.5, BOX.r0 + 0.5], [BOX.c1 - 0.5, BOX.r0 + 0.5], [BOX.c0 + 0.5, BOX.r1 - 0.5], [BOX.c1 - 0.5, BOX.r1 - 0.5]] as const;

  it('is 10 / tan(alt) long, within one cell', () => {
    // The tip is the shadow of the box's top corner farthest from the sun. It's measured at cell
    // centres, so it can be off by one cell's width along the shadow (1 m, up to √2 m diagonally).
    const edge = Math.max(...top.map(([x, y]) => proj(x, y, away)));
    const tip = Math.max(...shaded.map((i) => proj(cells.px[i]!, cells.py[i]!, away)));
    const expected = BOX.height / Math.tan((sun.altDeg * Math.PI) / 180);
    expect(Math.abs(tip - edge - expected)).toBeLessThanOrEqual(Math.abs(away[0]) + Math.abs(away[1]));
  });

  it('points away from the sun', () => {
    // The shadow's centroid lies opposite the sun…
    const mx = shaded.reduce((a, i) => a + cells.px[i]! - cx, 0) / shaded.length;
    const my = shaded.reduce((a, i) => a + cells.py[i]! - cy, 0) / shaded.length;
    const cos = (mx * away[0] + my * away[1]) / Math.hypot(mx, my);
    expect(cos).toBeGreaterThan(Math.cos((10 * Math.PI) / 180));
    // …and nothing in front of the box's sun-facing side is shaded.
    const front = Math.max(...top.map(([x, y]) => proj(x, y, toSun)));
    for (const i of shaded) expect(proj(cells.px[i]!, cells.py[i]!, toSun)).toBeLessThan(front);
  });
});
