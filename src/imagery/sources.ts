// Open municipal aerial photos (orthophotos), one service per municipality. All keyless, all send
// CORS headers for our origin (checked by spike/18-imagery-check.ts). Every request is in Web
// Mercator (EPSG:3857); the ArcGIS servers reproject on the fly. See docs/DATA_SOURCES.md.
//
// No open, CORS-enabled service exists for Richmond, the City of North Vancouver, New Westminster,
// West Vancouver, Port Moody, Pitt Meadows, Bowen Island or the villages; those lots get a note.

export type Bbox3857 = { minX: number; minY: number; maxX: number; maxY: number };

export type ImageryService =
  /** ArcGIS cached tiles, /tile/{z}/{y}/{x} in Web Mercator, 256 px. */
  | { kind: 'tiles'; url: string; zoom: number }
  /** ArcGIS MapServer /export or ImageServer /exportImage. */
  | { kind: 'export' | 'exportImage'; url: string; params?: Record<string, string> };

export interface ImagerySource {
  id: string;
  /** Matches the display jurisdiction from data/scope.ts. */
  jurisdiction: RegExp;
  owner: string;
  year: number;
  resolutionM: number;
  service: ImageryService;
  licence: string;
  /** Shown under the view whenever the photo is on. */
  credit: string;
}

export const IMAGERY_SOURCES: readonly ImagerySource[] = [
  {
    id: 'vancouver',
    // The City's service also covers UBC and the UEL (Electoral Area A); elsewhere in EA A it's blank.
    jurisdiction: /^(City of Vancouver|Electoral Area A)$/,
    owner: 'City of Vancouver',
    year: 2025,
    resolutionM: 0.075,
    service: { kind: 'tiles', url: 'https://tiles.arcgis.com/tiles/qrcTTRTwUoS8N47o/arcgis/rest/services/Orthophotos_2025/MapServer', zoom: 19 },
    licence: 'Open Government Licence – Metro Vancouver',
    credit: 'Aerial photo 2025: City of Vancouver, from Metro Vancouver imagery. Contains information licensed under the Open Government Licence – Metro Vancouver.',
  },
  {
    id: 'burnaby',
    jurisdiction: /^City of Burnaby$/,
    owner: 'City of Burnaby',
    year: 2025,
    resolutionM: 0.075,
    service: { kind: 'export', url: 'https://gis.burnaby.ca/arcgis/rest/services/Basemaps/Burnaby_Ortho_2025/MapServer' },
    licence: 'Open Government Licence – Burnaby',
    credit: 'Aerial photo 2025: City of Burnaby, Open Government Licence – Burnaby.',
  },
  {
    id: 'surrey',
    jurisdiction: /^City of Surrey$/,
    owner: 'City of Surrey',
    year: 2025,
    resolutionM: 0.075,
    service: { kind: 'export', url: 'https://gisservices.surrey.ca/arcgis/rest/services/AerialImages_Web_Mercator/MapServer', params: { layers: 'show:0' } },
    licence: 'Open Government Licence – Surrey',
    credit: 'Aerial photo 2025: City of Surrey, Open Government Licence – Surrey.',
  },
  {
    id: 'coquitlam',
    jurisdiction: /^City of Coquitlam$/,
    owner: 'City of Coquitlam',
    year: 2025,
    resolutionM: 0.075,
    service: { kind: 'tiles', url: 'https://geodata.coquitlam.ca/arcgis/rest/services/CachedServices/Imagery_2025/MapServer', zoom: 19 },
    licence: 'Open Government Licence – Coquitlam',
    credit: 'Aerial photo 2025: City of Coquitlam, Open Government Licence – Coquitlam.',
  },
  {
    id: 'dnv',
    jurisdiction: /^District of North Vancouver$/, // not the City of North Vancouver
    owner: 'District of North Vancouver',
    year: 2024,
    resolutionM: 0.066,
    service: { kind: 'export', url: 'https://geoweb.dnv.org/arcgis/rest/services/Basemap_Ortho2024/MapServer' },
    licence: 'Open Government Licence – North Vancouver',
    credit: 'Aerial photo 2024: District of North Vancouver, Open Government Licence – North Vancouver.',
  },
  {
    id: 'delta',
    jurisdiction: /Delta/,
    owner: 'City of Delta',
    year: 2022,
    resolutionM: 0.1,
    service: { kind: 'exportImage', url: 'https://maps.delta.ca/orthophotos/rest/services/Orthophotography/2022/ImageServer' },
    licence: 'Open Government Licence – Delta',
    credit: 'Aerial photo 2022: City of Delta, Open Government Licence – Delta.',
  },
  {
    id: 'mapleridge',
    jurisdiction: /Maple Ridge/,
    owner: 'City of Maple Ridge',
    year: 2025,
    resolutionM: 0.075,
    service: { kind: 'exportImage', url: 'https://geoservices.mapleridge.ca/image/rest/services/Orthoimagery/2025_7_5cm/ImageServer' },
    licence: 'Open Government Licence – Maple Ridge',
    credit: 'Aerial photo 2025: City of Maple Ridge, Open Government Licence – Maple Ridge.',
  },
  {
    id: 'township-langley',
    jurisdiction: /^Township of Langley$/, // not the City of Langley
    owner: 'Township of Langley',
    year: 2025,
    resolutionM: 0.066,
    service: { kind: 'export', url: 'https://mapsvr.tol.ca/arcgisext02/rest/services/CachedServices/Ortho_2025/MapServer' },
    licence: 'Open Government Licence – Township of Langley',
    credit: 'Aerial photo 2025: Township of Langley, Open Government Licence – Township of Langley.',
  },
  {
    id: 'city-langley',
    jurisdiction: /^City of Langley$/,
    owner: 'City of Langley',
    year: 2025,
    resolutionM: 0.075,
    service: { kind: 'export', url: 'https://maps.langleycity.ca/server/rest/services/Maps/Imagery2025/MapServer' },
    licence: 'Open Government Licence – City of Langley',
    credit: 'Aerial photo 2025: City of Langley, Open Government Licence – City of Langley.',
  },
  {
    id: 'port-coquitlam',
    jurisdiction: /Port Coquitlam/,
    owner: 'City of Port Coquitlam',
    year: 2025,
    resolutionM: 0.075,
    service: { kind: 'export', url: 'https://maps.portcoquitlam.ca/server/rest/services/Basemap_Ortho2025_Legal/MapServer', params: { layers: 'show:20' } },
    licence: 'Open Government Licence – Port Coquitlam',
    credit: 'Aerial photo 2025: City of Port Coquitlam, Open Government Licence – Port Coquitlam.',
  },
  {
    id: 'white-rock',
    jurisdiction: /White Rock/,
    owner: 'City of White Rock',
    year: 2025,
    resolutionM: 0.075,
    service: { kind: 'exportImage', url: 'https://maps.whiterockcity.ca/server/rest/services/opendata/Ortho2025/ImageServer' },
    licence: 'Open Government Licence – White Rock',
    credit: 'Aerial photo 2025: City of White Rock, Open Government Licence – White Rock.',
  },
];

