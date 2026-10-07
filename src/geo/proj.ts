// proj4 ships only a handful of CRS definitions, so define the ones VanShade uses.
import proj4 from 'proj4';
import type { Position } from './polygon';

/** NAD83 / BC Albers: ParcelMap BC's native CRS, where DWITHIN distances are true metres. */
export const EPSG_3005 =
  '+proj=aea +lat_0=45 +lon_0=-126 +lat_1=50 +lat_2=58.5 +x_0=1000000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

proj4.defs('EPSG:3005', EPSG_3005);

export function toBcAlbers(lonLat: Position): Position {
  const [x, y] = proj4('EPSG:4326', 'EPSG:3005', lonLat);
  return [x, y] as Position;
}
