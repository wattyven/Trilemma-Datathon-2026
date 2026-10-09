import { describe, expect, it } from 'vitest';
import {
  CLASS_FULL,
  CLASS_PART,
  CLASS_SHADE,
  classify,
  inspectCell,
  momentMask,
  prepareSamples,
  seasonAverage,
  seasonAverages,
  shadeFinder,
  sunHours,
} from '../src/engine/outputs';
import { PRESETS, dateRange, daySamples, momentSample, type LocalDate } from '../src/engine/sun';
import { addBox, flatRaster, horizonsFor, regionCells, PARAMS } from './helpers/synthetic';

const LAT = 49.25, LON = -123.1, GAMMA = 25.3;
const prep = (d: LocalDate, step: number, window?: { fromMin: number; toMin: number }) =>
  prepareSamples(daySamples(d, LAT, LON, step, window), GAMMA, PARAMS.sectors);
const hoursOf = (s: { weightH: number }[]) => s.reduce((a, x) => a + x.weightH, 0);

// Open, flat ground: nothing ever blocks the sun.
const W = 60;
const open = flatRaster(W, W, 10);
const openCells = regionCells(open, 25, 25, 30, 30, 0.3);
const openH = horizonsFor(open, openCells);

// A 12 m wall along the south edge of a yard.
const yard = flatRaster(W, W, 10);
addBox(yard, 10, 40, 50, 43, 22);
const yardCells = regionCells(yard, 28, 34, 32, 38, 0.3); // just north of the wall
const yardH = horizonsFor(yard, yardCells);

describe('open ground', () => {
  const june = { year: 2026, month: 6, day: 21 };

  it('day: sun-hours equal the daylight hours', () => {
    const s = prep(june, 10);
    const h = sunHours(openH, s);
    const daylight = hoursOf(s.filter((x) => x.altDeg > 0));
    for (const v of h) expect(v).toBeCloseTo(daylight, 4); // Float32 accumulation
    expect(daylight).toBeGreaterThan(16);
  });

  it('season: average equals the mean daylight hours', () => {
    const { start, end } = PRESETS.growing(2026);
    const days = dateRange(start, end, 7).map((d) => prep(d, 15));
    const avg = seasonAverage(openH, days);
    const mean = days.reduce((a, s) => a + hoursOf(s.filter((x) => x.altDeg > 0)), 0) / days.length;
    for (const v of avg) expect(v).toBeCloseTo(mean, 4);
    expect(mean).toBeGreaterThan(13);
    expect(mean).toBeLessThan(15);
  });

  it('season with typical weather: each day weighted by its sunshine share; clear values unchanged', () => {
    const { start, end } = PRESETS.growing(2026);
    const dates = dateRange(start, end, 7);
    const days = dates.map((d) => prep(d, 15));
    const factors = dates.map((d) => (d.month < 7 ? 0.4 : 0.6));
    const { clear, typical } = seasonAverages(openH, days, factors);
    const expected = days.reduce((a, s, i) => a + hoursOf(s.filter((x) => x.altDeg > 0)) * factors[i]!, 0) / days.length;
    for (const v of typical!) expect(v).toBeCloseTo(expected, 3);
    expect(Array.from(clear)).toEqual(Array.from(seasonAverage(openH, days)));
    expect(seasonAverages(openH, days).typical).toBeUndefined();
  });

  it('shade finder: 0% shaded', () => {
    const samples = dateRange({ year: 2026, month: 6, day: 1 }, { year: 2026, month: 8, day: 31 }, 7).flatMap((d) =>
      prep(d, 15, { fromMin: 13 * 60, toMin: 18 * 60 }),
    );
    const r = shadeFinder(openH, samples, 14 * 5);
    for (const v of r.shadedPct) expect(v).toBe(0);
    expect(r.sunUpHours).toBeCloseTo(70, 5);
  });

  it('moment at night: all shaded', () => {
    const [s] = prepareSamples([momentSample({ year: 2026, month: 6, day: 21 }, 23 * 60 + 30, LAT, LON)], GAMMA, PARAMS.sectors);
    expect(Array.from(momentMask(openH, s!))).toEqual(new Array(openCells.count).fill(0));
  });
});

describe('north of a wall', () => {
  it('gets far less winter sun than summer sun', () => {
    const summer = sunHours(yardH, prep({ year: 2026, month: 6, day: 21 }, 10));
    const winter = sunHours(yardH, prep({ year: 2026, month: 12, day: 21 }, 10));
    for (let i = 0; i < yardCells.count; i++) expect(winter[i]!).toBeLessThan(summer[i]! - 4);
    expect(Math.max(...winter)).toBeLessThan(1); // the low winter sun never clears a 12 m wall 3–6 m away
  });

  it('shade finder reports shade where the wall blocks the sun', () => {
    const samples = prep({ year: 2026, month: 12, day: 21 }, 15, { fromMin: 11 * 60, toMin: 14 * 60 });
    const r = shadeFinder(yardH, samples, 3);
    for (const v of r.shadedPct) expect(v).toBeGreaterThan(95);
  });

  it('inspector: 12 monthly values (summer > winter) and a strip for the day', () => {
    const months = Array.from({ length: 12 }, (_, m) => [1, 15].map((day) => prep({ year: 2026, month: m + 1, day }, 30)));
    const day = prep({ year: 2026, month: 6, day: 21 }, 10);
    const r = inspectCell(yardH, 0, months, day);
    expect(r.monthlyHours).toHaveLength(12);
    expect(r.monthlyHours[5]!).toBeGreaterThan(r.monthlyHours[11]!);
    expect(r.strip).toHaveLength(day.length);
    expect(r.strip.some((x) => x.sunlit)).toBe(true);
  });
});

describe('classes and conversions', () => {
  it('uses 6 h / 3 h thresholds', () => {
    expect(Array.from(classify(Float32Array.of(0, 2.99, 3, 5.99, 6, 12)))).toEqual([
      CLASS_SHADE, CLASS_SHADE, CLASS_PART, CLASS_PART, CLASS_FULL, CLASS_FULL,
    ]);
    expect(Array.from(classify(Float32Array.of(4), { fullSunH: 4, partSunH: 2 }))).toEqual([CLASS_FULL]);
  });

  it('adds the grid convergence to the true azimuth', () => {
    const [s] = prepareSamples([{ time: 0, altDeg: 30, azTrueDeg: 180, weightH: 1 }], 25, 180);
    expect(s!.k0).toBe(102); // 205° / 2° per sector
    expect(s!.t).toBeCloseTo(0.5, 9);
  });
});