export function imageryFor(jurisdiction: string): ImagerySource | null {
  return IMAGERY_SOURCES.find((s) => s.jurisdiction.test(jurisdiction)) ?? null;
}

/** One export request for a Web Mercator box at `width` × `height` px (JPEG). */
export function exportUrl(service: Extract<ImageryService, { kind: 'export' | 'exportImage' }>, b: Bbox3857, width: number, height: number): string {
  const q = new URLSearchParams({
    bbox: [b.minX, b.minY, b.maxX, b.maxY].map((v) => v.toFixed(2)).join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${width},${height}`,
    format: 'jpg',
    f: 'image',
    ...service.params,
  });
  return `${service.url}/${service.kind}?${q}`;
}

export function tileUrl(service: Extract<ImageryService, { kind: 'tiles' }>, x: number, y: number): string {
  return `${service.url}/tile/${service.zoom}/${y}/${x}`;
}

/** Web Mercator half-circumference (m). */
export const MERC_HALF = 20037508.342789244;

/** Tile column/row range covering a box at zoom z (inclusive), and the tiles' own box. */
export function tileRange(b: Bbox3857, z: number) {
  const n = 2 ** z, size = (2 * MERC_HALF) / n;
  const x0 = Math.floor((b.minX + MERC_HALF) / size), x1 = Math.floor((b.maxX + MERC_HALF) / size);
  const y0 = Math.floor((MERC_HALF - b.maxY) / size), y1 = Math.floor((MERC_HALF - b.minY) / size);
  return { x0, x1, y0, y1, box: { minX: x0 * size - MERC_HALF, maxX: (x1 + 1) * size - MERC_HALF, maxY: MERC_HALF - y0 * size, minY: MERC_HALF - (y1 + 1) * size } };
}
