// Typical weather: the share of daylight with direct sunshine, month by month, at a place in Metro
// Vancouver. The level comes from the nearer airport's measured sunshine record; the local pattern
// (the North Shore a little cloudier, and so on) from a weather model. See sunshine.json, built by
// spike/25-weather.ts. Pure apart from the bundled data.
import { sunTimes, type LocalDate } from '../engine/sun';
import type { Position } from '../geo/polygon';
import data from './sunshine.json';

export interface Station {
  id: string;
  name: string;
  /** Plain name for the source line: "Vancouver airport". */
  short: string;
  lonLat: number[];
  /** Years of the normals, e.g. "1981–2010". */
  period: string;
  /** Hours of bright sunshine in an average month, January to December. */
  hours: number[];
}

export interface Sunshine {
  /** Share of daylight with sunshine, January to December (0–1). */
  shares: number[];
  station: Station;
}

const REF_YEAR = 2023; // any non-leap year: daylight repeats from year to year
const airportCache = new Map<string, number[]>();

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate(); // calendar maths only

/** An airport's measured share of daylight with bright sunshine, by month: its hours ÷ sunrise-to-sunset hours there. */
export function airportShares(s: Station): number[] {
  const cached = airportCache.get(s.id);
  if (cached) return cached;
  const possible = new Array<number>(12).fill(0);
  for (let m = 1; m <= 12; m++)
    for (let d = 1; d <= daysIn(REF_YEAR, m); d++) {
      const t = sunTimes({ year: REF_YEAR, month: m, day: d }, s.lonLat[1]!, s.lonLat[0]!);
      if (t.sunrise && t.sunset) possible[m - 1]! += (t.sunset.getTime() - t.sunrise.getTime()) / 3_600_000;
    }
  const shares = s.hours.map((h, i) => Math.min(1, h / possible[i]!));
  airportCache.set(s.id, shares);
  return shares;
}

/**
 * The share for a place. At each grid point: its nearer airport's measured share × the model's
 * local ratio there; blended between the four grid points around the place. The station named is
 * the nearest grid point's airport.
 */
export function localSunshine([lon, lat]: Position): Sunshine {
  const g = data.grid;
  const x = Math.min(g.nx - 1, Math.max(0, (lon - g.lon0) / g.dLon)), y = Math.min(g.ny - 1, Math.max(0, (lat - g.lat0) / g.dLat));
  const c0 = Math.min(g.nx - 2, Math.floor(x)), r0 = Math.min(g.ny - 2, Math.floor(y));
  const fx = x - c0, fy = y - r0;
  const at = (r: number, c: number) => {
    const p = g.points[r * g.nx + c]!;
    return airportShares(data.stations[p.station]! as Station).map((v, i) => v * p.ratio[i]!);
  };
  const a = at(r0, c0), b = at(r0, c0 + 1), cc = at(r0 + 1, c0), d = at(r0 + 1, c0 + 1);
  const shares = a.map((_, i) => Math.min(1, (a[i]! * (1 - fx) + b[i]! * fx) * (1 - fy) + (cc[i]! * (1 - fx) + d[i]! * fx) * fy));
  const nearest = g.points[Math.round(y) * g.nx + Math.round(x)]!;
  return { shares, station: data.stations[nearest.station]! as Station };
}

/** One day's share, interpolated between mid-month values (and from December into January). */
export function dayFactor(shares: number[], d: LocalDate): number {
  const x = d.month - 1 + (d.day - 0.5) / daysIn(d.year, d.month) - 0.5; // months since mid-January
  const i = Math.floor(x), f = x - i;
  const a = shares[(i + 12) % 12]!, b = shares[(i + 13) % 12]!;
  return a + (b - a) * f;
}
