// An estimated lot outline, for an exact address point that no lot map covers: the area nearer this
// address than any neighbouring one (a Voronoi cell of the geocoder's address points), within a square
// around it. Rough, so the app labels it as an estimate and offers the nearby lots too.
import { GEOCODER_NEAR_URL, LOT_ESTIMATE } from '../config';
import { localFrame } from '../geo/local';
import type { PolygonGeometry, Position, Ring } from '../geo/polygon';
import { getJson } from './http';

/** Keeps the part of a convex polygon where n·p ≤ c (Sutherland–Hodgman against one half-plane). */
function clipHalfPlane(poly: Ring, [nx, ny]: Position, c: number): Ring {
  const out: Ring = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const da = nx * a[0] + ny * a[1] - c;
    const db = nx * b[0] + ny * b[1] - c;
    if (da <= 0) out.push(a);
    if (da * db < 0) {
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

/**
 * The square ±halfSizeM around the point, cut halfway to each neighbour (lon/lat in and out).
 * Neighbours within `sameSiteM` are units of the same building and are skipped.
 */
export function estimateLot(lonLat: Position, neighbours: Position[], halfSizeM: number = LOT_ESTIMATE.halfSizeM): PolygonGeometry {
  const frame = localFrame(lonLat);
  const h = halfSizeM;
  let ring: Ring = [[-h, -h], [h, -h], [h, h], [-h, h]];
  for (const n of neighbours) {
    const [x, y] = frame.toLocal(n);
    const d2 = x * x + y * y;
    if (d2 < LOT_ESTIMATE.sameSiteM ** 2) continue;
    ring = clipHalfPlane(ring, [x, y], d2 / 2); // the perpendicular bisector between the two points
  }
  const lonLatRing = ring.map(frame.toLonLat);
  return { type: 'Polygon', coordinates: [[...lonLatRing, lonLatRing[0]!]] };
}

export function nearUrl([lon, lat]: Position): string {
  const q = new URLSearchParams({
    point: `${lon.toFixed(6)},${lat.toFixed(6)}`,
    maxDistance: String(LOT_ESTIMATE.neighbourRadiusM),
    maxResults: String(LOT_ESTIMATE.maxNeighbours),
    outputSRS: '4326',
    locationDescriptor: 'parcelPoint',
  });
  return `${GEOCODER_NEAR_URL}?${q}`;
}

interface NearCollection {
  features?: { geometry?: { coordinates?: unknown } }[];
}

/** The address points around a position, from the BC Address Geocoder. */
export async function neighbourPoints(lonLat: Position, signal?: AbortSignal): Promise<Position[]> {
  const fc = await getJson<NearCollection>(nearUrl(lonLat), { signal });
  const out: Position[] = [];
  for (const f of fc.features ?? []) {
    const c = f.geometry?.coordinates;
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') out.push([c[0], c[1]]);
  }
  return out;
}
