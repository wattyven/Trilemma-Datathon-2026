// Endpoints and constants verified in Phase 0 (docs/DATA_SOURCES.md).

export const GEOCODER_URL = 'https://geocoder.api.gov.bc.ca/addresses.json';
/** Reverse lookup for "Use my location": the nearest address point to a position. */
export const GEOCODER_NEAREST_URL = 'https://geocoder.api.gov.bc.ca/sites/nearest.json';
export const LOCATE = { maxDistanceM: 100, timeoutMs: 10_000 } as const;

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

/**
 * Sharper surfaces loaded after the first (HRDEM) result: NRCan point clouds gridded at 0.5 m near
 * the lot, or LidarBC's newer 1 m rasters. See docs/DATA_SOURCES.md.
 */
export const HIRES = {
  /**
   * Point-cloud surface covers the lot bbox + this margin (shrunk, down to the minimum, to keep the
   * area read under copcMaxBoxM2); HRDEM (resampled) fills the rest of the window.
   */
  copcRefineM: 60,
  copcMinRefineM: 20,
  copcMaxBoxM2: 40_000,
  copcResM: 0.5,
  /** Read octree levels until about this many points per m² (2 per 0.5 m cell). */
  copcTargetDensity: 8,
  /** Safety cap: stop reading nodes after this many points. */
  copcMaxPoints: 3_000_000,
  /** Lots bigger than this (m²) keep the HRDEM result (a big area to read, and coarse cells anyway). */
  copcMaxLotM2: 40_000,
  /** A surface needs at least this share of its cells filled from points to replace HRDEM. */
  minFilled: 0.6,
  /** A datum offset bigger than this (m) means something is wrong with the file: don't use it. */
  maxDatumOffsetM: 30,
  /** geotiff block size for LidarBC's strip TIFFs (see elevation/cog.ts). */
  lidarbcBlockSize: 262_144,
  /** A cell this much above three-quarters of its neighbours is a spike (wire, pole, bird). */
  spikeRiseM: 2.5,
  /** "Best of both": a height difference between surveys above this counts as a change… */
  changeThresholdM: 2.5,
  /** …in areas of at least this size (m²), grown by this margin (m) so seams fall on unchanged ground. */
  changeMinAreaM2: 20,
  changeGrowM: 2,
} as const;

/**
 * 3D terrain near the lot: neighbouring cells more than `wallM` apart get a vertical wall; above
 * `innerMaxCells` cells the detailed mesh steps up to 1 m (walls can add as many vertices again).
 */
export const MESH = { wallM: 2, innerMaxCells: 150_000 } as const;

/** Aerial photos cover the lot bbox + this margin: the high-detail terrain around the lot (40 m, snapped to 4 m) and its skirt. */
export const IMAGERY = { marginM: 48, defaultOpacity: 0.7 } as const;

/** LidarBC rasters have no CORS headers, so they're read through our proxy (proxy/lidarbc). Unset: skipped. */
export const LIDARBC_PROXY = (import.meta.env.VITE_LIDARBC_PROXY ?? '').replace(/\/+$/, '');

/** Ray-march steps of max(minStepM, stepFrac · d): 0.25 m near the cell keeps roof edges and fences within a cell (tests/shadow). */
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
