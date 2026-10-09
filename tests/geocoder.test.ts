import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classify, filterSuggestions, parseFeature, resolve, resolveUrl, suggest, suggestUrl } from '../src/data/geocoder';
import { clearHttpCache } from '../src/data/http';
import resolveCnv from './fixtures/resolve-cnv.json';
import resolveCoq from './fixtures/resolve-coq-block.json';
import resolveDnv from './fixtures/resolve-dnv.json';
import resolveStreet from './fixtures/resolve-street.json';
import resolveVan from './fixtures/resolve-van.json';
import resolveVictoria from './fixtures/resolve-victoria.json';
import suggest453 from './fixtures/suggest-453-w-12.json';

const first = (fc: { features: unknown[] }) => parseFeature(fc.features[0] as Parameters<typeof parseFeature>[0]);

describe('request URLs', () => {
  it('autocomplete asks for parcel points inside the region, civic numbers only, and never brief', () => {
    const u = new URL(suggestUrl('  453 W 12 '));
    const p = u.searchParams;
    expect(u.origin + u.pathname).toBe('https://geocoder.api.gov.bc.ca/addresses.json');
    expect(p.get('addressString')).toBe('453 W 12');
    expect(p.get('autoComplete')).toBe('true');
    expect(p.get('locationDescriptor')).toBe('parcelPoint');
    expect(p.get('outputSRS')).toBe('4326');
    expect(p.get('bbox')).toBe('-123.5,49,-122.2,49.6');
    expect(p.get('matchPrecisionNot')?.split(',')).toEqual(expect.arrayContaining(['STREET', 'BLOCK', 'LOCALITY']));
    expect(p.has('brief')).toBe(false); // brief responses drop localityName
  });

  it('free-text resolve has no bbox, so out-of-area addresses are reported, not swapped', () => {
    const p = new URL(resolveUrl('1 Centennial Sq, Victoria')).searchParams;
    expect(p.get('maxResults')).toBe('1');
    expect(p.get('locationDescriptor')).toBe('parcelPoint');
    expect(p.has('bbox')).toBe(false);
    expect(p.has('autoComplete')).toBe(false);
    expect(p.has('brief')).toBe(false);
  });
});

describe('parseFeature', () => {
  it('reads a civic-number parcel point as exact', () => {
    const m = first(resolveVan)!;
    expect(m.fullAddress).toBe('453 W 12th Ave, Vancouver, BC');
    expect(m.lonLat[0]).toBeLessThan(-123); // lon first
    expect(m.lonLat[1]).toBeGreaterThan(49);
    expect(m.matchPrecision).toBe('CIVIC_NUMBER');
    expect(m.locationDescriptor).toBe('parcelPoint');
    expect(m.approximate).toBe(false);
  });

  it('flags a BLOCK match, whose point fell back to accessPoint, as approximate', () => {
    const m = first(resolveCoq)!;
    expect(m.matchPrecision).toBe('BLOCK');
    expect(m.locationDescriptor).toBe('accessPoint');
    expect(m.approximate).toBe(true);
  });

  it('rejects features without coordinates', () => {
    expect(parseFeature({ properties: { fullAddress: 'x' } })).toBeNull();
  });
});

describe('classify', () => {
  it('accepts in-region civic addresses', () => {
    expect(classify(first(resolveVan)).kind).toBe('ok');
  });

  it('keeps the City and the District of North Vancouver apart', () => {
    const cnv = classify(first(resolveCnv));
    const dnv = classify(first(resolveDnv));
    expect(cnv.kind).toBe('ok');
    expect(dnv.kind).toBe('ok');
    if (cnv.kind === 'ok' && dnv.kind === 'ok') {
      expect(cnv.match.localityName).toBe('North Vancouver');
      expect(dnv.match.localityName).toBe('District of North Vancouver');
    }
  });

  it('proceeds with BLOCK matches (the lot lookup will buffer)', () => {
    expect(classify(first(resolveCoq)).kind).toBe('ok');
  });

  it('reports out-of-area addresses', () => {
    expect(classify(first(resolveVictoria)).kind).toBe('out-of-area');
  });

  it('reports street-only matches as coarse', () => {
    expect(classify(first(resolveStreet)).kind).toBe('coarse');
  });

  it('asks "did you mean" below the confidence threshold', () => {
    const m = { ...first(resolveVan)!, score: 55 };
    expect(classify(m).kind).toBe('low-confidence');
  });

  it('reports nothing found', () => {
    expect(classify(null).kind).toBe('not-found');
  });
});

describe('filterSuggestions', () => {
  it('returns at most five in-region suggestions, best first', () => {
    const out = filterSuggestions(suggest453.features as never[]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out[0]!.fullAddress).toBe('453 W 12th Ave, Vancouver, BC');
  });

  it('drops out-of-scope and duplicate addresses', () => {
    const base = resolveVan.features[0]!;
    const abbotsford = { ...base, properties: { ...base.properties, fullAddress: '1 Main St, Abbotsford, BC', localityName: 'Abbotsford' } };
    const out = filterSuggestions([base, base, abbotsford] as never[]);
    expect(out.map((m) => m.fullAddress)).toEqual(['453 W 12th Ave, Vancouver, BC']);
  });
});

describe('network calls', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearHttpCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const respond = (body: unknown) => fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

  it('suggest() calls the autocomplete URL and filters', async () => {
    respond(suggest453);
    const out = await suggest('453 W 12');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(suggestUrl('453 W 12'));
    expect(out[0]!.fullAddress).toBe('453 W 12th Ave, Vancouver, BC');
  });

  it('resolve() classifies the first match', async () => {
    respond(resolveVictoria);
    expect((await resolve('1 Centennial Sq, Victoria')).kind).toBe('out-of-area');
  });

  it('resolve() reports an empty collection as not found', async () => {
    respond({ type: 'FeatureCollection', features: [] });
    expect((await resolve('zzzz')).kind).toBe('not-found');
  });
});

describe('use my location', async () => {
  const { nearestUrl, parseNearest } = await import('../src/data/geocoder');
  const fixture = (await import('./fixtures/geocoder-nearest-cityhall.json')).default;
  it('asks for the nearest address within 100 m, in lon/lat', () => {
    const u = new URL(nearestUrl([-123.1139, 49.2613]));
    expect(u.origin + u.pathname).toBe('https://geocoder.api.gov.bc.ca/sites/nearest.json');
    expect(Object.fromEntries(u.searchParams)).toEqual({ point: '-123.113900,49.261300', outputSRS: '4326', maxDistance: '100' });
  });

  it('reads the address from a hit, and null from an empty answer', () => {
    expect(parseNearest(fixture as never)).toBe('2699 Yukon St, Vancouver, BC');
    expect(parseNearest({ features: [] })).toBeNull();
  });
});
