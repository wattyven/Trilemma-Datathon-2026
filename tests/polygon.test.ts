import { describe, expect, it } from 'vitest';
import { frameForGeometry, localFrame } from '../src/geo/local';
import {
  distanceToGeometry,
  geometryArea,
  geometryKey,
  mapGeometry,
  pointInGeometry,
  type AreaGeometry,
} from '../src/geo/polygon';
import strata from './fixtures/wfs-strata.json';
import surrey from './fixtures/wfs-surrey-twins.json';
import van from './fixtures/wfs-van.json';

const square = (x0: number, y0: number, s: number) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]] as [number, number][];
const donut: AreaGeometry = { type: 'Polygon', coordinates: [square(0, 0, 10), square(4, 4, 2)] };

describe('pointInGeometry', () => {
  it('respects holes', () => {
    expect(pointInGeometry([1, 1], donut)).toBe(true);
    expect(pointInGeometry([5, 5], donut)).toBe(false);
    expect(pointInGeometry([11, 5], donut)).toBe(false);
  });

  it('handles multipolygons', () => {
    const mp: AreaGeometry = { type: 'MultiPolygon', coordinates: [[square(0, 0, 1)], [square(5, 5, 1)]] };
    expect(pointInGeometry([5.5, 5.5], mp)).toBe(true);
    expect(pointInGeometry([3, 3], mp)).toBe(false);
  });
});

describe('geometryArea / distanceToGeometry', () => {
  it('subtracts holes', () => {
    expect(geometryArea(donut)).toBe(96);
  });

  it('measures distance to the nearest edge, zero inside', () => {
    expect(distanceToGeometry([12, 5], donut)).toBe(2);
    expect(distanceToGeometry([5, 5], donut)).toBe(1); // inside the hole: 1 m to the hole's edge
    expect(distanceToGeometry([1, 1], donut)).toBe(0);
  });
});

describe('local frame', () => {
  it.each([
    ['Vancouver City Hall', van],
    ['Surrey City Hall', surrey],
    ['Big Bend industrial strata', strata],
  ])('reproduces ParcelMap BC area within 1%% (%s)', (_name, fc) => {
    const f = fc.features[0]!;
    const g = f.geometry as AreaGeometry;
    const frame = frameForGeometry(g);
    const area = geometryArea(mapGeometry(g, frame.toLocal));
    expect(Math.abs(area - f.properties.FEATURE_AREA_SQM) / f.properties.FEATURE_AREA_SQM).toBeLessThan(0.01);
  });

  it('puts true north on +y and east on +x, and round-trips', () => {
    const frame = localFrame([-123.1139, 49.2613]); // Vancouver City Hall
    const [xN, yN] = frame.toLocal([-123.1139, 49.2623]);
    expect(xN).toBeCloseTo(0, 6);
    expect(yN).toBeCloseTo(111.19, 1); // 0.001° of latitude
    const [xE, yE] = frame.toLocal([-123.1129, 49.2613]);
    expect(xE).toBeGreaterThan(70);
    expect(yE).toBeCloseTo(0, 6);
    const back = frame.toLonLat(frame.toLocal([-123.1136, 49.2616]));
    expect(back[0]).toBeCloseTo(-123.1136, 10);
    expect(back[1]).toBeCloseTo(49.2616, 10);
  });

  it('centres the frame inside a convex lot', () => {
    const g = van.features[0]!.geometry as AreaGeometry;
    const frame = frameForGeometry(g);
    expect(pointInGeometry(frame.origin, g)).toBe(true);
  });
});

describe('geometryKey', () => {
  it('matches identical geometries and separates different ones', () => {
    const [a, b] = surrey.features;
    expect(geometryKey(a!.geometry as AreaGeometry)).toBe(geometryKey(b!.geometry as AreaGeometry));
    expect(geometryKey(a!.geometry as AreaGeometry)).not.toBe(geometryKey(van.features[0]!.geometry as AreaGeometry));
  });
});
