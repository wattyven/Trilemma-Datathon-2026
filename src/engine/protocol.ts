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

/** Where elevation comes from for this load (chosen on the main thread; see analysis.ts). */
export type ElevationSpec = { kind: 'hrdem'; hrdem: HrdemSpec; label: string; year: string | null };

export interface SourceInfo {
  kind: ElevationSpec['kind'];
  label: string;
  year: string | null;
  /** Metres per pixel of the analysis grid. */
  resM: number;
  detail?: string;
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
  | { kind: 'season'; start: LocalDate; end: LocalDate }
  | { kind: 'shade'; start: LocalDate; end: LocalDate; window: DayWindow }
  | { kind: 'inspect'; cell: number; date: LocalDate; year: number };

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
}

export type ComputeResult =
  | { kind: 'moment'; values: Uint8Array; altDeg: number; azTrueDeg: number; time: number }
  | { kind: 'day'; values: Float32Array; daylightH: number }
  | { kind: 'season'; values: Float32Array; days: number; meanDaylightH: number }
  | { kind: 'shade'; values: Float32Array; sunUpHours: number; windowHours: number; days: number }
  | { kind: 'inspect'; cell: number; inspection: CellInspection };

export type ErrorCode = 'no-lidar' | 'no-cells' | 'tile-edge' | 'fetch' | 'cancelled' | 'not-loaded' | 'internal';

export type ToWorker =
  | { type: 'prefetch'; id: number; urls: string[] }
  | { type: 'load'; id: number; request: LoadRequest }
  | { type: 'compute'; id: number; request: ComputeRequest };

export type FromWorker =
  | { type: 'progress'; id: number; stage: 'elevation' | 'horizon'; done: number; total: number }
  | LoadedMessage
  | { type: 'result'; id: number; result: ComputeResult; ms: number }
  | { type: 'error'; id: number; code: ErrorCode; message: string };
