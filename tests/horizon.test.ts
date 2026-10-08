// horizon lookups agree with direct ray marching ≥ 99% of the time on a synthetic DSM.
import { describe, expect, it } from 'vitest';
import { computeHorizons, horizonAt, rayMarchSunlit, sectorLookup, splitRanges } from '../src/engine/horizon';
import type { Raster } from '../src/engine/grid';
import { flatRaster, mulberry32, PARAMS } from './helpers/synthetic';

const W = 140;

/** Gently sloping ground with boxes ("houses") and round crowns ("trees"). */
function syntheticScene(seed: number): { ground: Raster; dsm: Raster } {
  const rnd = mulberry32(seed);
  const ground = flatRaster(W, W);
  for (let r = 0; r < W; r++) for (let c = 0; c < W; c++) ground.data[r * W + c] = 20 + 0.03 * c + 0.05 * r;
  const dsm: Raster = { width: W, height: W, data: ground.data.slice() };
  for (let b = 0; b < 18; b++) {
    const w = 4 + Math.floor(rnd() * 10), d = 4 + Math.floor(rnd() * 10);
    const c0 = Math.floor(rnd() * (W - w)), r0 = Math.floor(rnd() * (W - d));
    const top = 3 + rnd() * 12;
    for (let r = r0; r < r0 + d; r++) for (let c = c0; c < c0 + w; c++) dsm.data[r * W + c] = ground.data[r * W + c]! + top;
  }
  for (let t = 0; t < 35; t++) {
    const cx = rnd() * W, cy = rnd() * W, rad = 2 + rnd() * 3, top = 6 + rnd() * 12;
    for (let r = Math.max(0, Math.floor(cy - rad)); r < Math.min(W, Math.ceil(cy + rad)); r++) {
      for (let c = Math.max(0, Math.floor(cx - rad)); c < Math.min(W, Math.ceil(cx + rad)); c++) {
        const q = Math.hypot(c + 0.5 - cx, r + 0.5 - cy) / rad;
        if (q <= 1) {
          const z = ground.data[r * W + c]! + top * Math.sqrt(1 - q * q);
          dsm.data[r * W + c] = Math.max(dsm.data[r * W + c]!, z);
        }
      }
    }
  }
  return { ground, dsm };
}

describe('horizon precompute vs brute-force ray marching', () => {
  const { ground, dsm } = syntheticScene(42);
  const rnd = mulberry32(7);
  const N = 400;
  const px = new Float32Array(N), py = new Float32Array(N), z0 = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const c = 20 + Math.floor(rnd() * (W - 40)), r = 20 + Math.floor(rnd() * (W - 40));
    px[i] = c + 0.5;
    py[i] = r + 0.5;
    z0[i] = ground.data[r * W + c]! + 0.3; // ground mode, garden-bed height
  }
  const input = { dsm, px, py, z0, count: N };
  const horizons = new Float32Array(N * PARAMS.sectors);
  computeHorizons(input, PARAMS, horizons);

  it('agrees on sun/shade for ≥ 99% of random cells and sun positions', () => {
    const trials = 4000;
    let agree = 0;
    for (let t = 0; t < trials; t++) {
      const i = Math.floor(rnd() * N);
      const alt = 2 + rnd() * 58;
      const az = rnd() * 360;
      const lookup = alt > horizonAt(horizons, i, PARAMS.sectors, sectorLookup(az, PARAMS.sectors));
      const brute = rayMarchSunlit(dsm, px[i]!, py[i]!, z0[i]!, alt, az, 0.25);
      if (lookup === brute) agree++;
    }
    expect(agree / trials).toBeGreaterThanOrEqual(0.99);
  });

  it('early exit changes nothing', () => {
    const n = 60;
    const fast = new Float32Array(n * PARAMS.sectors);
    const slow = new Float32Array(n * PARAMS.sectors);
    computeHorizons(input, PARAMS, fast, 0, n);
    computeHorizons(input, { ...PARAMS, earlyExit: false }, slow, 0, n);
    expect(fast).toEqual(slow);
  });

  it('a parallel split (as the helper threads do it) equals one pass', () => {
    const merged = new Float32Array(N * PARAMS.sectors);
    for (const [a, b] of splitRanges(N, 3)) {
      const part = new Float32Array((b - a) * PARAMS.sectors);
      computeHorizons({ dsm, px: px.slice(a, b), py: py.slice(a, b), z0: z0.slice(a, b), count: b - a }, PARAMS, part);
      merged.set(part, a * PARAMS.sectors);
    }
    expect(merged).toEqual(horizons);
  });

  it('chunked computation equals one pass', () => {
    const chunked = new Float32Array(N * PARAMS.sectors);
    for (let s = 0; s < N; s += 37) computeHorizons(input, PARAMS, chunked, s, Math.min(N, s + 37));
    expect(chunked).toEqual(horizons);
  });
});

describe('splitRanges', () => {
  it('covers every cell once in near-equal contiguous slices', () => {
    expect(splitRanges(10, 3)).toEqual([[0, 3], [3, 6], [6, 10]]);
    expect(splitRanges(2, 4)).toEqual([[0, 1], [1, 2]]);
    expect(splitRanges(5, 1)).toEqual([[0, 5]]);
  });
});

describe('sector lookup', () => {
  it('wraps around north and interpolates', () => {
    expect(sectorLookup(0, 180)).toEqual({ k0: 0, k1: 1, t: 0 });
    expect(sectorLookup(359, 180)).toMatchObject({ k0: 179, k1: 0 });
    expect(sectorLookup(-1, 180)).toMatchObject({ k0: 179, k1: 0 });
    expect(sectorLookup(3, 180).t).toBeCloseTo(0.5, 9);
  });

  it('treats nodata (NaN) as no obstruction', () => {
    const r = flatRaster(40, 40, 0);
    r.data.fill(NaN);
    const out = new Float32Array(PARAMS.sectors);
    computeHorizons({ dsm: r, px: Float32Array.of(20.5), py: Float32Array.of(20.5), z0: Float32Array.of(0), count: 1 }, PARAMS, out);
    expect(Array.from(out).every((v) => v === -90)).toBe(true);
  });
});
