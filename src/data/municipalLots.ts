// Municipal lot maps: asked only when ParcelMap BC has no lot at an exact address point
// (docs/DATA_SOURCES.md §3), so a gap in the provincial map doesn't hand someone their neighbour's lot.
// Each source is an ArcGIS layer queried with the point; matched by jurisdiction like the aerial photos.
import { METRO_REGIONAL_DISTRICT } from '../config';
import type { AreaGeometry, Position } from '../geo/polygon';
import { getJson } from './http';

export interface LotSource {
  id: string;
  /** Matched against the display jurisdiction. Keep the District and the City of North Vancouver apart. */
  jurisdiction: RegExp;
  /** Who publishes it, as the notice and the credits name it. */
  owner: string;
  /** The ArcGIS layer (…/MapServer/0 or …/FeatureServer/0). It must answer `f=geojson` with CORS. */
  url: string;
  /** Optional attribute filter, e.g. to leave out roads. */
  where?: string;
  /** The field and values that mark a strata lot, so the strata notice shows as it does for ParcelMap's. */
  strata?: { field: string; values: (string | number)[] };
  licence: string;
  credit: string;
}

/**
 * Verified 2026-10-12 (docs/DATA_SOURCES.md §3.1): a point on a civic site returns its lot, with CORS for vanshade.ca and localhost.
 * `where` leaves out roads, water and air space. The Township's and Delta's strata units are separate small polygons
 * with (mostly) no lot around them, so they're left out too: those addresses get the estimate.
 */
export const LOT_SOURCES: LotSource[] = [
  {
    id: 'vancouver',
    jurisdiction: /^City of Vancouver$/, // not UBC, which this map leaves out
    owner: 'City of Vancouver',
    url: 'https://services3.arcgis.com/qrcTTRTwUoS8N47o/arcgis/rest/services/PropertyParcel/FeatureServer/0',
    where: "PropertyType = 'Surface'",
    licence: 'CC BY',
    credit: 'Lot lines where ParcelMap BC has none: City of Vancouver, CC BY.',
  },
  {
    id: 'burnaby',
    jurisdiction: /^City of Burnaby$/,
    owner: 'City of Burnaby',
    url: 'https://gis.burnaby.ca/arcgis/rest/services/OpenData/OpenData4/MapServer/7',
    where: "AIR_SPACE IS NULL OR AIR_SPACE <> 'Y'",
    strata: { field: 'STRATA', values: ['Y'] },
    licence: 'Open Government Licence – Burnaby',
    credit: 'Lot lines where ParcelMap BC has none: City of Burnaby. Contains information licensed under the Open Government Licence – Burnaby.',
  },
  {
    id: 'surrey',
    jurisdiction: /^City of Surrey$/,
    owner: 'City of Surrey',
    url: 'https://gisservices.surrey.ca/arcgis/rest/services/OpenData/MapServer/148',
    where: "LOT_TYPE2 NOT IN ('City Road', 'Provincial Road', 'Dedicated Road', 'FRPA Foreshore Tenure')",
    strata: { field: 'LOT_TYPE2', values: ['Standard Strata'] },
    licence: 'Open Government Licence – Surrey',
    credit: 'Lot lines where ParcelMap BC has none: City of Surrey. Contains information licensed under the Open Government Licence – Surrey.',
  },
  {
    id: 'coquitlam',
    jurisdiction: /^City of Coquitlam$/,
    owner: 'City of Coquitlam',
    url: 'https://geodata.coquitlam.ca/arcgis/rest/services/DynamicServices/Cadastral/MapServer/16',
    licence: 'Open Government Licence – Coquitlam',
    credit: 'Lot lines where ParcelMap BC has none: City of Coquitlam. Contains information licensed under the Open Government Licence – Coquitlam.',
  },
  {
    id: 'poco',
    jurisdiction: /^City of Port Coquitlam$/,
    owner: 'City of Port Coquitlam',
    url: 'https://services9.arcgis.com/nz97KciUs5nOw64q/arcgis/rest/services/Cadastral/FeatureServer/0',
    licence: 'Open Government Licence – City of Port Coquitlam',
    credit: 'Lot lines where ParcelMap BC has none: City of Port Coquitlam. Contains information licensed under the Open Government Licence – City of Port Coquitlam.',
  },
  {
    id: 'portmoody',
    jurisdiction: /^City of Port Moody$/,
    owner: 'City of Port Moody',
    url: 'https://services9.arcgis.com/XMHGoEc3tdJ8TphG/arcgis/rest/services/Parcels_WGS/FeatureServer/0',
    licence: 'Open Government Licence – Port Moody',
    credit: 'Lot lines where ParcelMap BC has none: City of Port Moody. Contains information licensed under the Open Government Licence – Port Moody.',
  },
  {
    id: 'newwest',
    jurisdiction: /^City of New Westminster$/,
    owner: 'City of New Westminster',
    url: 'https://services3.arcgis.com/A7O8YnTNtzRPIn7T/arcgis/rest/services/Parcel_Site/FeatureServer/0',
    licence: 'Open Government Licence – City of New Westminster',
    credit: 'Lot lines where ParcelMap BC has none: City of New Westminster. Contains information licensed under the Open Government Licence – City of New Westminster.',
  },
  {
    id: 'dnv',
    jurisdiction: /^District of North Vancouver$/, // not the City of North Vancouver
    owner: 'District of North Vancouver',
    url: 'https://geoweb.dnv.org/arcgis/rest/services/Data_ParcelLayer/MapServer/0',
    licence: 'Open Government Licence – North Vancouver',
    credit: 'Lot lines where ParcelMap BC has none: District of North Vancouver. Contains information licensed under the Open Government Licence – North Vancouver.',
  },
  {
    id: 'delta',
    jurisdiction: /^City of Delta$/, // not Tsawwassen First Nation, whose lands Delta's map also shows
    owner: 'City of Delta',
    url: 'https://maps.delta.ca/arcgis/rest/services/DeltaMap/Property/MapServer/8',
    where: "PRCL_TYPE NOT IN ('U', 'D', 'W', 'TFN', 'S')",
    licence: 'Open Government Licence – Delta',
    credit: 'Lot lines where ParcelMap BC has none: City of Delta. Contains information licensed under the Open Government Licence – Delta.',
  },
  {
    id: 'mapleridge',
    jurisdiction: /^City of Maple Ridge$/,
    owner: 'City of Maple Ridge',
    url: 'https://geoservices.mapleridge.ca/server/rest/services/DataCatalog/Property/MapServer/3',
    where: 'ParcelType NOT IN (5, 9)',
    strata: { field: 'ParcelType', values: [6] }, // common property
    licence: 'Open Government Licence – Maple Ridge',
    credit: 'Lot lines where ParcelMap BC has none: City of Maple Ridge. Contains information licensed under the Open Government Licence – Maple Ridge.',
  },
  {
    id: 'langleycity',
    jurisdiction: /^City of Langley$/, // not the Township of Langley
    owner: 'City of Langley',
    url: 'https://maps.langleycity.ca/server/rest/services/Maps/Open_Data/MapServer/181',
    licence: 'Open Government Licence – City of Langley',
    credit: 'Lot lines where ParcelMap BC has none: City of Langley. Contains information licensed under the Open Government Licence – City of Langley.',
  },
  {
    id: 'langleytownship',
    jurisdiction: /^Township of Langley$/, // not the City of Langley
    owner: 'Township of Langley',
    url: 'https://mapsvr.tol.ca/arcgisext02/rest/services/GeoSource/DynamicServices/MapServer/3',
    where: "LEGAL_TYPE <> 'STRATA'",
    licence: 'Open Government Licence – Township of Langley',
    credit: 'Lot lines where ParcelMap BC has none: Township of Langley. Contains information licensed under the Open Government Licence – Township of Langley.',
  },
  {
    id: 'whiterock',
    jurisdiction: /^City of White Rock$/,
    owner: 'City of White Rock',
    url: 'https://maps.whiterockcity.ca/server/rest/services/opendata/Parcel/MapServer/0',
    licence: 'Open Government Licence – White Rock',
    credit: 'Lot lines where ParcelMap BC has none: City of White Rock. Contains information licensed under the Open Government Licence – White Rock.',
  },
];

