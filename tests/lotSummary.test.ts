import { describe, expect, it } from 'vitest';
import { sideOf, summarizeLot } from '../src/engine/lotSummary';
import type { Position } from '../src/geo/polygon';

// A 20 m × 20 m lot of 1 m cells centred on (0, 0): x east, y north.
const positions: Position[] = [];
for (let y = -9.5; y < 10; y++) for (let x = -9.5; x < 10; x++) positions.push([x, y]);
const T = { fullSunH: 6, partSunH: 3 };
const none = new Uint8Array(positions.length);

describe('summarising a lot', () => {
  it('finds the middle range, its class and the sunny north half', () => {
    const values = positions.map(([, y]) => (y > 0 ? 7 : 2)); // north half in full sun, south half in shade
    const s = summarizeLot({ mode: 'season', values, covered: none, positions, thresholds: T });
    expect(s.low).toBe(2);
    expect(s.high).toBe(7);
    expect(s.classShares[2]).toBeCloseTo(0.5, 6);
    expect(s.classShares[0]).toBeCloseTo(0.5, 6);
    expect(s.sunniest).toEqual({ side: 'north', value: 7 });
    expect(s.shadiest).toEqual({ side: 'south', value: 2 });
  });

  it('says "spread" when sun is even, and names diagonal sides', () => {
    const even = summarizeLot({ mode: 'season', values: positions.map(() => 4.5), covered: none, positions, thresholds: T });
    expect(even.medianClass).toBe(1);
    expect(even.sunniest?.side).toBe('spread');
    expect(sideOf(positions.filter(([x, y]) => x > 4 && y > 4), positions)).toBe('north-east');
    expect(sideOf(positions.filter(([x, y]) => x < -4 && y < -4), positions)).toBe('south-west');
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
    const sh = summarizeLot({ mode: 'shade', values: positions.map(([, y]) => (y < 0 ? 90 : 10)), covered: none, positions, thresholds: T });
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
    expect(h.moment(0.35, '16:40', '2026-10-08')).toBe('At 4:40 pm on 8 October, **35% of the open ground** is in direct sun.');
    expect(h.momentSide('east')).toBe('The sunny part is toward the **east**.');
    expect(h.momentSide('spread')).toBe('The sunny spots are scattered across the lot.');
    expect(h.shade('south', 82, '13:00', '18:00', '2026-06-01', '2026-08-31')).toBe(
      'Between 1:00 pm and 6:00 pm, 1 June to 31 August, the shadiest part is toward the **south**, in shade about **82% of the time**.',
    );
  });
});
