import { describe, expect, it } from 'vitest';
import { monthlyChartModel, stripRuns, sunnyPeriods } from '../src/ui/inspector';

describe('monthly chart model', () => {
  const hours = [0.5, 1.2, 3, 5.5, 8, 9.4, 9.1, 7.6, 5.2, 2.1, 0.8, 0.3];
  const m = monthlyChartModel(hours);

  it('scales bars to a clean maximum and keeps the full-sun line on scale', () => {
    expect(m.yMax).toBe(12);
    expect(m.ticks).toEqual([0, 6, 12]);
    const base = m.plot.top + m.plot.height;
    for (const b of m.bars) expect(b.y + b.h).toBeCloseTo(base, 6); // all grow from one baseline
    const june = m.bars[5]!;
    expect(june.h / m.plot.height).toBeCloseTo(9.4 / 12, 6);
    expect(m.refY).toBeCloseTo(m.plot.top + m.plot.height / 2, 6); // 6 h on a 12 h axis
  });

  it('caps bar thickness and leaves a gap between bars', () => {
    for (let i = 1; i < m.bars.length; i++) {
      expect(m.bars[i]!.w).toBeLessThanOrEqual(24);
      expect(m.bars[i]!.x - (m.bars[i - 1]!.x + m.bars[i - 1]!.w)).toBeGreaterThanOrEqual(2 - 1e-9);
    }
    expect(m.bars.map((b) => b.month)).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  });

  it('keeps the 6 h reference visible even for a shady spot', () => {
    expect(monthlyChartModel(new Array(12).fill(1)).yMax).toBe(8);
  });
});

describe('day strip', () => {
  const t0 = Date.UTC(2026, 5, 21, 12, 0); // 05:00 Vancouver (PDT)
  const step = 10 * 60_000;
  const strip = [false, true, true, true, false, false, true].map((sunlit, i) => ({ time: t0 + i * step, sunlit }));

  it('merges consecutive samples into runs', () => {
    const runs = stripRuns(strip);
    expect(runs.map((r) => r.sunlit)).toEqual([false, true, false, true]);
    expect(runs[1]!.end - runs[1]!.start).toBe(3 * step);
  });

  it('lists the sunny periods in Vancouver time', () => {
    expect(sunnyPeriods(stripRuns(strip))).toBe('05:05–05:35, 05:55–06:05');
  });
});
