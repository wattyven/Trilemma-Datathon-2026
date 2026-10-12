import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHttpCache } from '../src/data/http';
import { LOT_SOURCES, MUNICIPAL_ID_BASE, findMunicipalLots, lotSourceFor, municipalLotUrl } from '../src/data/municipalLots';
import { ELECTORAL_AREA_A_NAME, LOCALITY_JURISDICTION } from '../src/data/scope';

const dnv = lotSourceFor('District of North Vancouver')!;

describe('lotSourceFor', () => {
  it('finds the District of North Vancouver, and never for the City', () => {
    expect(dnv.owner).toBe('District of North Vancouver');
    expect(lotSourceFor('City of North Vancouver')).toBeNull();
  });

  it('keeps the City and the Township of Langley apart', () => {
    const city = lotSourceFor('City of Langley');
    const township = lotSourceFor('Township of Langley');
    if (city && township) expect(city.id).not.toBe(township.id);
  });

  it('has one source per jurisdiction, each over HTTPS with a licence and credit', () => {
    const ids = new Set<string>();
    for (const s of LOT_SOURCES) {
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
      expect(s.url).toMatch(/^https:\/\/.+\/(MapServer|FeatureServer)\/\d+$/);
      expect(s.licence.length).toBeGreaterThan(0);
      expect(s.credit).toContain(s.owner);
    }
  });

  it("matches each jurisdiction to its own map only, never a neighbour's", () => {
    const names = new Set([...Object.values(LOCALITY_JURISDICTION), ELECTORAL_AREA_A_NAME]);
    for (const name of names) {
      const matches = LOT_SOURCES.filter((s) => s.jurisdiction.test(name));
      expect(matches.length).toBeLessThanOrEqual(1);
      if (matches[0]) expect(matches[0].owner).toBe(name);
    }
    for (const s of LOT_SOURCES) expect(names.has(s.owner)).toBe(true); // every source is reachable
  });

  it('has no source for UBC, which the City of Vancouver map leaves out', () => {
    expect(lotSourceFor(ELECTORAL_AREA_A_NAME)).toBeNull();
  });
});

describe('municipalLotUrl', () => {
  it('queries the layer with the point in lon/lat and asks for GeoJSON back', () => {
    const u = new URL(municipalLotUrl(dnv, [-123.07, 49.32]));
    expect(u.pathname.endsWith('/MapServer/0/query')).toBe(true);
    expect(u.searchParams.get('geometry')).toBe('-123.07,49.32');
    expect(u.searchParams.get('geometryType')).toBe('esriGeometryPoint');
    expect(u.searchParams.get('inSR')).toBe('4326');
    expect(u.searchParams.get('outSR')).toBe('4326');
    expect(u.searchParams.get('f')).toBe('geojson');
    expect(u.searchParams.get('outFields')).toBe('OBJECTID'); // nothing personal
  });
});

describe('findMunicipalLots', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearHttpCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const square = { type: 'Polygon', coordinates: [[[-123.0701, 49.3199], [-123.0699, 49.3199], [-123.0699, 49.3201], [-123.0701, 49.3201], [-123.0701, 49.3199]]] };

  it('turns the lots into ParcelMap-shaped features with ids of their own', async () => {
    fetchMock.mockResolvedValue(json({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 42, geometry: square, properties: { OBJECTID: 42 } }, { type: 'Feature', geometry: null, properties: {} }] }));
    const out = await findMunicipalLots(dnv, [-123.07, 49.32]);
    expect(out).toHaveLength(1);
    expect(out[0]!.properties).toMatchObject({
      PARCEL_FABRIC_POLY_ID: MUNICIPAL_ID_BASE + 42,
      PARCEL_CLASS: 'Subdivision',
      MUNICIPALITY: 'District of North Vancouver',
      REGIONAL_DISTRICT: 'Metro Vancouver Regional District',
    });
  });

  it("marks a municipality's strata lots as strata", async () => {
    const surrey = lotSourceFor('City of Surrey')!;
    expect(new URL(municipalLotUrl(surrey, [-122.8, 49.1])).searchParams.get('outFields')).toBe('OBJECTID,LOT_TYPE2');
    fetchMock.mockResolvedValue(json({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: square, properties: { OBJECTID: 3, LOT_TYPE2: 'Standard Strata' } }, { type: 'Feature', geometry: square, properties: { OBJECTID: 4, LOT_TYPE2: 'Standard Lot' } }] }));
    const out = await findMunicipalLots(surrey, [-122.8, 49.1]);
    expect(out.map((f) => f.properties.PARCEL_CLASS)).toEqual(['Building Strata', 'Subdivision']);
  });

  it('treats an ArcGIS error (sent with HTTP 200) as a failure', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 400, message: 'Invalid query' } }));
    await expect(findMunicipalLots(dnv, [-123.07, 49.32])).rejects.toThrow(/Invalid query/);
  });
});
