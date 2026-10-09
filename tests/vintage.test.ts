import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHttpCache } from '../src/data/http';
import { labelFor, vintageAt, vintageFor } from '../src/elevation/vintage';
import pointsJson from './fixtures/points.json';

const points = pointsJson as unknown as Record<string, [number, number]>;
const MAPLE_RIDGE: [number, number] = [-122.5999606, 49.2193815]; // 11995 Haney Pl (FHIMP 2023, matched pixel by pixel)

describe('vintageAt (committed footprints)', () => {
  it('matches the pixel-verified sources from Phase 0', () => {
    expect(vintageAt(points.van!)?.id).toBe('BC-Lower_Mainland_2016-1m');
    expect(vintageAt(points.surrey!)?.id).toBe('BC-Lower_Mainland_2016-1m');
    expect(vintageAt(MAPLE_RIDGE)?.id).toBe('NRCAN-FHIMP_PICAI_BC_South_West_UTM10_2023-1m');
    expect(vintageAt(MAPLE_RIDGE)?.date).toBe('2023-08-13');
  });

  it('returns null outside every footprint', () => {
    expect(vintageAt([-124.5, 49.3])).toBeNull();
  });

  it('labels projects readably', () => {
    expect(labelFor('BC-Lower_Mainland_2016-1m')).toBe('BC Lower Mainland 2016');
    expect(labelFor('VILLE_VANCOUVER-VILLE_VANCOUVER-1m')).toBe('City of Vancouver');
    expect(labelFor('VILLE_NORTH_VANCOUVER-VILLE_NORTH_VANCOUVER-1m')).toBe('City of North Vancouver');
  });
});

describe('vintageFor (runtime STAC check)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearHttpCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

  it('prefers a newer project the lookup does not know, if its footprint covers the point', async () => {
    const [lon, lat] = points.van!;
    const square = { type: 'Polygon', coordinates: [[[lon - 0.01, lat - 0.01], [lon + 0.01, lat - 0.01], [lon + 0.01, lat + 0.01], [lon - 0.01, lat + 0.01], [lon - 0.01, lat - 0.01]]] };
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/stac/') ? json({ features: [{ id: 'NRCAN-Vancouver_2027-1m', properties: { datetime: '2027-05-01T12:00:00Z' } }] }) : json({ type: 'Feature', geometry: square }),
    );
    expect(await vintageFor(points.van!)).toEqual({ id: 'NRCAN-Vancouver_2027-1m', date: '2027-05-01', label: 'NRCAN Vancouver 2027' });
  });

  it('falls back to the committed answer when STAC fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect((await vintageFor(points.van!))?.id).toBe('BC-Lower_Mainland_2016-1m');
  });
});
