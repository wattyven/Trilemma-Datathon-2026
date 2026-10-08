// BC Geographic System (BCGS) map tiles, used to name both NRCan point-cloud tiles and LidarBC
// rasters (e.g. bc_092g025_3_2_2_…). Metro Vancouver lies entirely in NTS block 092G
// (49–50°N, 122–124°W). That block holds 100 1:20 000 sheets of 0.1° × 0.2°, numbered from the
// south-west corner west → east and then northward (row 0 = 001–010). Each sheet splits into
// quarters three times (1:10 000 → 1:5 000 → 1:2 500), numbered 1 = SW, 2 = SE, 3 = NW, 4 = NE.
// Verified against tile headers: Vancouver City Hall → 092g025_3_2_2, a Surrey point → 092g016_4_4_3.
import type { Position } from '../geo/polygon';

const BLOCK = { south: 49, west: -124, north: 50, east: -122 };
const SHEET_LAT = 0.1, SHEET_LON = 0.2;

export interface TileBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** The 1:2 500 tile containing a point, e.g. "092g025_3_2_2"; null outside block 092G. */
export function bcgsTileId([lon, lat]: Position): string | null {
  if (lat < BLOCK.south || lat >= BLOCK.north || lon < BLOCK.west || lon >= BLOCK.east) return null;
  const row = Math.floor((lat - BLOCK.south) / SHEET_LAT);
  const col = Math.floor((lon - BLOCK.west) / SHEET_LON);
  let south = BLOCK.south + row * SHEET_LAT, west = BLOCK.west + col * SHEET_LON;
  let h = SHEET_LAT, w = SHEET_LON;
  const quads: number[] = [];
  for (let level = 0; level < 3; level++) {
    h /= 2;
    w /= 2;
    const north = lat >= south + h, east = lon >= west + w;
    quads.push(north ? (east ? 4 : 3) : east ? 2 : 1);
    if (north) south += h;
    if (east) west += w;
  }
  return `092g${String(row * 10 + col + 1).padStart(3, '0')}_${quads.join('_')}`;
}

/** Lon/lat bounds of a tile id from bcgsTileId. */
export function bcgsTileBounds(id: string): TileBounds {
  const m = /^092g(\d{3})_([1-4])_([1-4])_([1-4])$/.exec(id);
  if (!m) throw new Error(`Not a 092G 1:2 500 tile id: ${id}`);
  const n = Number(m[1]) - 1;
  let south = BLOCK.south + Math.floor(n / 10) * SHEET_LAT, west = BLOCK.west + (n % 10) * SHEET_LON;
  let h = SHEET_LAT, w = SHEET_LON;
  for (const q of [m[2], m[3], m[4]].map(Number)) {
    h /= 2;
    w /= 2;
    if (q === 3 || q === 4) south += h;
    if (q === 2 || q === 4) west += w;
  }
  return { south, west, north: south + h, east: west + w };
}

/** Every 1:2 500 tile touching a lon/lat box (tiles are ~1.4 km × 1.8 km, so usually 1–4). */
export function bcgsTilesInBox(box: TileBounds): string[] {
  const out = new Set<string>();
  const dLat = SHEET_LAT / 8 / 2, dLon = SHEET_LON / 8 / 2; // half a tile: sample densely enough to hit each one
  for (let lat = box.south; lat <= box.north + dLat; lat += dLat) {
    for (let lon = box.west; lon <= box.east + dLon; lon += dLon) {
      const id = bcgsTileId([Math.min(lon, box.east), Math.min(lat, box.north)]);
      if (id) out.add(id);
    }
  }
  return [...out].sort();
}
