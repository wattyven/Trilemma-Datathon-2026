// Scene conventions: X = east, Y = up, Z = SOUTH, so true north is −Z. The origin is the lot's
// local frame origin (geo/local.ts); heights are metres above a base level, at 1:1.
import type { Position } from '../geo/polygon';
import type { SunSample } from '../engine/sun';

export type Vec3 = [number, number, number];

const RAD = Math.PI / 180;

export function localToScene([east, north]: Position, height: number): Vec3 {
  return [east, height, -north];
}

export function sceneToLocal([x, , z]: Vec3 | [number, number, number]): Position {
  return [x, -z];
}

/** Unit vector pointing TOWARD the sun, for a true azimuth (clockwise from north) and altitude. */
export function sunDirection(azTrueDeg: number, altDeg: number): Vec3 {
  const a = azTrueDeg * RAD, h = altDeg * RAD;
  return [Math.sin(a) * Math.cos(h), Math.sin(h), -Math.cos(a) * Math.cos(h)];
}

/** Points of the sun's arc across the sky, at `radius` from the origin, while it's above the horizon. */
export function sunPathPoints(samples: SunSample[], radius: number): Vec3[] {
  return samples
    .filter((s) => s.altDeg > 0)
    .map((s) => {
      const d = sunDirection(s.azTrueDeg, s.altDeg);
      return [d[0] * radius, d[1] * radius, d[2] * radius];
    });
}

/**
 * Clockwise rotation (degrees) for an on-screen north arrow, given OrbitControls' azimuthal
 * angle (radians; 0 = camera due south of the target looking north).
 */
export function compassRotationDeg(azimuthalAngle: number): number {
  return ((azimuthalAngle / RAD) % 360 + 360) % 360;
}
