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
  // UTC instants, so the values don't depend on Vancouver's clock rules (which changed in 2026, below).
  const utcMinute = (d: Date) => d.toISOString().slice(0, 16);
  it.each([
    [{ year: 2026, month: 6, day: 21 }, '2026-06-21T12:06', '2026-06-22T04:21', '2026-06-21T20:14'],
    [{ year: 2026, month: 12, day: 21 }, '2026-12-21T16:05', '2026-12-22T00:16', '2026-12-21T20:10'],
    [{ year: 2026, month: 3, day: 8 }, '2026-03-08T14:40', '2026-03-09T02:06', '2026-03-08T20:23'], // last spring-forward day
  ])('%o sunrise/sunset/noon', (date, rise, set, noon) => {
    const t = sunTimes(date, LAT, LON);
    expect([utcMinute(t.sunrise!), utcMinute(t.sunset!), utcMinute(t.solarNoon)]).toEqual([rise, set, noon]);
  });

  it('formats Vancouver local time (dates where every tz release agrees)', () => {
    const t = sunTimes({ year: 2026, month: 6, day: 21 }, LAT, LON);
    expect([formatLocal(t.sunrise!), formatLocal(t.sunset!)]).toEqual(['05:06', '21:21']);
  });

  // tzdb 2026b: British Columbia moved to permanent UTC−7 on 2026-03-09, so there is no fall-back
  // on 2026-11-01. Runtimes with older tz data (e.g. Node 25.8 ships 2026a) still say UTC−8.
  const tz = (globalThis as { process?: { versions?: { tz?: string } } }).process?.versions?.tz ?? '';
  it.skipIf(tz < '2026b')('knows BC stays on UTC−7 after 2026-11-01 (tz data ≥ 2026b)', () => {
    expect(vancouver({ year: 2026, month: 12, day: 21 }, 0).offset).toBe(-420);
    expect(formatLocal(sunTimes({ year: 2026, month: 12, day: 21 }, LAT, LON).sunrise!)).toBe('09:05');
  });

  it('builds local times in America/Vancouver, not the process zone', () => {
    expect(vancouver({ year: 2026, month: 1, day: 15 }, 9 * 60).toUTC().toISO()).toBe('2026-01-15T17:00:00.000Z');
    expect(vancouver({ year: 2026, month: 7, day: 15 }, 9 * 60).toUTC().toISO()).toBe('2026-07-15T16:00:00.000Z');
    expect(new Date(momentSample({ year: 2026, month: 7, day: 15 }, 9 * 60, LAT, LON).time).toISOString()).toBe('2026-07-15T16:00:00.000Z');
  });

  it('reads minutes of the day as wall-clock time, even on a clock-change day', () => {
    const mar8 = { year: 2026, month: 3, day: 8 }; // 02:00 PST → 03:00 PDT
    expect(formatLocal(vancouver(mar8, 12 * 60).toMillis())).toBe('12:00');
    expect(formatLocal(vancouver(mar8, 60).toMillis())).toBe('01:00');
    expect(vancouver(mar8, 24 * 60).toISODate()).toBe('2026-03-09');
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
