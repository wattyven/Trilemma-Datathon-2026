import { describe, expect, it } from 'vitest';
import { estimateLot, nearUrl } from '../src/data/lotEstimate';
import { localFrame } from '../src/geo/local';
import { geometryArea, mapGeometry, pointInGeometry, type Position } from '../src/geo/polygon';

// A synthetic point (no real address), with neighbours placed in metres around it.
const origin: Position = [-123.0, 49.25];
const frame = localFrame(origin);
const at = (x: number, y: number) => frame.toLonLat([x, y]);
const areaM2 = (g: ReturnType<typeof estimateLot>) => geometryArea(mapGeometry(g, frame.toLocal));

describe('estimateLot', () => {
  it('is the whole square with no neighbours', () => {
    const g = estimateLot(origin, [], 20);
    expect(areaM2(g)).toBeCloseTo(1600, 0);
    const ring = g.coordinates[0]!;
    expect(ring[0]).toEqual(ring[ring.length - 1]); // closed, as GeoJSON wants
    expect(pointInGeometry(origin, g)).toBe(true);
  });

  it('stops halfway to each neighbour', () => {
    const g = estimateLot(origin, [at(10, 0), at(-16, 0)], 20);
    expect(areaM2(g)).toBeCloseTo(40 * (5 + 8), 0);
    expect(pointInGeometry(at(4.9, 0), g)).toBe(true);
    expect(pointInGeometry(at(5.1, 0), g)).toBe(false);
    expect(pointInGeometry(at(-7.9, 0), g)).toBe(true);
  });

  it('cuts diagonally for a neighbour off to one side', () => {
    const g = estimateLot(origin, [at(10, 10)], 20);
    expect(pointInGeometry(at(4.9, 4.9), g)).toBe(true);
    expect(pointInGeometry(at(5.1, 5.1), g)).toBe(false);
    expect(pointInGeometry(at(-19, -19), g)).toBe(true);
  });

  it('ignores units of the same building and far-off addresses', () => {
    const g = estimateLot(origin, [origin, at(0.5, 0), at(60, 0)], 20);
    expect(areaM2(g)).toBeCloseTo(1600, 0);
  });

  it('keeps the address point inside however crowded it is', () => {
    const ring = Array.from({ length: 12 }, (_, i) => at(6 * Math.cos((i * Math.PI) / 6), 6 * Math.sin((i * Math.PI) / 6)));
    const g = estimateLot(origin, ring, 20);
    expect(pointInGeometry(origin, g)).toBe(true);
    expect(areaM2(g)).toBeGreaterThan(20);
    expect(areaM2(g)).toBeLessThan(40);
  });
});

describe('nearUrl', () => {
  it('asks the geocoder for address points around the point, lon first', () => {
    const u = new URL(nearUrl([-123.1234567, 49.2345678]));
    expect(u.origin + u.pathname).toBe('https://geocoder.api.gov.bc.ca/sites/near.json');
    expect(u.searchParams.get('point')).toBe('-123.123457,49.234568');
    expect(u.searchParams.get('outputSRS')).toBe('4326');
    expect(u.searchParams.get('locationDescriptor')).toBe('parcelPoint');
    expect(Number(u.searchParams.get('maxDistance'))).toBeGreaterThanOrEqual(40); // twice the square's half-size
  });
});
