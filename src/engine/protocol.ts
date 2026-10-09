// Messages between the main thread (engine/client.ts) and workers/shade.worker.ts.
import type { Ring } from '../geo/polygon';
import type { PixelWindow } from '../elevation/window';
import type { CellInspection } from './outputs';
import type { Observer } from './grid';
import type { DayWindow, LocalDate } from './sun';

export interface HrdemSpec {
  dsmUrl: string;
  dtmUrl: string;
}

/** NRCan point-cloud (COPC) files covering the lot + margin, all from one survey. */
export interface CopcSpec {
  urls: string[];
}

/** LidarBC 1 m rasters (through the proxy) for the tiles the window touches, one survey year. */
export interface LidarbcSpec {
  dsm: string[];
  /** Bare-earth DEMs for the tiles near the lot. */
  dem: string[];
}

/**
 * Where elevation comes from for this load (chosen on the main thread; see elevation/hires.ts).
 * The high-resolution kinds still read HRDEM for the ground model and the outer window.
 */
export type ElevationSpec =
  | { kind: 'hrdem'; hrdem: HrdemSpec; label: string; year: string | null }
  | { kind: 'copc'; hrdem: HrdemSpec; copc: CopcSpec; label: string; year: string | null }
  | { kind: 'lidarbc'; hrdem: HrdemSpec; lidarbc: LidarbcSpec; label: string; year: string | null }
  /** "Best of both": the point cloud's detail where nothing changed, LidarBC where something did. `year` is LidarBC's. */
  | { kind: 'merged'; hrdem: HrdemSpec; copc: CopcSpec; lidarbc: LidarbcSpec; label: string; year: string | null; oldYear: string };

export interface SourceInfo {
  kind: ElevationSpec['kind'];
  label: string;
  year: string | null;
  /** Metres per pixel of the analysis grid. */
  resM: number;
  detail?: string;
  /** "Best of both": share of the area near the lot that uses the newer survey, and the older survey's year. */
  changedShare?: number;
  oldYear?: string;
}

export interface LoadRequest {
  elevation: ElevationSpec;
  /** Lot polygons, lon/lat. The worker projects them into the grid's CRS. */
  lotLonLat: Ring[][];
  /** Lot centroid, lon/lat (for sun positions and grid convergence). */
  lonLat: [number, number];
  observer: Observer;
  bufferM: number;
  cellCap: number;
}

export type ComputeRequest =
  | { kind: 'moment'; date: LocalDate; minuteOfDay: number }
  | { kind: 'day'; date: LocalDate }
  /** `sunshine`: typical share of daylight with sunshine, January to December, for weather-adjusted hours too. */
  | { kind: 'season'; start: LocalDate; end: LocalDate; sunshine?: number[] }
  | { kind: 'shade'; start: LocalDate; end: LocalDate; window: DayWindow }
  | { kind: 'inspect'; cell: number; date: LocalDate; year: number; sunshine?: number[] };

export interface LoadedSummary {
  window: PixelWindow;
  source: SourceInfo;
  cells: number;
  candidates: number;
  dropped: number;
  /** Cell spacing in grid pixels, and in metres. */
  step: number;
  cellSizeM: number;
  /** Grid convergence of the window's CRS at the lot (grid azimuth = true azimuth + γ). */
  gammaDeg: number;
  bufferNodataFrac: number;
  timings: { elevationMs: number; horizonMs: number; threads: number };
}

export interface LoadedMessage {
  type: 'loaded';
  id: number;
  summary: LoadedSummary;
  px: Float32Array;
  py: Float32Array;
  z0: Float32Array;
  covered: Uint8Array;
  /** The DSM window, and the DTM around the lot (NaN elsewhere and at nodata). */
  dsm: Float32Array;
  dtm: Float32Array;
  /** "Best of both": 1 where the newer survey replaced the older one (window-sized). */
  changed?: Uint8Array;
}

export type ComputeResult =
  | { kind: 'moment'; values: Uint8Array; altDeg: number; azTrueDeg: number; time: number }
  | { kind: 'day'; values: Float32Array; daylightH: number }
  /** `typical`, `meanTypicalH`: the same with typical weather, when the request gave sunshine shares. */
  | { kind: 'season'; values: Float32Array; days: number; meanDaylightH: number; typical?: Float32Array; meanTypicalH?: number }
  | { kind: 'shade'; values: Float32Array; sunUpHours: number; windowHours: number; days: number }
  | { kind: 'inspect'; cell: number; inspection: CellInspection };

export type ErrorCode = 'no-lidar' | 'no-cells' | 'tile-edge' | 'fetch' | 'cancelled' | 'not-loaded' | 'internal';

export interface AreaMessage {
  type: 'area';
  id: number;
  step: number;
  px: Float32Array;
  py: Float32Array;
  covered: Uint8Array;
  values: Float32Array | Uint8Array;
  valueKind: 'moment' | 'day' | 'season' | 'shade';
}

export type ToWorker =
  | { type: 'prefetch'; id: number; urls: string[] }
  | { type: 'load'; id: number; request: LoadRequest }
  | { type: 'compute'; id: number; request: ComputeRequest }
  | { type: 'area'; id: number; step: number; request: ComputeRequest };

export type FromWorker =
  | { type: 'progress'; id: number; stage: 'elevation' | 'horizon'; done: number; total: number }
  | LoadedMessage
  | { type: 'result'; id: number; result: ComputeResult; ms: number }
  | AreaMessage
  | { type: 'error'; id: number; code: ErrorCode; message: string };
