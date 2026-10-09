import { describe, expect, it } from 'vitest';
import { sideOf, summarizeLot, type SummaryMode } from '../src/engine/lotSummary';
import { findSpots } from '../src/engine/spots';
import type { Position } from '../src/geo/polygon';

// A 20 m × 20 m lot of 1 m cells centred on (0, 0): x east, y north. In pixels, rows run south.
const positions: Position[] = [];
for (let y = -9.5; y < 10; y++) for (let x = -9.5; x < 10; x++) positions.push([x, y]);
const px = positions.map(([x]) => x + 10), py = positions.map(([, y]) => 10 - y);
const T = { fullSunH: 6, partSunH: 3 };
const none = new Uint8Array(positions.length);
/** The spots for a result, as Analysis finds them. */
const spotsFor = (mode: Exclude<SummaryMode, 'moment'>, values: number[], covered: ArrayLike<number> = none) =>
  findSpots({ mode, values, covered, px, py, step: 1, cellAreaM2: 1 });

describe('summarising a lot', () => {
  it('finds the middle range, its class and the sunny north half', () => {
    const values = positions.map(([, y]) => (y > 0 ? 7 : 2)); // north half in full sun, south half in shade
    const s = summarizeLot({ mode: 'season', values, covered: none, positions, thresholds: T, spots: spotsFor('season', values) });
    expect(s.low).toBe(2);
    expect(s.high).toBe(7);
    expect(s.classShares[2]).toBeCloseTo(0.5, 6);
    expect(s.classShares[0]).toBeCloseTo(0.5, 6);
    expect(s.sunniest).toEqual({ side: 'north', value: 7 });
    expect(s.shadiest).toEqual({ side: 'south', value: 2 });
  });

  it('says "spread" when sun is even, and names diagonal sides', () => {
    const values = positions.map(() => 4.5);
    const even = summarizeLot({ mode: 'season', values, covered: none, positions, thresholds: T, spots: spotsFor('season', values) });
    expect(even.medianClass).toBe(1);
    expect(even.sunniest).toEqual({ side: 'spread', value: 4.5 });
    expect(sideOf(positions.filter(([x, y]) => x > 4 && y > 4), positions)).toBe('north-east');
    expect(sideOf(positions.filter(([x, y]) => x < -4 && y < -4), positions)).toBe('south-west');
  });

  it('says "middle" for a sunny patch in the middle of the lot', () => {
    const values = positions.map(([x, y]) => (Math.abs(x) < 3 && Math.abs(y) < 3 ? 8 : 2));
    const s = summarizeLot({ mode: 'season', values, covered: none, positions, thresholds: T, spots: spotsFor('season', values) });
    expect(s.sunniest).toEqual({ side: 'middle', value: 8 });
  });

  it("leaves out ground under roofs and trees, and reports how much there is", () => {
    const covered = Uint8Array.from(positions.map(([x]) => (x < 0 ? 1 : 0)));
    const values = positions.map(([x]) => (x < 0 ? 0 : 8)); // the covered half would read 0 h
    const s = summarizeLot({ mode: 'day', values, covered, positions, thresholds: T });
    expect(s.coveredShare).toBeCloseTo(0.5, 6);
    expect(s.median).toBe(8);
    expect(s.openCells).toBe(200);
  });

  it('handles a lot that is all roof', () => {
    const s = summarizeLot({ mode: 'season', values: positions.map(() => 0), covered: new Uint8Array(positions.length).fill(1), positions, thresholds: T });
    expect(s.coveredShare).toBe(1);
    expect(s.openCells).toBe(0);
    expect(s.sunniest).toBeNull();
  });

  it('gives the sunny share at a moment, and the shadiest side for the shade finder', () => {
    const m = summarizeLot({ mode: 'moment', values: positions.map(([x]) => (x > 3 ? 1 : 0)), covered: none, positions, thresholds: T });
    expect(m.sunShare).toBeCloseTo(0.35, 6); // 7 of 20 columns
    expect(m.sunniest?.side).toBe('east');
    const all = summarizeLot({ mode: 'moment', values: positions.map(() => 1), covered: none, positions, thresholds: T });
    expect(all.sunShare).toBe(1);
    expect(all.sunniest).toBeNull(); // no "part" to point at
    const shaded = positions.map(([, y]) => (y < 0 ? 90 : 10));
    const sh = summarizeLot({ mode: 'shade', values: shaded, covered: none, positions, thresholds: T, spots: spotsFor('shade', shaded) });
    expect(sh.shadiest).toEqual({ side: 'south', value: 90 });
  });

  it('ignores cells without data (sun down all window)', () => {
    const s = summarizeLot({ mode: 'shade', values: positions.map(() => NaN), covered: none, positions, thresholds: T });
    expect(s.openCells).toBe(0);
    expect(s.shadiest).toBeNull();
  });
});

