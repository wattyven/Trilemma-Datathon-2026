// NRCan STAC lookups (docs/DATA_SOURCES.md §4.1). Plain GETs only: the API 403s preflights.
import { MOSAIC_COLLECTION, STAC_URL } from '../config';
import { getJson } from '../data/http';
import type { Position } from '../geo/polygon';

export interface MosaicItem {
  id: string;
  dsm: string;
  dtm: string;
}

export interface StacItem {
  id: string;
  properties?: { datetime?: string };
  assets?: Record<string, { href?: string }>;
  geometry?: unknown;
}

export function searchUrl(collection: string, lonLat: Position, limit: number): string {
  const u = new URL(`${STAC_URL}/search`);
  u.searchParams.set('collections', collection);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('intersects', JSON.stringify({ type: 'Point', coordinates: lonLat }));
  return u.toString();
}

export async function searchItems(collection: string, lonLat: Position, limit: number, signal?: AbortSignal): Promise<StacItem[]> {
  const fc = await getJson<{ features?: StacItem[] }>(searchUrl(collection, lonLat, limit), { signal });
  return fc.features ?? [];
}

/** The 1 m mosaic tile covering a point, or null where there's no coverage at all. */
export async function findMosaicItem(lonLat: Position, signal?: AbortSignal): Promise<MosaicItem | null> {
  const [item] = await searchItems(MOSAIC_COLLECTION, lonLat, 1, signal);
  const dsm = item?.assets?.dsm?.href;
  const dtm = item?.assets?.dtm?.href;
  return item && dsm && dtm ? { id: item.id, dsm, dtm } : null;
}
