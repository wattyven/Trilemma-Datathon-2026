// Which LiDAR acquisition the mosaic's pixels come from (the newest project covering a point).
// Footprints are committed in vintage.json (spike/09-build-vintage.ts). A runtime STAC check
// catches projects NRCan publishes later, fetching only those footprints.
import { LIDAR_COLLECTION, lidarExtentUrl } from '../config';
import { getJson } from '../data/http';
import { pointInGeometry, type AreaGeometry, type Position } from '../geo/polygon';
import { searchItems } from './stac';
import data from './vintage.json';

export interface Vintage {
  id: string;
  /** Acquisition date as published in STAC (YYYY-MM-DD). */
  date: string;
  label: string;
}

interface Project extends Vintage {
  geometry: AreaGeometry;
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

export function labelFor(id: string): string {
  const base = id.replace(/-1m$/, '');
  const city = /^VILLE_(.+?)-VILLE_/.exec(base);
  if (city) return `City of ${titleCase(city[1]!.replace(/_/g, ' '))}`;
  return base.replace(/^(BC|NRCAN)-/, '$1 ').replace(/_/g, ' ');
}

const projects = (data.projects as unknown as Project[])
  .map((p) => ({ ...p, label: labelFor(p.id) }))
  .sort((a, b) => b.date.localeCompare(a.date));
const known = new Set(projects.map((p) => p.id));

/** From the committed footprints only (no network). */
export function vintageAt(lonLat: Position): Vintage | null {
  const p = projects.find((x) => pointInGeometry(lonLat, x.geometry));
  return p ? { id: p.id, date: p.date, label: p.label } : null;
}

/** Committed footprints, plus any newer project STAC knows about that the lookup doesn't. */
export async function vintageFor(lonLat: Position, signal?: AbortSignal): Promise<Vintage | null> {
  const local = vintageAt(lonLat);
  try {
    const items = await searchItems(LIDAR_COLLECTION, lonLat, 30, signal);
    const newer = items
      .map((it) => ({ id: it.id, date: String(it.properties?.datetime ?? '').slice(0, 10) }))
      .filter((it) => !known.has(it.id) && it.date && (!local || it.date > local.date))
      .sort((a, b) => b.date.localeCompare(a.date));
    for (const it of newer) {
      const ext = await getJson<{ geometry?: AreaGeometry; features?: { geometry: AreaGeometry }[] }>(lidarExtentUrl(it.id), { signal });
      const g = ext.geometry ?? ext.features?.[0]?.geometry;
      if (g && pointInGeometry(lonLat, g)) return { id: it.id, date: it.date, label: labelFor(it.id) };
    }
  } catch {
    // The date is a nicety; fall back to the committed answer.
  }
  return local;
}
