// ParcelMap BC lot lookup.
import { LARGE_LOT_M2, PARCEL_BUFFER_M, PARCEL_LAYER, PARCEL_PROPERTIES, WFS_URL } from '../config';
import { localFrame } from '../geo/local';
import { distanceToGeometry, geometryArea, geometryKey, mapGeometry, type AreaGeometry, type Position } from '../geo/polygon';
import { toBcAlbers } from '../geo/proj';
import { getJson, isAbortError } from './http';
import { jsonpViaSandbox } from './jsonp';

export interface Parcel {
  id: number;
  /** lon/lat, as returned by the WFS with srsName=EPSG:4326 (verified lon-first). */
  geometry: AreaGeometry;
  parcelClass: string;
  ownerType: string;
  planNumber: string | null;
  municipality: string | null;
  regionalDistrict: string | null;
  areaM2: number;
  whenUpdated: string | null;
  containsPoint: boolean;
  /** Metres from the address point to the lot (0 when inside). */
  distanceM: number;
  /** How many identical polygons were folded into this one (strata stack one per unit). */
  duplicates: number;
}

export type LookupMethod = 'intersects' | 'buffer';

export interface ParcelLookup {
  method: LookupMethod;
  /** Best first. Empty when nothing was found even with the buffer. */
  candidates: Parcel[];
}

export type ParcelNotice = 'approximate-lines' | 'strata' | 'nearest-lot' | 'large-lot';

/** Thrown when lots come back but none contains the point: almost certainly an axis-order bug. */
export class ParcelAxisError extends Error {
  constructor() {
    super('Returned parcels do not contain the query point (axis order?)');
    this.name = 'ParcelAxisError';
  }
}

const DEPRIORITISED_CLASSES = new Set(['interest', 'road', 'right of way', 'air space']);
const CONTAINS_TOLERANCE_M = 0.5;

