import { describe, expect, it } from 'vitest';
import { clampMinute, dayMinuteRange, minuteLabel } from '../src/ui/timeline';

describe('timeline', () => {
  it('spans sunrise to sunset on the slider, snapped to 5 minutes', () => {
    const r = dayMinuteRange({ year: 2026, month: 6, day: 21 }, 49.2613, -123.1139); // Vancouver City Hall
    expect(minuteLabel(r.min)).toBe('05:05'); // sunrise 05:06
    expect(minuteLabel(r.max)).toBe('21:25'); // sunset 21:21
  });

  it('clamps and rounds to the slider step', () => {
    const r = { min: 300, max: 1285 };
    expect(clampMinute(12, r)).toBe(300);
    expect(clampMinute(2000, r)).toBe(1285);
    expect(clampMinute(722, r)).toBe(720);
  });

  it('formats wall-clock minutes', () => {
    expect(minuteLabel(0)).toBe('00:00');
    expect(minuteLabel(12 * 60 + 5)).toBe('12:05');
  });
});
