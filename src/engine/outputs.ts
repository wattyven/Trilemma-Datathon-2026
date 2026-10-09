// Every result (sun now, sun-hours, season average, shade finder, the inspector), as table lookups against precomputed horizons.
import { CLASS_THRESHOLDS, type Thresholds } from '../config';
import { sectorLookup, type SectorLookup } from './horizon';
import type { SunSample } from './sun';

export interface Horizons {
  data: Float32Array; // count × sectors, degrees
  count: number;
  sectors: number;
}

export interface PreparedSample extends SectorLookup {
  altDeg: number;
  weightH: number;
  time: number;
}

/** True → grid azimuth (add γ) and pre-resolve the sector lookup once for all cells. */
export function prepareSamples(samples: SunSample[], gammaDeg: number, sectors: number): PreparedSample[] {
  return samples.map((s) => ({ ...sectorLookup(s.azTrueDeg + gammaDeg, sectors), altDeg: s.altDeg, weightH: s.weightH, time: s.time }));
}

export function isSunlit(h: Horizons, i: number, s: PreparedSample): boolean {
  if (s.altDeg <= 0) return false; // night
  const base = i * h.sectors;
  return s.altDeg > h.data[base + s.k0]! * (1 - s.t) + h.data[base + s.k1]! * s.t;
}

/** Moment: 1 where the cell is in direct sun. */
export function momentMask(h: Horizons, s: PreparedSample): Uint8Array {
  const out = new Uint8Array(h.count);
  for (let i = 0; i < h.count; i++) out[i] = isSunlit(h, i, s) ? 1 : 0;
  return out;
}

/** Hours of direct sun summed over the samples. */
export function sunHours(h: Horizons, samples: PreparedSample[]): Float32Array {
  const out = new Float32Array(h.count);
  for (const s of samples) {
    if (s.altDeg <= 0) continue;
    for (let i = 0; i < h.count; i++) if (isSunlit(h, i, s)) out[i] = out[i]! + s.weightH;
  }
  return out;
}

/** Season: average daily direct-sun hours over the sampled days. */
export function seasonAverage(h: Horizons, days: PreparedSample[][]): Float32Array {
  return seasonAverages(h, days).clear;
}

/**
 * Season, in one pass: the clear-day average, and with `factors` (each day's typical share of
 * sunshine) the average weighted by them, i.e. the hours to expect with typical weather.
 */
export function seasonAverages(h: Horizons, days: PreparedSample[][], factors?: number[]): { clear: Float32Array; typical?: Float32Array } {
  const clear = new Float32Array(h.count);
  const typical = factors ? new Float32Array(h.count) : undefined;
  days.forEach((samples, d) => {
    const f = factors?.[d] ?? 1;
    for (const s of samples) {
      if (s.altDeg <= 0) continue;
      for (let i = 0; i < h.count; i++)
        if (isSunlit(h, i, s)) {
          clear[i] = clear[i]! + s.weightH;
          if (typical) typical[i] = typical[i]! + s.weightH * f;
        }
    }
  });
  if (days.length)
    for (let i = 0; i < h.count; i++) {
      clear[i]! /= days.length;
      if (typical) typical[i]! /= days.length;
    }
  return typical ? { clear, typical } : { clear };
}

export interface ShadeResult {
  /** % of sun-up time within the daily window that each cell is shaded (NaN if the sun never rose in it). */
  shadedPct: Float32Array;
  /** Hours (summed over days) when the sun was up inside the window, and the window's total length. */
  sunUpHours: number;
  windowHours: number;
}

/** Shade finder. `samples` are already clipped to the daily window across the date range. */
export function shadeFinder(h: Horizons, samples: PreparedSample[], windowHours: number): ShadeResult {
  const up = samples.filter((s) => s.altDeg > 0);
  const sunUpHours = up.reduce((a, s) => a + s.weightH, 0);
  const lit = sunHours(h, up);
  const shadedPct = new Float32Array(h.count);
  for (let i = 0; i < h.count; i++) shadedPct[i] = sunUpHours > 0 ? (100 * (sunUpHours - lit[i]!)) / sunUpHours : NaN;
  return { shadedPct, sunUpHours, windowHours };
}

export const CLASS_SHADE = 0;
export const CLASS_PART = 1;
export const CLASS_FULL = 2;

export function classify(hours: Float32Array, t: Thresholds = CLASS_THRESHOLDS): Uint8Array {
  const out = new Uint8Array(hours.length);
  for (let i = 0; i < hours.length; i++) {
    const v = hours[i]!;
    out[i] = v >= t.fullSunH ? CLASS_FULL : v >= t.partSunH ? CLASS_PART : CLASS_SHADE;
  }
  return out;
}

export interface CellInspection {
  /** Average daily sun-hours for Jan … Dec. */
  monthlyHours: number[];
  /** With typical weather (when the request gave sunshine shares). */
  monthlyTypical?: number[];
  /** The selected day's samples: time and whether the cell had direct sun. */
  strip: { time: number; sunlit: boolean }[];
}

/** `months[m]` holds the sample days for month m (each a list of samples). */
export function inspectCell(h: Horizons, i: number, months: PreparedSample[][][], day: PreparedSample[], monthFactors?: number[][]): CellInspection {
  const monthly = (weight: (m: number, d: number) => number) =>
    months.map((days, m) => {
      if (!days.length) return 0;
      let sum = 0;
      days.forEach((samples, d) => {
        for (const s of samples) if (isSunlit(h, i, s)) sum += s.weightH * weight(m, d);
      });
      return sum / days.length;
    });
  const out: CellInspection = { monthlyHours: monthly(() => 1), strip: day.map((s) => ({ time: s.time, sunlit: isSunlit(h, i, s) })) };
  if (monthFactors) out.monthlyTypical = monthly((m, d) => monthFactors[m]?.[d] ?? 1);
  return out;
}
