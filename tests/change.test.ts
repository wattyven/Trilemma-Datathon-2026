import { describe, expect, it } from 'vitest';
import { changeMask, composeSurface, maxPool2, regionToCoarse, upsampleNearest } from '../src/elevation/change';

// A 40 m × 40 m lot area: 1 m grid (newer survey) and the 0.5 m grid (older) lined up with it.
const W1 = 40, W05 = 80;
const OPTS = { thresholdM: 2.5, minAreaCells: 20, growCells: 2 };
const REGION05 = { c0: 2, r0: 2, c1: 78, r1: 78 };
const REGION1 = regionToCoarse(REGION05);

/** Fill 1 m cells [c0, c1) × [r0, r1) of a grid (in 1 m units; the 0.5 m grid gets 2 × 2 per cell). */
function block(z: Float32Array, w: number, scale: number, [c0, r0, c1, r1]: number[], v: number) {
  for (let r = r0! * scale; r < r1! * scale; r++) for (let c = c0! * scale; c < c1! * scale; c++) z[r * w + c] = v;
}

function scene() {
  const old05 = new Float32Array(W05 * W05).fill(10);
  const new1 = new Float32Array(W1 * W1).fill(10);
  block(old05, W05, 2, [10, 10, 18, 18], 20); // a house in both surveys…
  block(new1, W1, 1, [11, 10, 19, 18], 20); // …1 m further east in the newer one (survey offset)
  block(new1, W1, 1, [25, 25, 33, 33], 80); // a new tower
  block(new1, W1, 1, [5, 30, 8, 33], 15); // a 9 m² change (a shed)
  block(new1, W1, 1, [30, 5, 36, 11], 12); // trees grew 2 m: under the threshold
  return { old05, new1 };
}

describe('finding what changed between surveys', () => {
  const { old05, new1 } = scene();
  const { mask, areas } = changeMask(maxPool2(old05, W1, W1), new1, W1, W1, REGION1, OPTS);
  const at = (c: number, r: number) => mask[r * W1 + c];

  it('finds a new tower, grown by 2 m so the seam is on unchanged ground', () => {
    expect(at(29, 29)).toBe(1);
    expect(at(23, 29)).toBe(1);
    expect(at(22, 29)).toBe(0);
    expect(areas).toBe(1);
  });

  it("ignores a building that only moved by the surveys' offset, small changes and slow growth", () => {
    for (let r = 10; r < 18; r++) for (const c of [10, 17, 18]) expect(at(c, r)).toBe(0);
    expect(at(6, 31)).toBe(0);
    expect(at(33, 8)).toBe(0);
  });

  it('compares only where both surveys have data', () => {
    const holes = old05.slice();
    block(holes, W05, 2, [25, 25, 33, 33], NaN); // the older survey has nothing under the tower
    const m = changeMask(maxPool2(holes, W1, W1), new1, W1, W1, REGION1, OPTS);
    expect(m.mask[29 * W1 + 29]).toBe(0);
  });
});

describe('composing the best-of-both surface', () => {
  const { old05, new1 } = scene();
  old05[70 * W05 + 70] = NaN; // a hole in the older survey, on unchanged ground
  const { mask } = changeMask(maxPool2(old05, W1, W1), new1, W1, W1, REGION1, OPTS);
  const base05 = new Float32Array(W05 * W05).fill(5);
  const out = composeSurface({ w1: W1, h1: W1, region05: REGION05, old05, new1, mask1: mask, base05 });
  const at = (c: number, r: number) => out.dsm[r * W05 + c];

  it('uses the newer survey where something changed, the older one elsewhere', () => {
    expect(at(58, 58)).toBe(80);
    expect(out.changed[58 * W05 + 58]).toBe(1);
    expect(at(21, 21)).toBe(20); // the house, from the older survey
    expect(out.changed[21 * W05 + 21]).toBe(0);
    expect(at(70, 70)).toBe(10); // a hole in the older survey: the newer one
  });

  it('uses the newer survey outside the compared area, and reports the changed share', () => {
    expect(at(0, 0)).toBe(10);
    const grown = 12 * 12 * 4; // 8 m tower + 2 m each side, in 0.5 m cells
    expect(out.changedShare).toBeCloseTo(grown / (76 * 76), 3);
  });

  it('falls back to HRDEM where neither survey has data', () => {
    const empty = composeSurface({ w1: 2, h1: 2, region05: { c0: 0, r0: 0, c1: 2, r1: 2 }, old05: new Float32Array(16).fill(NaN), new1: new Float32Array(4).fill(NaN), mask1: new Uint8Array(4), base05: new Float32Array(16).fill(5) });
    expect(Array.from(empty.dsm)).toEqual(new Array(16).fill(5));
  });
});

describe('grid helpers', () => {
  it('pools 2 × 2 cells to their highest, and copies 1 m cells to 2 × 2', () => {
    const z = Float32Array.from([1, 2, 5, NaN, 3, 4, NaN, NaN]); // 4 × 2 at 0.5 m
    expect(Array.from(maxPool2(z, 2, 1))).toEqual([4, 5]);
    const nn = Float32Array.from([NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN]);
    expect(Number.isNaN(maxPool2(nn, 2, 1)[0]!)).toBe(true);
    expect(Array.from(upsampleNearest(Float32Array.from([1, 2]), 2, 1))).toEqual([1, 1, 2, 2, 1, 1, 2, 2]);
    expect(regionToCoarse({ c0: 3, r0: 2, c1: 9, r1: 10 })).toEqual({ c0: 2, r0: 1, c1: 4, r1: 5 });
  });
});

describe('drawing the change overlay', () => {
  it('hatches set cells "\\\\" (the covered hatch runs "/") and finds their bounds', async () => {
    const { hatchMaskRgba, maskBounds } = await import('../src/ui/cellPaint');
    const { CEDAR_RGB } = await import('../src/ui/colors');
    expect(CEDAR_RGB).toEqual([0x1e, 0x2b, 0x25]);
    const mask = new Uint8Array(8 * 8);
    for (let r = 2; r < 6; r++) for (let c = 3; c < 7; c++) mask[r * 8 + c] = 1;
    const rgba = hatchMaskRgba(mask, 8, 8, CEDAR_RGB, 150);
    const alpha = (c: number, r: number) => rgba[4 * (r * 8 + c) + 3];
    expect(alpha(0, 0)).toBe(0); // not marked
    expect(alpha(3, 3)).toBe(150); // on a line: x − y = 0
    expect(alpha(4, 3)).toBe(150); // x − y = 1, still within the 2-px line
    expect(alpha(5, 3)).toBe(38); // between lines: faint fill
    expect(alpha(4, 4)).toBe(150); // the line continues down-right
    expect(maskBounds(mask, 8, 8)).toEqual({ c0: 3, r0: 2, c1: 7, r1: 6 });
    expect(maskBounds(new Uint8Array(4), 2, 2)).toBeNull();
  });
});
