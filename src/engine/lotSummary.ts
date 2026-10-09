// What a result means for the lot, in numbers a headline can use: how much sun most of the open
// ground gets, where the sunniest and shadiest parts are, and how much is under roofs or trees.
// Pure: values per cell in, plain facts out (copy.ts turns them into sentences).
import type { Position } from '../geo/polygon';
import { quantile, type Spot, type Spots } from './spots';

export type SummaryMode = 'season' | 'day' | 'moment' | 'shade';

/**
 * 8-way compass words; "middle" for a patch near the lot's centre; "spread" when sun is even (no
 * sunniest or shadiest patch), or a moment's sunny cells aren't off to one side.
 */
export type Side = 'north' | 'north-east' | 'east' | 'south-east' | 'south' | 'south-west' | 'west' | 'north-west' | 'middle' | 'spread';
const SIDES: Side[] = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

export interface Place {
  side: Side;
  /** The value there: hours (season, day), % of the time shaded (shade), share in sun (moment). */
  value: number;
}

export interface LotSummary {
  mode: SummaryMode;
  /** Cells measured (not under a roof or tree), and the share of the lot that is covered. */
  openCells: number;
  coveredShare: number;
  /** Season and day: middle range (25th–75th percentile) and median hours, and the median's class (0 shade, 1 part, 2 full). */
  low: number;
  high: number;
  median: number;
  medianClass: 0 | 1 | 2;
  /** Season and day: share of open ground in shade, part sun and full sun. */
  classShares: [number, number, number];
  /** Moment: share of open ground in direct sun. */
  sunShare: number;
  sunniest: Place | null;
  shadiest: Place | null;
}

export interface SummaryInput {
  mode: SummaryMode;
  /** Hours (season, day), 1/0 in sun (moment) or % of the time shaded (shade), per cell; NaN = no data. */
  values: ArrayLike<number>;
  covered: ArrayLike<number>;
  /** Each cell's position in local metres (x east, y north). */
  positions: Position[];
  thresholds: { fullSunH: number; partSunH: number };
  /** Season, day and shade: the sunniest and shadiest patches (spots.ts), for the sides and values. */
  spots?: Spots;
}

/** The share of the lot under roofs or trees above which there's too little open ground to summarise. */
export const MOSTLY_COVERED = 0.9;

/**
 * Where a group of cells sits on the lot: the compass direction from the lot's centre to the
 * group's centre, or `central` ("spread", or "middle" for a patch) when that offset is under 15%
 * of the lot's size (its radius).
 */
export function sideOf(group: Position[], all: Position[], central: 'spread' | 'middle' = 'spread'): Side {
  if (!group.length || !all.length) return central;
  const mean = (ps: Position[]): Position => [ps.reduce((s, p) => s + p[0], 0) / ps.length, ps.reduce((s, p) => s + p[1], 0) / ps.length];
  const [cx, cy] = mean(all), [gx, gy] = mean(group);
  const radius = Math.max(1, ...all.map(([x, y]) => Math.hypot(x - cx, y - cy)));
  const dx = gx - cx, dy = gy - cy;
  if (Math.hypot(dx, dy) < 0.15 * radius) return central;
  const bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360; // clockwise from north
  return SIDES[Math.round(bearing / 45) % 8]!;
}

export function summarizeLot(input: SummaryInput): LotSummary {
  const { mode, values, covered, positions, thresholds } = input;
  const open: { v: number; p: Position }[] = [];
  let total = 0, coveredCount = 0;
  for (let i = 0; i < positions.length; i++) {
    total++;
    if (covered[i]) {
      coveredCount++;
      continue;
    }
    const v = values[i]!;
    if (v === v) open.push({ v, p: positions[i]! });
  }
  const out: LotSummary = {
    mode,
    openCells: open.length,
    coveredShare: total ? coveredCount / total : 0,
    low: NaN,
    high: NaN,
    median: NaN,
    medianClass: 0,
    classShares: [0, 0, 0],
    sunShare: NaN,
    sunniest: null,
    shadiest: null,
  };
  if (!open.length) return out;
  const sorted = open.map((o) => o.v).sort((a, b) => a - b);
  out.low = quantile(sorted, 0.25);
  out.high = quantile(sorted, 0.75);
  out.median = quantile(sorted, 0.5);
  const all = open.map((o) => o.p);
  // The patches' sides and pin values; with no patches (sun is even), "spread" at the median.
  const place = (s: Spot | null | undefined): Place =>
    s ? { side: sideOf(s.cells.map((i) => positions[i]!), all, 'middle'), value: s.value } : { side: 'spread', value: out.median };

  if (mode === 'season' || mode === 'day') {
    const cls = (h: number): 0 | 1 | 2 => (h >= thresholds.fullSunH ? 2 : h >= thresholds.partSunH ? 1 : 0);
    out.medianClass = cls(out.median);
    for (const o of open) out.classShares[cls(o.v)] += 1 / open.length;
    out.sunniest = place(input.spots?.sunniest);
    out.shadiest = place(input.spots?.shadiest);
  } else if (mode === 'moment') {
    const sunny = open.filter((o) => o.v > 0);
    out.sunShare = sunny.length / open.length;
    // A side for the sunny part only when it's a part (not nearly all or nothing).
    if (out.sunShare > 0.1 && out.sunShare < 0.9) out.sunniest = { side: sideOf(sunny.map((o) => o.p), all), value: out.sunShare };
  } else {
    out.shadiest = place(input.spots?.shadiest);
    out.sunniest = place(input.spots?.sunniest);
  }
  return out;
}
