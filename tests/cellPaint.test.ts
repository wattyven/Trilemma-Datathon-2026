import { describe, expect, it } from 'vitest';
import { layerColor, stretchScale } from '../src/ui/cellPaint';
import { cividis } from '../src/ui/colors';

describe('colours for one lot', () => {
  it("stretches the hours over the lot's own range, at least 4 h wide and within 0–16 h", () => {
    expect(stretchScale(2, 11.5)).toEqual({ min: 2, max: 11.5 });
    const narrow = stretchScale(11.9, 12.3);
    expect(narrow.min).toBeCloseTo(10.1, 9);
    expect(narrow.max).toBeCloseTo(14.1, 9);
    expect(stretchScale(0, 1)).toEqual({ min: 0, max: 4 });
    expect(stretchScale(15.5, 16)).toEqual({ min: 12, max: 16 });
    expect(stretchScale(NaN, NaN)).toEqual({ min: 0, max: 16 });
  });

  it('colours the lowest value darkest and the highest lightest', () => {
    const layer = { kind: 'hours' as const, values: Float32Array.of(2, 6.75, 11.5), asClasses: false, scale: { min: 2, max: 11.5 } };
    expect(layerColor(layer, 0)).toEqual(cividis(0));
    expect(layerColor(layer, 2)).toEqual(cividis(1));
    expect(layerColor(layer, 1)).toEqual(cividis(0.5));
  });
});
