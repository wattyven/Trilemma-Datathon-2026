import { describe, expect, it } from 'vitest';
import { clampMinute, dayMinuteRange, middayMinute, minuteLabel, sunriseSunset } from '../src/ui/timeline';

describe('timeline', () => {
  it('spans sunrise to sunset on the slider, snapped to 5 minutes', () => {
    const r = dayMinuteRange({ year: 2026, month: 6, day: 21 }, 49.2613, -123.1139); // Vancouver City Hall
    expect(minuteLabel(r.min)).toBe('05:05'); // sunrise 05:06
    expect(minuteLabel(r.max)).toBe('21:25'); // sunset 21:21
  });

  it('opens a dark "now" at midday: halfway between sunrise and sunset', () => {
    const r = dayMinuteRange({ year: 2026, month: 12, day: 21 }, 49.2613, -123.1139);
    const noon = middayMinute(r);
    expect(noon % 5).toBe(0);
    expect(minuteLabel(noon)).toMatch(/^1[23]:/); // 1:15 pm under permanent UTC−7 (tz data 2026b), 12:15 with older tz data
    expect(clampMinute(23 * 60, r)).toBe(r.max); // a late-night time would otherwise sit on sunset
  });

  it("gives the day's sunrise and sunset for the label under the slider", async () => {
    const t = sunriseSunset({ year: 2026, month: 6, day: 21 }, 49.2613, -123.1139)!;
    expect(t).toEqual({ sunrise: '05:06', sunset: '21:21' });
    const { copy, fmtTime } = await import('../src/copy');
    expect(copy.timeline.sunTimes(fmtTime(t.sunrise), fmtTime(t.sunset))).toBe('Sunrise 5:06 am · Sunset 9:21 pm');
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
