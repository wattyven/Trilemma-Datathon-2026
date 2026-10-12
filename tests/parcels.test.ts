import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHttpCache } from '../src/data/http';
import {
  ESTIMATE_LOT_ID,
  ParcelAxisError,
  bufferFilter,
  findLot,
  findParcels,
  intersectsFilter,
  isStrata,
  normaliseParcels,
  parcelNotices,
  type Parcel,
} from '../src/data/parcels';
import { localFrame } from '../src/geo/local';
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

describe('findLot', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearHttpCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  // A synthetic address point (no real home) and lots drawn in metres around it.
  const point: Position = [-123.07, 49.335];
  const frame = localFrame(point);
  const rect = (x0: number, y0: number, x1: number, y1: number) => ({
    type: 'Polygon',
    coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map((p) => frame.toLonLat(p as Position))],
  });
  const wfsLot = (geometry: unknown, id: number) => ({
    type: 'Feature', geometry,
    properties: { PARCEL_FABRIC_POLY_ID: id, PARCEL_CLASS: 'Subdivision', MUNICIPALITY: 'North Vancouver, The Corporation of the District of', REGIONAL_DISTRICT: 'Metro Vancouver Regional District' },
  });
  const fc = (features: unknown[]) => ({ type: 'FeatureCollection', features });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const exact = { lonLat: point, approximate: false, jurisdiction: 'District of North Vancouver' };
  const neighbourLot = wfsLot(rect(8, -20, 23, 20), 7); // the lot next door, 8 m east
  const hosts = () => fetchMock.mock.calls.map((c) => new URL(String(c[0])).host);

  /** Routes each service: ParcelMap BC (intersects, then the buffer), the District's lot map, the geocoder's neighbours. */
  function serve({ intersects = fc([]), buffer = fc([neighbourLot]), municipal = fc([{ type: 'Feature', id: 9, geometry: rect(-7, -18, 7, 18), properties: { OBJECTID: 9 } }]) as unknown, near = fc([]) } = {}) {
    fetchMock.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.host === 'openmaps.gov.bc.ca') return json((u.searchParams.get('CQL_FILTER') ?? '').startsWith('DWITHIN') ? buffer : intersects);
      if (u.host === 'geoweb.dnv.org') return municipal instanceof Response ? municipal : json(municipal);
      if (u.pathname.endsWith('/sites/near.json')) return json(near);
      throw new Error(`unexpected ${url}`);
    });
  }

  it("keeps ParcelMap BC's lot when the point is in one", async () => {
    serve({ intersects: fc([wfsLot(rect(-7, -18, 7, 18), 5)]) });
    const r = await findLot(exact);
    expect(r.method).toBe('intersects');
    expect(r.candidates[0]!.origin).toBeUndefined();
    expect(hosts()).toEqual(['openmaps.gov.bc.ca']);
  });

  it("asks the municipality's lot map when an exact point is in no ParcelMap lot, and still offers the neighbour", async () => {
    serve();
    const r = await findLot(exact);
    expect(r.method).toBe('municipal');
    const [own, next] = r.candidates;
    expect(own).toMatchObject({ origin: 'municipal', sourceName: 'District of North Vancouver', containsPoint: true });
    expect(own!.areaM2).toBeCloseTo(14 * 36, -1);
    expect(next!.id).toBe(7);
    expect(parcelNotices(own!, r, { approximateGeocode: false })).toEqual(['approximate-lines']);
    expect(parcelNotices(next!, r, { approximateGeocode: false })).toContain('nearest-lot');
  });

  it('never asks the District for a City of North Vancouver address', async () => {
    serve();
    const r = await findLot({ ...exact, jurisdiction: 'City of North Vancouver' });
    expect(r.method).toBe('estimate');
    expect(hosts()).not.toContain('geoweb.dnv.org');
  });

  it('estimates the outline from the neighbouring addresses where no lot map has it', async () => {
    serve({ buffer: fc([]), near: fc([{ geometry: { type: 'Point', coordinates: frame.toLonLat([12, 0]) } }]) });
    const r = await findLot({ ...exact, jurisdiction: 'City of Surrey' });
    expect(r.method).toBe('estimate');
    expect(r.candidates).toHaveLength(1);
    const est = r.candidates[0]!;
    expect(est).toMatchObject({ origin: 'estimate', id: ESTIMATE_LOT_ID, containsPoint: true, regionalDistrict: 'Metro Vancouver Regional District' });
    expect(est.areaM2).toBeCloseTo(40 * 26, -1); // the 40 m square, cut 6 m east of the point
    expect(parcelNotices(est, r, { approximateGeocode: false })).toEqual(['estimated-lot']);
  });

  it("falls back to the estimate when the municipality's map fails", async () => {
    serve({ municipal: new Response('down', { status: 503 }) });
    const r = await findLot(exact);
    expect(r.method).toBe('estimate');
    expect(r.candidates.map((c) => c.id)).toEqual([ESTIMATE_LOT_ID, 7]);
  });

  it('still estimates when the neighbouring addresses are unavailable', async () => {
    fetchMock.mockImplementation(async (url: string) => (new URL(url).host === 'openmaps.gov.bc.ca' ? json(fc([])) : new Response('down', { status: 503 })));
    const r = await findLot({ ...exact, jurisdiction: 'City of Surrey' });
    expect(r.candidates[0]!.areaM2).toBeCloseTo(1600, -1);
  });

  it('takes a lot the exact point sits on the edge of', async () => {
    serve({ buffer: fc([wfsLot(rect(1, -18, 15, 18), 8)]) });
    const r = await findLot(exact);
    expect(r.method).toBe('buffer');
    expect(r.candidates[0]!.id).toBe(8);
  });

  it('leaves block and street matches to the buffered search', async () => {
    serve();
    const r = await findLot({ ...exact, approximate: true });
    expect(r.method).toBe('buffer');
    expect(r.candidates[0]!.id).toBe(7);
    expect(hosts()).toEqual(['openmaps.gov.bc.ca', 'openmaps.gov.bc.ca']);
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
