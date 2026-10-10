import { describe, expect, it } from 'vitest';
import { clampPan, FITTED, MAP_ZOOM, panBy, zoomAbout, type FitView } from '../src/ui/mapZoom';

// A 600 × 400 px map fitted at 4 px a metre around (10, 20): 150 m × 100 m on screen.
const fit: FitView = { cx: 10, cy: 20, s: 4 };
const W = 600, H = 400;
/** The ground (local metres) under a pixel, for a zoom state. */
const groundAt = (st: { zoom: number; pan: [number, number] }, X: number, Y: number) => {
  const s = fit.s * st.zoom;
  return [fit.cx + st.pan[0] + (X - W / 2) / s, fit.cy + st.pan[1] - (Y - H / 2) / s];
};

describe('map zoom', () => {
  it('keeps the ground under the pointer where it is', () => {
    const before = groundAt(FITTED, 450, 100);
    const z = zoomAbout(FITTED, 2, 450, 100, fit, W, H);
    expect(z.zoom).toBe(2);
    const after = groundAt(z, 450, 100);
    expect(after[0]).toBeCloseTo(before[0]!, 9);
    expect(after[1]).toBeCloseTo(before[1]!, 9);
  });

  it('stays between the fitted view and 8×, centred when back at 1×', () => {
    expect(zoomAbout(FITTED, 0.5, 100, 100, fit, W, H)).toEqual(FITTED);
    const near = zoomAbout(FITTED, 100, 300, 200, fit, W, H);
    expect(near.zoom).toBe(MAP_ZOOM.max);
    const back = zoomAbout(zoomAbout(FITTED, 3, 50, 50, fit, W, H), 1 / 3, 300, 200, fit, W, H);
    expect(back.zoom).toBeCloseTo(1, 9);
    expect(back.pan[0]).toBeCloseTo(0, 9);
    expect(back.pan[1]).toBeCloseTo(0, 9);
  });

  it('pans only as far as the fitted view’s edges', () => {
    expect(clampPan([30, -30], 1, fit, W, H)).toEqual([0, 0]);
    // At 2× half the fitted view shows: the centre can move a quarter of its width (37.5 m) and height (25 m).
    expect(clampPan([100, -100], 2, fit, W, H)).toEqual([37.5, -25]);
  });

  it('drags the ground with the pointer, north up', () => {
    const z = panBy({ zoom: 2, pan: [0, 0] }, 80, 40, fit, W, H); // right and down by 10 m and 5 m at 8 px a metre
    expect(z.pan[0]).toBeCloseTo(-10, 9); // the view moves west, so the ground moves east with the pointer
    expect(z.pan[1]).toBeCloseTo(5, 9); // and north, so the ground moves south
    expect(panBy(FITTED, 80, 40, fit, W, H)).toEqual(FITTED); // nothing to drag at 1×
  });
});
