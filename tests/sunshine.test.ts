import { describe, expect, it } from 'vitest';
import { airportShares, dayFactor, localSunshine, type Station } from '../src/weather/sunshine';
import data from '../src/weather/sunshine.json';

const [vancouver, abbotsford] = data.stations as Station[];
const growing = (s: number[]) => s.slice(3, 9).reduce((a, v) => a + v, 0) / 6; // April to September

describe('typical weather', () => {
  it("turns an airport's sunshine hours into a share of daylight", () => {
    const s = airportShares(vancouver!);
    expect(s).toHaveLength(12);
    for (const v of s) expect(v).toBeGreaterThan(0), expect(v).toBeLessThan(1);
    expect(s[0]).toBeGreaterThan(0.15); // January, about 0.22
    expect(s[0]).toBeLessThan(0.3);
    expect(s[6]).toBeGreaterThan(0.5); // July, about 0.6
    expect(s[6]).toBeLessThan(0.7);
    expect(airportShares(abbotsford!)[6]).toBeGreaterThan(0.5);
  });

  it('matches the airport there and is cloudier on the North Shore', () => {
    const atYvr = localSunshine([-123.18, 49.195]);
    expect(atYvr.station.short).toBe('Vancouver airport');
    expect(growing(atYvr.shares)).toBeCloseTo(growing(airportShares(vancouver!)), 1);
    const northVan = localSunshine([-123.07, 49.33]);
    expect(growing(northVan.shares)).toBeLessThan(growing(atYvr.shares));
    expect(localSunshine([-122.66, 49.1]).station.short).toBe('Abbotsford airport'); // Langley
  });

  it('interpolates a day between mid-month values, across the new year too', () => {
    const s = Array.from({ length: 12 }, (_, m) => m / 10); // January 0.0 … December 1.1
    expect(dayFactor(s, { year: 2026, month: 3, day: 16 })).toBeCloseTo(0.2, 2);
    const early = dayFactor(s, { year: 2026, month: 3, day: 1 });
    expect(early).toBeGreaterThan(0.1);
    expect(early).toBeLessThan(0.2);
    const newYear = dayFactor(s, { year: 2026, month: 1, day: 1 });
    expect(newYear).toBeGreaterThan(0.5); // halfway from December (1.1) to January (0)
    expect(newYear).toBeLessThan(0.6);
  });

  it('has a complete grid', () => {
    const g = data.grid;
    expect(g.points).toHaveLength(g.nx * g.ny);
    for (const p of g.points) {
      expect([0, 1]).toContain(p.station);
      expect(p.ratio).toHaveLength(12);
      for (const r of p.ratio) expect(r).toBeGreaterThan(0.5), expect(r).toBeLessThan(1.5);
    }
  });
});
