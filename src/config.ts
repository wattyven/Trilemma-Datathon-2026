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

export const REQUEST_TIMEOUT_MS = 15_000;

// ── Elevation and shading (Phase 2) ───────────────────────────────────────────

export const STAC_URL = 'https://datacube.services.geo.ca/stac/api';
export const MOSAIC_COLLECTION = 'hrdem-mosaic-1m';
export const LIDAR_COLLECTION = 'hrdem-lidar';
export const lidarExtentUrl = (projectId: string) =>
  `https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/${projectId}-extent.geojson`;

export const ELEVATION = {
  /** Window = lot bbox + this buffer. Winter noon sun is ~17° high, so a 10 m tree throws ~32 m. */
  bufferM: 200,
  /** Analysis cells above this are coarsened. */
  cellCap: 20_000,
  /** DSM − DTM above this means a roof or canopy is overhead. */
  coveredM: 2,
  /** More lot cells than this without data → "No LiDAR coverage for this lot". */
  lotNodataMax: 0.5,
  /** Warn when more of the buffer than this has no data (water, gaps). */
  bufferNodataWarn: 0.005,
  /** The DTM (ground) is only needed on and near the lot: read lot bbox + this, not the whole window. */
  dtmMarginM: 44,
} as const;

/** A step of max(0.5 m, 0.02·d) is usual; 0.25 m near the cell keeps roof edges and fences within a cell (tests/shadow). */
export const HORIZON = {
  sectors: 180,
  minStepM: 0.25,
  stepFrac: 0.02,
  chunkCells: 200,
  /** Above this many cells, split the precompute across helper threads (up to maxThreads). */
  parallelAboveCells: 3000,
  maxThreads: 4,
} as const;

export type ObserverId = 'bed' | 'seated' | 'surface';
export const OBSERVERS: Record<ObserverId, { mode: 'ground' | 'surface'; heightM: number }> = {
  bed: { mode: 'ground', heightM: 0.3 },
  seated: { mode: 'ground', heightM: 1.2 },
  surface: { mode: 'surface', heightM: 0.1 },
};

export const SUN = {
  zone: 'America/Vancouver',
  dayStepMin: 10,
  seasonStepMin: 15,
  seasonEveryDays: 7,
  shadeStepMin: 15,
} as const;

export interface Thresholds {
  fullSunH: number;
  partSunH: number;
}
/** Defaults: full sun ≥ 6 h a day, part sun ≥ 3 h, otherwise shade. Adjustable in the UI. */
export const CLASS_THRESHOLDS: Readonly<Thresholds> = { fullSunH: 6, partSunH: 3 };
