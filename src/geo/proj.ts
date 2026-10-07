// proj4 ships only a handful of CRS definitions, so define the ones VanShade uses.
import proj4 from 'proj4';
import type { Position } from './polygon';

/** NAD83 / BC Albers: ParcelMap BC's native CRS, where DWITHIN distances are true metres. */
export const EPSG_3005 =
  '+proj=aea +lat_0=45 +lon_0=-126 +lat_1=50 +lat_2=58.5 +x_0=1000000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

/** NAD83(CSRS) / Canada Atlas Lambert: the HRDEM mosaic grid. Grid north is NOT true north here. */
export const EPSG_3979 =
  '+proj=lcc +lat_0=49 +lon_0=-95 +lat_1=49 +lat_2=77 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

proj4.defs('EPSG:3005', EPSG_3005);
proj4.defs('EPSG:3979', EPSG_3979);

const pair = (p: number[]): Position => [p[0]!, p[1]!];

export function toBcAlbers(lonLat: Position): Position {
  return pair(proj4('EPSG:4326', 'EPSG:3005', lonLat));
}

export function toLcc(lonLat: Position): Position {
  return pair(proj4('EPSG:4326', 'EPSG:3979', lonLat));
}

export function fromLcc(xy: Position): Position {
  return pair(proj4('EPSG:3979', 'EPSG:4326', xy));
}

/**
 * Grid convergence γ in degrees: the angle from EPSG:3979 grid north to true north, clockwise.
 * Computed numerically, never hard-coded; about +25° in Metro Vancouver.
 * A direction with true azimuth A has grid azimuth A + γ.
 */
export function convergenceDeg(lonLat: Position): number {
  const a = toLcc(lonLat);
  const b = toLcc([lonLat[0], lonLat[1] + 1e-4]);
  return (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
}