function wfsUrl(cqlFilter: string, count: number, format: 'json' | { callback: string }): string {
  const u = new URL(WFS_URL);
  const params: Record<string, string> = {
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: PARCEL_LAYER,
    srsName: 'EPSG:4326',
    count: String(count),
    propertyName: PARCEL_PROPERTIES.join(','),
    CQL_FILTER: cqlFilter,
    outputFormat: format === 'json' ? 'application/json' : 'text/javascript',
  };
  if (format !== 'json') params.format_options = `callback:${format.callback}`;
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** CQL wants POINT(lon lat); a flipped point silently returns nothing. */
export function intersectsFilter([lon, lat]: Position): string {
  return `INTERSECTS(SHAPE,SRID=4326;POINT(${lon} ${lat}))`;
}

/** DWITHIN in the layer's native EPSG:3005, where the distance really is metres. */
export function bufferFilter(lonLat: Position, metres = PARCEL_BUFFER_M): string {
  const [x, y] = toBcAlbers(lonLat);
  return `DWITHIN(SHAPE,POINT(${x.toFixed(2)} ${y.toFixed(2)}),${metres},meters)`;
}

export const intersectsUrl = (lonLat: Position) => wfsUrl(intersectsFilter(lonLat), 10, 'json');
export const bufferUrl = (lonLat: Position) => wfsUrl(bufferFilter(lonLat), 20, 'json');

interface RawParcelFeature {
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown>;
}
interface RawCollection {
  features?: RawParcelFeature[];
}

/** Plain fetch first; on a CORS/network TypeError, retry once over sandboxed JSONP. */
async function wfsQuery(cqlFilter: string, count: number, signal?: AbortSignal): Promise<RawCollection> {
  try {
    return await getJson<RawCollection>(wfsUrl(cqlFilter, count, 'json'), { signal });
  } catch (e) {
    if (isAbortError(e) || !(e instanceof TypeError)) throw e;
    return jsonpViaSandbox<RawCollection>((callback) => wfsUrl(cqlFilter, count, { callback }), { signal });
  }
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

function isAreaGeometry(g: RawParcelFeature['geometry']): g is AreaGeometry {
  return !!g && (g.type === 'Polygon' || g.type === 'MultiPolygon') && Array.isArray(g.coordinates);
}

function classRank(p: Parcel): number {
  return DEPRIORITISED_CLASSES.has(p.parcelClass.toLowerCase()) ? 1 : 0;
}

/** Parse, fold identical geometries, measure against the point, and rank best-first. */
export function normaliseParcels(features: RawParcelFeature[], lonLat: Position, method: LookupMethod): Parcel[] {
  const frame = localFrame(lonLat);
  const byKey = new Map<string, Parcel>();
  for (const f of features) {
    if (!isAreaGeometry(f.geometry)) continue;
    const props = f.properties ?? {};
    const local = mapGeometry(f.geometry, frame.toLocal);
    const distanceM = distanceToGeometry([0, 0], local);
    const parcel: Parcel = {
      id: Number(props.PARCEL_FABRIC_POLY_ID ?? 0),
      geometry: f.geometry,
      parcelClass: str(props.PARCEL_CLASS) ?? 'Unknown',
      ownerType: str(props.OWNER_TYPE) ?? 'Unknown',
      planNumber: str(props.PLAN_NUMBER),
      municipality: str(props.MUNICIPALITY),
      regionalDistrict: str(props.REGIONAL_DISTRICT),
      areaM2: typeof props.FEATURE_AREA_SQM === 'number' ? props.FEATURE_AREA_SQM : geometryArea(local),
      whenUpdated: str(props.WHEN_UPDATED),
      containsPoint: distanceM <= CONTAINS_TOLERANCE_M,
      distanceM,
      duplicates: 0,
    };
    const key = geometryKey(f.geometry);
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, parcel);
    else {
      // Keep the most lot-like record (a Subdivision over its Interest twin).
      const keep = classRank(parcel) < classRank(existing) ? parcel : existing;
      keep.duplicates = existing.duplicates + 1;
      byKey.set(key, keep);
    }
  }
  const parcels = [...byKey.values()];
  return parcels.sort((a, b) =>
    method === 'intersects'
      ? Number(b.containsPoint) - Number(a.containsPoint) || classRank(a) - classRank(b) || a.areaM2 - b.areaM2
      : a.distanceM - b.distanceM || classRank(a) - classRank(b) || a.areaM2 - b.areaM2,
  );
}

export async function findParcels(lonLat: Position, { signal }: { signal?: AbortSignal } = {}): Promise<ParcelLookup> {
  const hit = await wfsQuery(intersectsFilter(lonLat), 10, signal);
  const direct = normaliseParcels(hit.features ?? [], lonLat, 'intersects');
  if (direct.length > 0) {
    if (!direct.some((p) => p.containsPoint)) throw new ParcelAxisError();
    return { method: 'intersects', candidates: direct };
  }
  const near = await wfsQuery(bufferFilter(lonLat), 20, signal);
  return { method: 'buffer', candidates: normaliseParcels(near.features ?? [], lonLat, 'buffer') };
}

const STRATA_PLAN = /^[A-Z]{2}S\d+$/;

export function isStrata(p: Parcel): boolean {
  return /strata|common property/i.test(p.parcelClass) || (p.planNumber !== null && STRATA_PLAN.test(p.planNumber));
}

export function parcelNotices(p: Parcel, lookup: ParcelLookup, opts: { approximateGeocode: boolean }): ParcelNotice[] {
  const notices: ParcelNotice[] = [];
  if (lookup.method === 'buffer' || (opts.approximateGeocode && !p.containsPoint)) notices.push('nearest-lot');
  if (isStrata(p)) notices.push('strata');
  if (p.areaM2 > LARGE_LOT_M2) notices.push('large-lot');
  notices.push('approximate-lines');
  return notices;
}
