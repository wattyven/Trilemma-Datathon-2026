// Local metric frame centred on a lot: x = metres east, y = metres TRUE north.
// Equirectangular about the origin; error is ~0.1% at 1 km, which is plenty for a single lot
// plus its shading buffer. Later phases map the DSM grid into this same frame.
import { geometryCentroid, mapGeometry, type AreaGeometry, type Position } from './polygon';

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

export interface LocalFrame {
  origin: Position; // lon, lat
  toLocal(lonLat: Position): Position;
  toLonLat(xy: Position): Position;
}

export function localFrame([lon0, lat0]: Position): LocalFrame {
  const kx = EARTH_RADIUS_M * RAD * Math.cos(lat0 * RAD);
  const ky = EARTH_RADIUS_M * RAD;
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
