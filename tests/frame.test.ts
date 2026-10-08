import { describe, expect, it } from 'vitest';
import { daySamples } from '../src/engine/sun';
import { compassRotationDeg, localToScene, sceneToLocal, sunDirection, sunPathPoints } from '../src/scene/frame';

const close = (a: number[], b: number[], d = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, d));

describe('scene axes: X east, Y up, Z south', () => {
  it('maps local north to −Z and east to +X', () => {
    expect(localToScene([0, 10], 2)).toEqual([0, 2, -10]);
    expect(localToScene([5, 0], 0)).toEqual([5, 0, -0]);
    expect(sceneToLocal([3, 7, -4])).toEqual([3, 4]);
  });

  it('points toward the sun', () => {
    close(sunDirection(180, 30), [0, 0.5, Math.sqrt(3) / 2]); // south: +Z
    close(sunDirection(90, 0), [1, 0, 0]); // east
    close(sunDirection(0, 0), [0, 0, -1]); // north
    close(sunDirection(270, 90), [0, 1, 0], 9); // zenith
  });

  it('draws the June sun path above the horizon, rising in the north-east', () => {
    const samples = daySamples({ year: 2026, month: 6, day: 21 }, 49.2613, -123.1139, 10);
    const pts = sunPathPoints(samples, 100);
    expect(pts.length).toBe(samples.filter((s) => s.altDeg > 0).length);
    for (const p of pts) expect(p[1]).toBeGreaterThan(0);
    const first = pts[0]!;
    expect(first[0]).toBeGreaterThan(0); // east
    expect(first[2]).toBeLessThan(0); // north
    for (const p of pts) expect(Math.hypot(...p)).toBeCloseTo(100, 6);
  });

  it('turns the compass clockwise as the camera orbits clockwise', () => {
    expect(compassRotationDeg(0)).toBe(0); // camera due south, north is up
    expect(compassRotationDeg(Math.PI / 2)).toBeCloseTo(90, 9); // camera due east, north is to the right
    expect(compassRotationDeg(-Math.PI / 2)).toBeCloseTo(270, 9);
  });
});
