// Local metric frame centred on a lot: x = metres east, y = metres TRUE north.
// A tangent-plane approximation using the GRS80 radii of curvature at the origin (prime vertical
// N for east–west, meridional M for north–south), so it's conformal to first order: bearings are
// right to ~0.001° and distances to ~1e-5 across a lot plus its shading buffer. Later phases map
// the DSM grid into this same frame.
import { geometryCentroid, mapGeometry, type AreaGeometry, type Position } from './polygon';

const GRS80_A = 6_378_137;
const GRS80_E2 = 0.00669438002290;
const RAD = Math.PI / 180;

export interface LocalFrame {
  origin: Position; // lon, lat
  toLocal(lonLat: Position): Position;
  toLonLat(xy: Position): Position;
}

export function localFrame([lon0, lat0]: Position): LocalFrame {
  const sin = Math.sin(lat0 * RAD);
  const w = 1 - GRS80_E2 * sin * sin;
  const n = GRS80_A / Math.sqrt(w); // prime vertical radius
  const m = (GRS80_A * (1 - GRS80_E2)) / (w * Math.sqrt(w)); // meridional radius
  const kx = n * Math.cos(lat0 * RAD) * RAD;
  const ky = m * RAD;
  return {
    origin: [lon0, lat0],
    toLocal: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLonLat: ([x, y]) => [lon0 + x / kx, lat0 + y / ky],
  };
}

/** A frame centred on the geometry's area-weighted centroid. */
export function frameForGeometry(g: AreaGeometry): LocalFrame {
  // Centroid in lon/lat is slightly skewed by the cos(lat) scale; refine once in a provisional frame.
  const provisional = localFrame(geometryCentroid(g));
  const c = geometryCentroid(mapGeometry(g, provisional.toLocal));
  return localFrame(provisional.toLonLat(c));
}
