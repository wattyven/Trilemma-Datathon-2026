// SunCalc wrapper. Also the time-zone golden values: these must hold identically
// under TZ=UTC and TZ=Asia/Tokyo (`npm run test:tz`).
import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  dateRange,
  daySamples,
  formatLocal,
  momentSample,
  sunPosition,
  sunTimes,
  todayInVancouver,
  vancouver,
} from '../src/engine/sun';

const LAT = 49.25;
const LON = -123.1;

describe('solar noon at Vancouver (49.25°N)', () => {
  it.each([
    ['June solstice', { year: 2026, month: 6, day: 21 }, 64],
    ['March equinox', { year: 2026, month: 3, day: 20 }, 41],
    ['December solstice', { year: 2026, month: 12, day: 21 }, 17],
  ])('%s: altitude ≈ %s°, azimuth ≈ 180° from north', (_name, date, alt) => {
    const t = sunTimes(date, LAT, LON);
    const p = sunPosition(t.solarNoon, LAT, LON);
    expect(Math.abs(p.altDeg - (alt as number))).toBeLessThan(1);
    expect(Math.abs(p.azTrueDeg - 180)).toBeLessThan(1);
  });

  it('measures azimuth clockwise from true north (SunCalc 2), so summer sunrise is in the north-east', () => {
    const s = daySamples({ year: 2026, month: 6, day: 21 }, LAT, LON, 10);
    expect(s[0]!.azTrueDeg).toBeGreaterThan(30);
    expect(s[0]!.azTrueDeg).toBeLessThan(70);
    expect(s.at(-1)!.azTrueDeg).toBeGreaterThan(290);
  });
});

describe('time-zone golden values (identical in any process TZ)', () => {
  it.each([
    [{ year: 2026, month: 6, day: 21 }, '05:06', '21:21', '13:14'],
    [{ year: 2026, month: 12, day: 21 }, '08:05', '16:16', '12:10'],
    [{ year: 2026, month: 3, day: 8 }, '07:40', '19:06', '13:23'], // DST starts at 02:00 that day, so PDT
  ])('%o sunrise/sunset/noon in Vancouver local time', (date, rise, set, noon) => {
    const t = sunTimes(date, LAT, LON);
    expect([formatLocal(t.sunrise!), formatLocal(t.sunset!), formatLocal(t.solarNoon)]).toEqual([rise, set, noon]);
  });

  it('builds local times in America/Vancouver, not the process zone', () => {
    expect(vancouver({ year: 2026, month: 1, day: 15 }, 9 * 60).toUTC().toISO()).toBe('2026-01-15T17:00:00.000Z');
    expect(vancouver({ year: 2026, month: 7, day: 15 }, 9 * 60).toUTC().toISO()).toBe('2026-07-15T16:00:00.000Z');
    expect(new Date(momentSample({ year: 2026, month: 7, day: 15 }, 9 * 60, LAT, LON).time).toISOString()).toBe('2026-07-15T16:00:00.000Z');
  });

  it("knows Vancouver's date at a UTC instant", () => {
    expect(todayInVancouver(new Date('2026-07-01T06:00:00Z'))).toEqual({ year: 2026, month: 6, day: 30 });
  });
});

describe('day sampling', () => {
  const june = { year: 2026, month: 6, day: 21 };

  it('weights add up to the sunrise–sunset span', () => {
    const t = sunTimes(june, LAT, LON);
    const hours = daySamples(june, LAT, LON, 10).reduce((a, s) => a + s.weightH, 0);
    expect(hours).toBeCloseTo((t.sunset!.getTime() - t.sunrise!.getTime()) / 3_600_000, 9);
  });

  it('clips to a daily window', () => {
    const s = daySamples(june, LAT, LON, 15, { fromMin: 13 * 60, toMin: 18 * 60 });
    expect(s.reduce((a, x) => a + x.weightH, 0)).toBeCloseTo(5, 9);
    expect(formatLocal(s[0]!.time)).toBe('13:07');
  });

  it('returns nothing when the window is after sunset', () => {
    expect(daySamples({ year: 2026, month: 12, day: 21 }, LAT, LON, 15, { fromMin: 18 * 60, toMin: 22 * 60 })).toEqual([]);
  });
});

describe('date ranges and presets', () => {
  it('steps every N days inclusive', () => {
    const r = PRESETS.growing(2026);
    const days = dateRange(r.start, r.end, 7);
    expect(days[0]).toEqual({ year: 2026, month: 4, day: 1 });
    expect(days).toHaveLength(27); // 183 days
    expect(dateRange(r.start, r.end, 1)).toHaveLength(183);
  });

  it('winter runs into next year and respects leap years', () => {
    expect(PRESETS.winter(2026)).toEqual({ start: { year: 2026, month: 12, day: 1 }, end: { year: 2027, month: 2, day: 28 } });
    expect(PRESETS.winter(2027).end).toEqual({ year: 2028, month: 2, day: 29 });
  });

  it('crosses DST without losing or doubling a day', () => {
    const days = dateRange({ year: 2026, month: 3, day: 6 }, { year: 2026, month: 3, day: 10 });
    expect(days.map((d) => d.day)).toEqual([6, 7, 8, 9, 10]);
  });
});
