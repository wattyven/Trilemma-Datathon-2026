// Horizon precompute: for each cell and each of K grid-azimuth sectors, the highest
// elevation angle (degrees) of the DSM as seen from the observer. A cell is sunlit at
// (alt, az) iff alt > horizon(az), so a whole season becomes table lookups.
//
// Distances are in grid pixels (1 m). The EPSG:3979 scale factor in Metro Vancouver is ~0.999, so
// true distances are ~0.1% longer; the resulting angle error (<0.05°) is ignored.
//
// Azimuths here are GRID azimuths (clockwise from EPSG:3979 grid north = −py). Convert a true
// azimuth with `+ γ` (geo/proj.ts convergenceDeg) before looking up.
import { bilinear, maxValue, type Raster } from './grid';

export interface HorizonParams {
  sectors: number;
  minStepM: number;
  stepFrac: number;
  /** Stop a ray once even the window's highest point couldn't raise the horizon. Exact. */
  earlyExit?: boolean;
}

export interface HorizonInput {
  dsm: Raster;
  px: Float32Array;
  py: Float32Array;
  z0: Float32Array;
  count: number;
  /** Metres per pixel (1 for HRDEM, 0.5 for the point-cloud grid). Default 1. */
  res?: number;
}

const DEG = 180 / Math.PI;

export function sectorDirections(sectors: number): { dx: Float64Array; dy: Float64Array } {
  const dx = new Float64Array(sectors), dy = new Float64Array(sectors);
  for (let k = 0; k < sectors; k++) {
    const a = (k * 2 * Math.PI) / sectors;
    dx[k] = Math.sin(a); // east
    dy[k] = -Math.cos(a); // grid north is −py
  }
  return { dx, dy };
}

/** Fills out[start·K … end·K). Pass `zmax` when calling in chunks to avoid rescanning the raster. */
export function computeHorizons(
  input: HorizonInput,
  p: HorizonParams,
  out: Float32Array,
  start = 0,
  end = input.count,
  zmax = maxValue(input.dsm),
): void {
  const K = p.sectors;
  const { dx, dy } = sectorDirections(K);
  const { dsm } = input;
  const w = dsm.width, h = dsm.height;
  const perM = 1 / (input.res ?? 1); // pixels per metre; distances below are metres
  const earlyExit = p.earlyExit !== false;
  for (let i = start; i < end; i++) {
    const x0 = input.px[i]!, y0 = input.py[i]!, z0 = input.z0[i]!;
    const headroom = zmax - z0;
    for (let k = 0; k < K; k++) {
      const ux = dx[k]! * perM, uy = dy[k]! * perM;
      let maxTan = -Infinity;
      let d = 1; // start one metre away
      for (;;) {
        const x = x0 + ux * d, y = y0 + uy * d;
        if (x < 0 || y < 0 || x > w || y > h) break;
        const z = bilinear(dsm, x, y);
        if (z === z) {
          // not NaN: nodata counts as no obstruction
          const t = (z - z0) / d;
          if (t > maxTan) maxTan = t;
        }
        d += Math.max(p.minStepM, p.stepFrac * d);
        if (earlyExit && headroom / d <= maxTan) break;
      }
      out[i * K + k] = maxTan === -Infinity ? -90 : Math.atan(maxTan) * DEG;
    }
  }
}

export interface SectorLookup {
  k0: number;
  k1: number;
  t: number;
}

export function sectorLookup(gridAzDeg: number, sectors: number): SectorLookup {
  const f = ((((gridAzDeg % 360) + 360) % 360) / 360) * sectors;
  const k0 = Math.floor(f) % sectors;
  return { k0, k1: (k0 + 1) % sectors, t: f - Math.floor(f) };
}

/** Horizon (degrees) for cell i, linearly interpolated between adjacent sectors. */
export function horizonAt(h: Float32Array, i: number, sectors: number, s: SectorLookup): number {
  const base = i * sectors;
  return h[base + s.k0]! * (1 - s.t) + h[base + s.k1]! * s.t;
}

/**
 * Reference ray march along the exact sun direction with a fine fixed step (no horizon
 * table). Used by tests and, in Phase 3, the debug overlay. Same "start one cell away" rule.
 */
export function rayMarchSunlit(dsm: Raster, px: number, py: number, z0: number, altDeg: number, gridAzDeg: number, stepM = 0.25, res = 1): boolean {
  if (altDeg <= 0) return false;
  const tanAlt = Math.tan(altDeg / DEG);
  const a = gridAzDeg / DEG;
  const ux = Math.sin(a) / res, uy = -Math.cos(a) / res;
  for (let d = 1; ; d += stepM) {
    const x = px + ux * d, y = py + uy * d;
    if (x < 0 || y < 0 || x > dsm.width || y > dsm.height) return true;
    const z = bilinear(dsm, x, y);
    if (z === z && (z - z0) / d >= tanAlt) return false;
  }
}

/** Split `count` cells into up to `threads` contiguous [start, end) ranges of near-equal size. */
export function splitRanges(count: number, threads: number): [number, number][] {
  const t = Math.max(1, Math.min(threads, count));
  const out: [number, number][] = [];
  for (let i = 0; i < t; i++) out.push([Math.floor((i * count) / t), Math.floor(((i + 1) * count) / t)]);
  return out.filter(([a, b]) => b > a);
}