describe('headline wording', async () => {
  const { copy, fmtDate, fmtTime } = await import('../src/copy');
  const h = copy.headline;
  it('formats dates, times and hour ranges plainly', () => {
    expect(fmtDate('2026-10-08')).toBe('8 October');
    expect(fmtTime('16:40')).toBe('4:40 pm');
    expect(fmtTime('00:05')).toBe('12:05 am');
    expect(fmtTime('12:00')).toBe('12:00 pm');
    expect(h.season(3.1, 4.9, 'part sun', 'from April to September')).toBe('Most of the open ground here gets **3–5 hours of direct sun a day** (part sun) from April to September.');
    expect(h.season(5.9, 6.2, 'full sun', 'over the whole year')).toContain('**about 6 hours of direct sun a day**');
  });

  it('describes where the sun and shade are', () => {
    expect(h.sides('north-east', 6.2, 'south')).toBe('The sunniest part is toward the **north-east** (about 6 h); the **south** side is shadiest.');
    expect(h.sides('north', 7, 'north')).toBe('The sunniest part is toward the **north** (about 7 h).');
    expect(h.sides('spread', 4, 'spread')).toBe('Sun is fairly even across the lot.');
    expect(h.sides('spread', 4, 'west')).toBe('The **west** side is shadiest.');
    expect(h.sides('middle', 7, 'south')).toBe('The sunniest part is near the **middle** of the lot (about 7 h); the **south** side is shadiest.');
    expect(h.sides('north', 6, 'middle')).toBe('The sunniest part is toward the **north** (about 6 h); the shadiest part is near the **middle**.');
    expect(h.moment(0.35, '16:40', '2026-10-08')).toBe('At 4:40 pm on 8 October, **35% of the open ground** is in direct sun.');
    expect(h.momentSide('east')).toBe('The sunny part is toward the **east**.');
    expect(h.momentSide('spread')).toBe('The sunny spots are scattered across the lot.');
    expect(h.shade('south', 82, '13:00', '18:00', '2026-06-01', '2026-08-31')).toBe(
      'Between 1:00 pm and 6:00 pm, 1 June to 31 August, the shadiest part is toward the **south**, in shade about **82% of the time**.',
    );
    expect(h.shade('middle', 82, '13:00', '18:00', '2026-06-01', '2026-08-31')).toContain('the shadiest part is near the **middle** of the lot, in shade');
  });

  it('labels the pins briefly, with the rest of the name for screen readers', () => {
    expect(copy.spots.pin('sunniest', 'season', 7.34, '2026-10-08')).toEqual({ text: 'Max 7.3 h', more: ' of direct sun a day, the most on the lot: show its sun month by month' });
    expect(copy.spots.pin('shadiest', 'day', 0.1, '2026-10-08')).toEqual({ text: 'Min 0.1 h', more: ' of direct sun on 8 October, the least on the lot: show its sun month by month' });
    expect(copy.spots.pin('shadiest', 'shade', 84.6, '2026-10-08').text).toBe('Most shade 85%');
    expect(copy.spots.pin('sunniest', 'shade', 10, '2026-10-08').text).toBe('Least shade 10%');
  });

  it('words typical weather as an extra line', () => {
    const w = copy.weather;
    expect(w.hours(6.12)).toBe('about 6.1 hours with typical weather');
    expect(w.range(2.4, 4.1)).toBe('With typical weather, expect about 2.5–4 hours.');
    expect(w.source('Vancouver airport', '1981–2000')).toBe('Typical weather: sunshine records at Vancouver airport (1981–2000), adjusted for local cloud with Open-Meteo.');
    expect(copy.summary.season(27, 14.6, 7.7)).toBe('For comparison, open ground with nothing around it would get 14.6 hours of sun a day (about 7.7 with typical weather).');
  });

  it('words the Basic summary plainly', () => {
    const b = copy.basic;
    expect(b.period('2026-04-01', '2026-09-30')).toBe('Average hours of direct sun a day, 1 April to 30 September');
    expect(b.hours(11.46)).toBe('11.5 hours');
    expect(b.hours(0.02)).toBe('0 hours');
    expect(copy.spots.pin('shadiest', 'season', 0, '2026-10-08').text).toBe('Min 0 h');
    expect(b.where('north-east')).toEqual(['in the', 'north-east']);
    expect(b.where('middle')).toEqual(['near the', 'middle']);
    expect(b.even(11.9, 12.3)).toBe('Sun is fairly even: 11.9 to 12.3 hours a day across the lot.');
  });
});
