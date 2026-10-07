// Messages between the main thread (engine/client.ts) and workers/shade.worker.ts.
import type { Ring } from '../geo/polygon';
import type { PixelWindow } from '../elevation/window';
import type { CellInspection } from './outputs';
import type { Observer } from './grid';
import type { DayWindow, LocalDate } from './sun';

export interface LoadRequest {
  dsmUrl: string;
  dtmUrl: string;
  /** Lot polygons in EPSG:3979 metres. */
  lot3979: Ring[][];
  /** Lot centroid, lon/lat (for sun positions). */
  lonLat: [number, number];
  /** Grid convergence at the centroid, degrees (grid azimuth = true azimuth + γ). */
  gammaDeg: number;
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
  cells: number;
  candidates: number;
  dropped: number;
  step: number;
  gammaDeg: number;
  bufferNodataFrac: number;
  timings: { elevationMs: number; horizonMs: number };
}

export interface LoadedMessage {
  type: 'loaded';
  id: number;
  summary: LoadedSummary;
  px: Float32Array;
  py: Float32Array;
  z0: Float32Array;
  covered: Uint8Array;
  /** The DSM window (NaN = nodata), for the debug background. */
  dsm: Float32Array;
}

export type ComputeResult =
  | { kind: 'moment'; values: Uint8Array; altDeg: number; azTrueDeg: number; time: number }
  | { kind: 'day'; values: Float32Array; daylightH: number }
  | { kind: 'season'; values: Float32Array; days: number; meanDaylightH: number }
  | { kind: 'shade'; values: Float32Array; sunUpHours: number; windowHours: number; days: number }
  | { kind: 'inspect'; cell: number; inspection: CellInspection };

export type ErrorCode = 'no-lidar' | 'no-cells' | 'tile-edge' | 'fetch' | 'cancelled' | 'not-loaded' | 'internal';

export type ToWorker =
  | { type: 'load'; id: number; request: LoadRequest }
  | { type: 'compute'; id: number; request: ComputeRequest };

export type FromWorker =
  | { type: 'progress'; id: number; stage: 'elevation' | 'horizon'; done: number; total: number }
  | LoadedMessage
  | { type: 'result'; id: number; result: ComputeResult; ms: number }
  | { type: 'error'; id: number; code: ErrorCode; message: string };