export function lotSourceFor(jurisdiction: string): LotSource | null {
  return LOT_SOURCES.find((s) => s.jurisdiction.test(jurisdiction)) ?? null;
}

/** Municipal lots get ids well clear of ParcelMap BC's, so a shared link's `lot=` can't pick the wrong one. */
export const MUNICIPAL_ID_BASE = 9_000_000_000_000;

export function municipalLotUrl(source: LotSource, [lon, lat]: Position): string {
  const q = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    where: source.where ?? '1=1',
    outFields: ['OBJECTID', ...(source.strata ? [source.strata.field] : [])].join(','),
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  });
  return `${source.url}/query?${q}`;
}

/** Shaped like a ParcelMap BC feature, so the same code ranks and folds it. */
export interface MunicipalLotFeature {
  geometry: AreaGeometry;
  properties: Record<string, unknown>;
}

interface RawCollection {
  features?: { id?: unknown; geometry?: { type?: string; coordinates?: unknown } | null; properties?: Record<string, unknown> | null }[];
  error?: { message?: string };
}

/** The source's lots at the point (usually one), as ParcelMap-shaped features. */
export async function findMunicipalLots(source: LotSource, lonLat: Position, signal?: AbortSignal): Promise<MunicipalLotFeature[]> {
  const fc = await getJson<RawCollection>(municipalLotUrl(source, lonLat), { signal });
  if (fc.error) throw new Error(`${source.owner} lot map: ${fc.error.message ?? 'error'}`); // ArcGIS reports errors with HTTP 200
  const out: MunicipalLotFeature[] = [];
  for (const f of fc.features ?? []) {
    const g = f.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon') || !Array.isArray(g.coordinates)) continue;
    const objectId = Number(f.properties?.OBJECTID ?? f.id);
    out.push({
      geometry: g as AreaGeometry,
      properties: {
        PARCEL_FABRIC_POLY_ID: MUNICIPAL_ID_BASE + (Number.isInteger(objectId) && objectId > 0 ? objectId : 0),
        PARCEL_CLASS: source.strata?.values.includes(f.properties?.[source.strata.field] as string | number) ? 'Building Strata' : 'Subdivision',
        MUNICIPALITY: source.owner,
        REGIONAL_DISTRICT: METRO_REGIONAL_DISTRICT, // every source is a Metro Vancouver municipality
      },
    });
  }
  return out;
}
