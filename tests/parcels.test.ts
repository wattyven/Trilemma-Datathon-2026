import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHttpCache } from '../src/data/http';
import {
  ParcelAxisError,
  bufferFilter,
  findParcels,
  intersectsFilter,
  isStrata,
  normaliseParcels,
  parcelNotices,
  type Parcel,
} from '../src/data/parcels';
import type { Position } from '../src/geo/polygon';
import coqBuffer from './fixtures/wfs-coq-buffer.json';
import coqEmpty from './fixtures/wfs-coq-empty.json';
import pointsJson from './fixtures/points.json';
import strata from './fixtures/wfs-strata.json';
import surrey from './fixtures/wfs-surrey-twins.json';
import van from './fixtures/wfs-van.json';

vi.mock('../src/data/jsonp', () => ({ jsonpViaSandbox: vi.fn() }));
const { jsonpViaSandbox } = await import('../src/data/jsonp');

const points = pointsJson as Record<'van' | 'surrey' | 'strata' | 'coqBlock', Position>;
type Features = Parameters<typeof normaliseParcels>[0];

describe('CQL filters', () => {
  it('puts longitude first in the point', () => {
    expect(intersectsFilter([-123.1139388, 49.261317])).toBe('INTERSECTS(SHAPE,SRID=4326;POINT(-123.1139388 49.261317))');
  });

  it('buffers in BC Albers metres', () => {
    const f = bufferFilter(points.van, 15);
    const m = /^DWITHIN\(SHAPE,POINT\(([\d.]+) ([\d.]+)\),15,meters\)$/.exec(f);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo(1_210_208, -1); // EPSG:3005 easting from Phase 0
    expect(Number(m![2])).toBeCloseTo(475_949, -1);
  });
});

describe('normaliseParcels', () => {
  it('reads a single containing lot', () => {
    const [p, ...rest] = normaliseParcels(van.features as Features, points.van, 'intersects');
    expect(rest).toHaveLength(0);
    expect(p!.containsPoint).toBe(true);
    expect(p!.distanceM).toBe(0);
    expect(p!.parcelClass).toBe('Subdivision');
    expect(p!.municipality).toBe('Vancouver, City of');
    expect(p!.regionalDistrict).toBe('Metro Vancouver Regional District');
  });

  it('folds an Interest twin into its Subdivision lot', () => {
    expect(surrey.features.length).toBe(2);
    const out = normaliseParcels(surrey.features as Features, points.surrey, 'intersects');
    expect(out).toHaveLength(1);
    expect(out[0]!.parcelClass).toBe('Subdivision');
    expect(out[0]!.duplicates).toBe(1);
  });

  it('folds a strata stack into one complex outline', () => {
    expect(strata.features.length).toBeGreaterThan(1);
    const out = normaliseParcels(strata.features as Features, points.strata, 'intersects');
    expect(out).toHaveLength(1);
    expect(isStrata(out[0]!)).toBe(true);
    expect(out[0]!.duplicates).toBe(strata.features.length - 1);
  });

  it('orders buffered candidates by distance', () => {
    const out = normaliseParcels(coqBuffer.features as Features, points.coqBlock, 'buffer');
    expect(out.length).toBeGreaterThan(0);
    for (let i = 1; i < out.length; i++) expect(out[i]!.distanceM).toBeGreaterThanOrEqual(out[i - 1]!.distanceM);
    expect(out[0]!.containsPoint).toBe(false);
    expect(out[0]!.distanceM).toBeLessThan(15);
  });
});

describe('findParcels', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearHttpCache();
    fetchMock.mockReset();
    vi.mocked(jsonpViaSandbox).mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const cql = (call: unknown[]) => new URL(String(call[0])).searchParams.get('CQL_FILTER') ?? '';

  it('returns the containing lot directly', async () => {
    fetchMock.mockResolvedValue(json(van));
    const r = await findParcels(points.van);
    expect(r.method).toBe('intersects');
    expect(r.candidates).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const p = new URL(String(fetchMock.mock.calls[0]![0])).searchParams;
    expect(p.get('typeNames')).toBe('WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW');
    expect(p.get('srsName')).toBe('EPSG:4326');
    expect(p.get('outputFormat')).toBe('application/json');
  });

  it('retries with a 15 m buffer when the point hits no lot', async () => {
    fetchMock.mockImplementation(async (url: string) => json(cql([url]).startsWith('DWITHIN') ? coqBuffer : coqEmpty));
    const r = await findParcels(points.coqBlock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cql(fetchMock.mock.calls[1]!)).toMatch(/^DWITHIN\(SHAPE,POINT\([\d.]+ [\d.]+\),15,meters\)$/);
    expect(r.method).toBe('buffer');
    expect(r.candidates[0]!.distanceM).toBeLessThan(15);
    expect(parcelNotices(r.candidates[0]!, r, { approximateGeocode: true })).toContain('nearest-lot');
  });

  it('refuses lots that do not contain the point (axis-order guard)', async () => {
    fetchMock.mockResolvedValue(json(van)); // Vancouver City Hall's lot, but queried from Surrey
    await expect(findParcels(points.surrey)).rejects.toBeInstanceOf(ParcelAxisError);
  });

  it('falls back to sandboxed JSONP when fetch fails with a CORS/network TypeError', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.mocked(jsonpViaSandbox).mockResolvedValue(van);
    const r = await findParcels(points.van);
    expect(r.candidates).toHaveLength(1);
    const buildUrl = vi.mocked(jsonpViaSandbox).mock.calls[0]![0];
    const p = new URL(buildUrl('cb')).searchParams;
    expect(p.get('outputFormat')).toBe('text/javascript');
    expect(p.get('format_options')).toBe('callback:cb');
  });

  it('does not fall back on HTTP errors', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }));
    await expect(findParcels(points.van)).rejects.toThrow(/503/);
    expect(jsonpViaSandbox).not.toHaveBeenCalled();
  });
});

describe('parcelNotices', () => {
  const lot = (over: Partial<Parcel>): Parcel => ({
    id: 1, geometry: { type: 'Polygon', coordinates: [] }, parcelClass: 'Subdivision', ownerType: 'Private', planNumber: 'LMP1',
    municipality: null, regionalDistrict: null, areaM2: 600, whenUpdated: null, containsPoint: true, distanceM: 0, duplicates: 0,
    ...over,
  });
  const direct = { method: 'intersects' as const, candidates: [] };

  it('always ends with the approximate-lines caveat', () => {
    expect(parcelNotices(lot({}), direct, { approximateGeocode: false })).toEqual(['approximate-lines']);
  });

  it('flags strata plans', () => {
    expect(parcelNotices(lot({ planNumber: 'NWS3458' }), direct, { approximateGeocode: false })).toContain('strata');
    expect(parcelNotices(lot({ planNumber: 'EPP76647' }), direct, { approximateGeocode: false })).not.toContain('strata');
  });
});
