// proj4 ships only a handful of CRS definitions, so define the ones VanShade uses.
import proj4 from 'proj4';
import type { Position } from './polygon';

/** NAD83 / BC Albers: ParcelMap BC's native CRS, where DWITHIN distances are true metres. */
export const EPSG_3005 =
  '+proj=aea +lat_0=45 +lon_0=-126 +lat_1=50 +lat_2=58.5 +x_0=1000000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

/** NAD83(CSRS) / Canada Atlas Lambert: the HRDEM mosaic grid. Grid north is NOT true north here. */
export const EPSG_3979 =
  '+proj=lcc +lat_0=49 +lon_0=-95 +lat_1=49 +lat_2=77 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

/** NAD83(CSRS) / UTM zone 10N: the CRS of NRCan's point clouds and LidarBC's rasters. */
export const EPSG_3157 = '+proj=utm +zone=10 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
/**
 * NAD83 / UTM 10N, used by municipal imagery services. proj4 has no NAD83 → CSRS grid shift, so this
 * is the same maths as 3157 (the datums differ by well under a metre in Metro Vancouver).
 */
export const EPSG_26910 = '+proj=utm +zone=10 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

proj4.defs('EPSG:3005', EPSG_3005);
proj4.defs('EPSG:3979', EPSG_3979);
proj4.defs('EPSG:3157', EPSG_3157);
proj4.defs('EPSG:26910', EPSG_26910);

/** CRSs an analysis grid can live in: the HRDEM mosaic, or UTM 10N for the high-resolution sources. */
export type GridCrs = 'EPSG:3979' | 'EPSG:3157';

const pair = (p: number[]): Position => [p[0]!, p[1]!];

export function toCrs(crs: string, lonLat: Position): Position {
  return pair(proj4('EPSG:4326', crs, lonLat));
}

export function fromCrs(crs: string, xy: Position): Position {
  return pair(proj4(crs, 'EPSG:4326', xy));
}

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
 * Grid convergence γ in degrees: the angle from grid north to true north, clockwise.
 * Computed numerically, never hard-coded: about +25° for EPSG:3979 in Metro Vancouver,
 * about −0.1° for UTM 10N.
 * A direction with true azimuth A has grid azimuth A + γ.
 */
export function convergenceDeg(lonLat: Position, crs: GridCrs = 'EPSG:3979'): number {
  const a = toCrs(crs, lonLat);
  const b = toCrs(crs, [lonLat[0], lonLat[1] + 1e-4]);
  return (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
}
