// Sun positions (SunCalc 2) and sampling schedules, always in America/Vancouver via luxon.
//
// SunCalc 2 conventions (not SunCalc 1.x's): angles in DEGREES, azimuth
// clockwise from TRUE north, altitude apparent (refraction-corrected). Never build analysis
// dates with `new Date(y, m, d)`; everything goes through `vancouver()` below.
import { DateTime } from 'luxon';
import { getPosition, getTimes } from 'suncalc';
import { SUN } from '../config';

export interface LocalDate {
  year: number;
  month: number; // 1–12
  day: number;
}

export interface SunSample {
  /** UTC epoch milliseconds of the sample. */
  time: number;
  altDeg: number;
  /** Clockwise from true north. */
  azTrueDeg: number;
  /** Hours this sample stands for. */
  weightH: number;
}

/**
 * A Vancouver WALL-CLOCK time: `minuteOfDay` 720 is 12:00 on the clock even on a day the clocks
 * change (adding elapsed minutes to midnight would be an hour off). 1440 means the next midnight.
 */
export function vancouver(d: LocalDate, minuteOfDay = 12 * 60): DateTime {
  const m = Math.round(minuteOfDay);
  const extraDays = Math.floor(m / 1440);
  const wall = m - extraDays * 1440;
  return DateTime.fromObject(
    { year: d.year, month: d.month, day: d.day, hour: Math.floor(wall / 60), minute: wall % 60 },
    { zone: SUN.zone },
  ).plus({ days: extraDays });
}

export function sunPosition(time: Date, lat: number, lon: number): { altDeg: number; azTrueDeg: number } {
  const p = getPosition(time, lat, lon);
  return { altDeg: p.altitude, azTrueDeg: p.azimuth };
}

export interface DayTimes {
  sunrise: Date | null;
  sunset: Date | null;
  solarNoon: Date;
  alwaysUp: boolean;
}

/** Sun times for the civil day in Vancouver (SunCalc 2 takes the zone offset in minutes). */
export function sunTimes(d: LocalDate, lat: number, lon: number): DayTimes {
  const noon = vancouver(d);
  const t = getTimes(noon.toJSDate(), lat, lon, 0, noon.offset);
  return { sunrise: t.sunrise, sunset: t.sunset, solarNoon: t.solarNoon, alwaysUp: t.alwaysUp === true };
}

export interface DayWindow {
  fromMin: number; // minutes after local midnight
  toMin: number;
}

/**
 * Samples from sunrise to sunset (optionally clipped to a daily window) at the midpoint of each
 * `stepMin` slice; the last slice is shortened and weighted accordingly.
 */
export function daySamples(d: LocalDate, lat: number, lon: number, stepMin: number, window?: DayWindow): SunSample[] {
  const t = sunTimes(d, lat, lon);
  let start: number, end: number;
  if (t.sunrise && t.sunset) {
    start = t.sunrise.getTime();
    end = t.sunset.getTime();
  } else if (t.alwaysUp) {
    start = vancouver(d, 0).toMillis();
    end = vancouver(d, 24 * 60).toMillis();
  } else {
    return [];
  }
  if (window) {
    start = Math.max(start, vancouver(d, window.fromMin).toMillis());
    end = Math.min(end, vancouver(d, window.toMin).toMillis());
  }
  const stepMs = stepMin * 60_000;
  const out: SunSample[] = [];
  for (let a = start; a < end; a += stepMs) {
    const b = Math.min(a + stepMs, end);
    const mid = (a + b) / 2;
    const p = sunPosition(new Date(mid), lat, lon);
    out.push({ time: mid, altDeg: p.altDeg, azTrueDeg: p.azTrueDeg, weightH: (b - a) / 3_600_000 });
  }
  return out;
}

export function momentSample(d: LocalDate, minuteOfDay: number, lat: number, lon: number): SunSample {
  const time = vancouver(d, minuteOfDay).toMillis();
  const p = sunPosition(new Date(time), lat, lon);
  return { time, altDeg: p.altDeg, azTrueDeg: p.azTrueDeg, weightH: 0 };
}

const toLocal = (dt: DateTime): LocalDate => ({ year: dt.year, month: dt.month, day: dt.day });

/** Every `everyDays`-th day from start to end inclusive, stepping in Vancouver local dates. */
export function dateRange(start: LocalDate, end: LocalDate, everyDays = 1): LocalDate[] {
  const out: LocalDate[] = [];
  const last = vancouver(end, 0);
  for (let dt = vancouver(start, 0); dt <= last; dt = dt.plus({ days: everyDays })) out.push(toLocal(dt));
  return out;
}

export type PresetId = 'growing' | 'summer' | 'winter' | 'year';

export const PRESETS: Record<PresetId, (year: number) => { start: LocalDate; end: LocalDate }> = {
  growing: (y) => ({ start: { year: y, month: 4, day: 1 }, end: { year: y, month: 9, day: 30 } }),
  summer: (y) => ({ start: { year: y, month: 6, day: 1 }, end: { year: y, month: 8, day: 31 } }),
  // Dec 1 through the last day of February in the following year (28th or 29th).
  winter: (y) => ({ start: { year: y, month: 12, day: 1 }, end: toLocal(vancouver({ year: y + 1, month: 2, day: 1 }, 0).endOf('month')) }),
  year: (y) => ({ start: { year: y, month: 1, day: 1 }, end: { year: y, month: 12, day: 31 } }),
};

export function todayInVancouver(now: Date = new Date()): LocalDate {
  return toLocal(DateTime.fromJSDate(now).setZone(SUN.zone));
}

export function nowMinuteInVancouver(now: Date = new Date()): number {
  const dt = DateTime.fromJSDate(now).setZone(SUN.zone);
  return dt.hour * 60 + dt.minute;
}

export function formatLocal(time: number | Date, fmt = 'HH:mm'): string {
  const ms = typeof time === 'number' ? time : time.getTime();
  return DateTime.fromMillis(ms, { zone: SUN.zone }).toFormat(fmt);
}

export function parseIsoDate(s: string): LocalDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
}

export function isoDate(d: LocalDate): string {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}
