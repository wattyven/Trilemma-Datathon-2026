import { describe, expect, it } from 'vitest';
import { findSpots, type Spot, type SpotsInput } from '../src/engine/spots';

/** A W × H lot of cells `step` pixels apart; `value(c, r)` per cell, row 0 to the north. */
function lot(W: number, H: number, value: (c: number, r: number) => number, extra: Partial<SpotsInput> = {}): SpotsInput {
  const step = extra.step ?? 1;
  const px: number[] = [], py: number[] = [], values: number[] = [];
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      px.push(c * step + step / 2);
      py.push(r * step + step / 2);
      values.push(value(c, r));
    }
  return { mode: 'season', values, covered: new Uint8Array(values.length), px, py, step, cellAreaM2: step * step, ...extra };
}
/** Column and row of a cell. */
const at = (input: SpotsInput, cell: number) => [Math.floor(input.px[cell]! / input.step), Math.floor(input.py[cell]! / input.step)] as const;
const inside = (s: Spot | null) => !!s && s.cells.includes(s.cell);

describe('the sunniest and shadiest spots', () => {
  it('picks the 30 m² lawn over a sunnier 2 m² sliver', () => {
    // 20 × 10 lot at 2 h; a 6 × 5 lawn at 7 h in the west; two cells at 8 h in the east.
    const input = lot(20, 10, (c, r) => (c >= 2 && c < 8 && r >= 2 && r < 7 ? 7 : c >= 15 && c < 17 && r === 4 ? 8 : 2));
    const { sunniest } = findSpots(input);
    expect(sunniest!.areaM2).toBe(30);
    expect(sunniest!.value).toBe(7);
    expect(at(input, sunniest!.cell)[0]).toBeLessThan(8);
  });

  it('pins the cell deepest inside the patch', () => {
    const input = lot(11, 11, (c, r) => (c >= 3 && c < 8 && r >= 3 && r < 8 ? 9 : 1)); // a 5 × 5 square
    expect(at(input, findSpots(input).sunniest!.cell)).toEqual([5, 5]);
  });

  it('keeps the pin inside a U-shaped patch, whose centre is in the shade', () => {
    const sunny = (c: number, r: number) => (c >= 1 && c <= 8 && r >= 1 && r <= 8 && (c <= 2 || c >= 7 || r >= 7));
    const input = lot(10, 10, (c, r) => (sunny(c, r) ? 8 : 2));
    const { sunniest } = findSpots(input);
    expect(inside(sunniest)).toBe(true);
    expect(input.values[sunniest!.cell]).toBe(8);
    expect(sunniest!.areaM2).toBe(40);
  });

  it('copes with most of the lot sharing the top value', () => {
    // Unobstructed cells all get exactly the same hours; only the two south rows are shaded.
    const input = lot(10, 10, (_c, r) => (r >= 8 ? 3 : 12));
    const { sunniest, shadiest } = findSpots(input);
    expect(sunniest!.areaM2).toBe(80);
    expect(shadiest!.areaM2).toBe(20);
    expect(at(input, shadiest!.cell)[1]).toBeGreaterThanOrEqual(8);
    expect(at(input, sunniest!.cell)[1]).toBeLessThan(8);
  });

  it('leaves out ground under roofs at garden height, and counts roofs for the rooftop height', () => {
    const value = (_c: number, r: number) => (r < 5 ? 8 : r < 8 ? 3 : 0);
    const garden = lot(10, 10, value);
    garden.covered = Uint8Array.from(garden.values as number[], (_v, i) => (garden.py[i]! >= 8 ? 1 : 0));
    expect(findSpots(garden).shadiest!.value).toBe(3);
    expect(findSpots(lot(10, 10, value)).shadiest!.value).toBe(0);
  });

  it('joins neighbours on a coarsened grid and measures its cells', () => {
    const input = lot(10, 10, (c, r) => (c >= 6 && c < 9 && r >= 1 && r < 4 ? 10 : 4), { step: 2 });
    const { sunniest } = findSpots(input);
    expect(sunniest!.areaM2).toBe(36); // 3 × 3 cells of 2 m × 2 m
    expect(at(input, sunniest!.cell)).toEqual([7, 2]);
  });

  it('finds the most and least shaded spots in the shade finder', () => {
    const input = lot(10, 10, (_c, r) => (r < 5 ? 10 : 90), { mode: 'shade' });
    const { sunniest, shadiest } = findSpots(input);
    expect(shadiest!.value).toBe(90);
    expect(at(input, shadiest!.cell)[1]).toBeGreaterThanOrEqual(5);
    expect(sunniest!.value).toBe(10);
  });

  it('finds a small patch that stands out, even under a quarter of the lot', () => {
    const input = lot(10, 10, (c, r) => (c < 3 && r < 3 ? 9 : 3)); // 9 of 100 cells
    expect(findSpots(input).sunniest!.areaM2).toBe(9);
  });

  it('gives no spots when sun is even, or there is nothing to measure', () => {
    expect(findSpots(lot(10, 10, () => 4.5))).toEqual({ sunniest: null, shadiest: null });
    expect(findSpots(lot(10, 10, (c) => 4.5 + c * 0.09))).toEqual({ sunniest: null, shadiest: null }); // under 1 h apart
    expect(findSpots(lot(10, 10, () => NaN, { mode: 'shade' }))).toEqual({ sunniest: null, shadiest: null }); // sun down all window
  });
});
