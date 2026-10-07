// Endpoints and constants verified in Phase 0 (docs/DATA_SOURCES.md).

export const GEOCODER_URL = 'https://geocoder.api.gov.bc.ca/addresses.json';

export const WFS_URL = 'https://openmaps.gov.bc.ca/geo/pub/wfs';
/** Public OGL-BC layer. The similarly named `…_FA_SVW` is the access-only "Fully Attributed" dataset. */
export const PARCEL_LAYER = 'WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW';
export const PARCEL_PROPERTIES = [
  'PARCEL_FABRIC_POLY_ID',
  'PLAN_NUMBER',
  'PID_FORMATTED',
  'PARCEL_STATUS',
  'PARCEL_CLASS',
  'OWNER_TYPE',
  'MUNICIPALITY',
  'REGIONAL_DISTRICT',
  'FEATURE_AREA_SQM',
  'WHEN_UPDATED',
  'SHAPE',
] as const;

/** Rough regional box, lon/lat. A first filter only; the allow-list and parcel check decide. */
export const METRO_BBOX = { minLon: -123.5, minLat: 49.0, maxLon: -122.2, maxLat: 49.6 } as const;

export const METRO_REGIONAL_DISTRICT = 'Metro Vancouver Regional District';
export const METRO_ELECTORAL_AREA_A = 'MVRD Electoral Area A';

export const AUTOCOMPLETE = { debounceMs: 300, minChars: 4, maxShown: 5, maxRequested: 8 } as const;

/** Below this geocoder score we ask "Did you mean …?" instead of proceeding. */
export const MIN_CONFIDENT_SCORE = 70;

/** Buffered parcel search radius (EPSG:3005 metres) when the point hits no lot. 15 m worked in Phase 0. */
export const PARCEL_BUFFER_M = 15;
/** Lots larger than this get the "coarser results" notice; the cell cap itself arrives in Phase 2. */
export const LARGE_LOT_M2 = 20_000;

export const REQUEST_TIMEOUT_MS = 15_000;
