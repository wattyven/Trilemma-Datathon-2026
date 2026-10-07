// BC Address Geocoder client.
import { AUTOCOMPLETE, GEOCODER_URL, METRO_BBOX, MIN_CONFIDENT_SCORE } from '../config';
import type { Position } from '../geo/polygon';
import { getJson } from './http';
import { isInScope } from './scope';

export interface GeocodeMatch {
  fullAddress: string;
  lonLat: Position;
  score: number;
  matchPrecision: string;
  localityName: string;
  localityType: string;
  electoralArea: string;
  /** What the geocoder actually returned. BLOCK matches fall back to `accessPoint` (in the street). */
  locationDescriptor: string;
  /** True when the point isn't a parcelPoint, so it may sit outside the lot. */
  approximate: boolean;
}

interface RawFeature {
  geometry?: { coordinates?: unknown };
  properties?: Record<string, unknown>;
}

const PRECISE = new Set(['CIVIC_NUMBER', 'SITE', 'UNIT', 'OCCUPANT']);
const COARSE = new Set(['STREET', 'INTERSECTION', 'LOCALITY', 'PROVINCE']);

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function parseFeature(f: RawFeature): GeocodeMatch | null {
  const c = f.geometry?.coordinates;
  const p = f.properties ?? {};
  if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') return null;
  const matchPrecision = str(p.matchPrecision);
  const locationDescriptor = str(p.locationDescriptor);
  return {
    fullAddress: str(p.fullAddress),
    lonLat: [c[0], c[1]],
    score: typeof p.score === 'number' ? p.score : 0,
    matchPrecision,
    localityName: str(p.localityName),
    localityType: str(p.localityType),
    electoralArea: str(p.electoralArea),
    locationDescriptor,
    approximate: locationDescriptor !== 'parcelPoint' || !PRECISE.has(matchPrecision),
  };
}

function buildUrl(params: Record<string, string | number | boolean>): string {
  const u = new URL(GEOCODER_URL);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

const BBOX = `${METRO_BBOX.minLon},${METRO_BBOX.minLat},${METRO_BBOX.maxLon},${METRO_BBOX.maxLat}`;

/**
 * Autocomplete URL. Not `brief=true`: brief responses drop `localityName`, which scope needs.
 * Street- and block-level guesses are excluded; only real civic addresses are suggested.
 */
export function suggestUrl(query: string): string {
  return buildUrl({
    addressString: query.trim(),
    autoComplete: true,
    maxResults: AUTOCOMPLETE.maxRequested,
    outputSRS: 4326,
    locationDescriptor: 'parcelPoint',
    bbox: BBOX,
    matchPrecisionNot: 'STREET,BLOCK,INTERSECTION,LOCALITY,PROVINCE',
    echo: false,
  });
}

/** Free-text submit URL. No bbox, so an out-of-area address is reported as such, not swapped. */
export function resolveUrl(query: string): string {
  return buildUrl({
    addressString: query.trim(),
    maxResults: 1,
    outputSRS: 4326,
    locationDescriptor: 'parcelPoint',
    echo: false,
  });
}

interface FeatureCollection {
  features?: RawFeature[];
}

export async function suggest(query: string, signal?: AbortSignal): Promise<GeocodeMatch[]> {
  const fc = await getJson<FeatureCollection>(suggestUrl(query), { signal });
  return filterSuggestions(fc.features ?? []);
}

export function filterSuggestions(features: RawFeature[]): GeocodeMatch[] {
  const seen = new Set<string>();
  const out: GeocodeMatch[] = [];
  for (const f of features) {
    const m = parseFeature(f);
    if (!m || !m.fullAddress || seen.has(m.fullAddress) || !isInScope(m)) continue;
    seen.add(m.fullAddress);
    out.push(m);
    if (out.length === AUTOCOMPLETE.maxShown) break;
  }
  return out;
}

export type ResolveOutcome =
  | { kind: 'ok'; match: GeocodeMatch }
  | { kind: 'not-found' }
  | { kind: 'low-confidence'; match: GeocodeMatch }
  | { kind: 'coarse'; match: GeocodeMatch }
  | { kind: 'out-of-area'; match: GeocodeMatch };

export function classify(match: GeocodeMatch | null): ResolveOutcome {
  if (!match) return { kind: 'not-found' };
  if (match.score < MIN_CONFIDENT_SCORE) return { kind: 'low-confidence', match };
  if (COARSE.has(match.matchPrecision)) return { kind: 'coarse', match };
  if (!isInScope(match)) return { kind: 'out-of-area', match };
  return { kind: 'ok', match };
}

export async function resolve(query: string, signal?: AbortSignal): Promise<ResolveOutcome> {
  const fc = await getJson<FeatureCollection>(resolveUrl(query), { signal });
  const first = fc.features?.[0];
  return classify(first ? parseFeature(first) : null);
}
