// Elevation fetch, horizon precompute and every output, off the main thread.
import { ELEVATION, HORIZON, SUN } from '../config';
import { buildRasters, CancelledBuild } from '../elevation/build';
import { openImage } from '../elevation/cog';
import { ringsToPixel, TileEdgeError, type PixelWindow } from '../elevation/window';
import { convergenceDeg } from '../geo/proj';
import type { SourceInfo } from '../engine/protocol';
import { maxValue, NoLidarError, nodataFraction, selectCells, withObserver, type CellSet, type Observer, type Raster } from '../engine/grid';
import { computeHorizons, splitRanges, type HorizonParams } from '../engine/horizon';
import type { HorizonJob, HorizonReply } from './horizon.worker';
import { inspectCell, momentMask, prepareSamples, seasonAverage, shadeFinder, sunHours, type Horizons } from '../engine/outputs';
import type { ComputeRequest, ComputeResult, ErrorCode, FromWorker, LoadRequest, ToWorker } from '../engine/protocol';
import { dateRange, daySamples, momentSample, type LocalDate } from '../engine/sun';

// The project compiles against the DOM lib; describe just the worker-scope bits we use.
interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
}
const scope = self as unknown as WorkerScope;

interface State {
  key: string; // which rasters are loaded
  window: PixelWindow;
  dsm: Raster;
  dtm: Raster;
  cells: CellSet;
  observerKey: string;
  horizons: Horizons;
  lonLat: [number, number];
  gammaDeg: number;
  source: SourceInfo;
  res: number;
  changed?: Uint8Array;
}

let state: State | null = null;
/** The newest load wins; older loads stop at their next chunk boundary. */
let latestLoad = 0;

const params: HorizonParams = { sectors: HORIZON.sectors, minStepM: HORIZON.minStepM, stepFrac: HORIZON.stepFrac };

function post(msg: FromWorker, transfer: Transferable[] = []) {
  scope.postMessage(msg, transfer);
}

class Cancelled extends Error {}
const yieldToEvents = () => new Promise<void>((r) => setTimeout(r, 0));

async function load(id: number, req: LoadRequest) {
  latestLoad = id;
  cancelPool(); // a newer lot stops the helpers working on the old one
  const t0 = performance.now();
  const key = JSON.stringify([req.elevation, req.lotLonLat, req.bufferM, req.cellCap]);
  let rasters: Pick<State, 'window' | 'dsm' | 'dtm' | 'cells' | 'source' | 'changed'>;

  if (state && state.key === key) {
    rasters = { window: state.window, dsm: state.dsm, dtm: state.dtm, cells: withObserver(state.cells, req.observer), source: state.source, changed: state.changed };
  } else {
    post({ type: 'progress', id, stage: 'elevation', done: 0, total: 2 });
    const built = await buildRasters(req.elevation, req.lotLonLat, req.bufferM, () => id === latestLoad);
    if (id !== latestLoad) throw new Cancelled();
    const cells = selectCells(built.dsm, built.dtm, ringsToPixel(built.window, built.lot), {
      cap: req.cellCap,
      observer: req.observer,
      coveredM: ELEVATION.coveredM,
      lotNodataMax: ELEVATION.lotNodataMax,
    });
    rasters = { window: built.window, dsm: built.dsm, dtm: built.dtm, cells, source: built.source, changed: built.changed };
    post({ type: 'progress', id, stage: 'elevation', done: 2, total: 2 });
  }
  const t1 = performance.now();

  const { cells, dsm } = rasters;
  const res = rasters.window.res;
  const gammaDeg = convergenceDeg(req.lonLat, rasters.window.crs);
  const zmax = maxValue(dsm);
  const threads = threadCount(cells.count);
  const data = threads > 1 ? await parallelHorizons(id, dsm, cells, zmax, threads, res) : await serialHorizons(id, dsm, cells, zmax, res);
  const t2 = performance.now();

  state = {
    key,
    ...rasters,
    observerKey: JSON.stringify(req.observer satisfies Observer),
    horizons: { data, count: cells.count, sectors: params.sectors },
    lonLat: req.lonLat,
    gammaDeg,
    res,
  };

  const copy = <T extends Float32Array | Uint8Array>(a: T) => a.slice() as T;
  const msg: FromWorker = {
    type: 'loaded',
    id,
    summary: {
      window: rasters.window,
      source: rasters.source,
      cells: cells.count,
      candidates: cells.candidates,
      dropped: cells.dropped,
      step: cells.step,
      cellSizeM: cells.step * res,
      gammaDeg,
      bufferNodataFrac: nodataFraction(dsm),
      timings: { elevationMs: Math.round(t1 - t0), horizonMs: Math.round(t2 - t1), threads },
    },
    px: copy(cells.px),
    py: copy(cells.py),
    z0: copy(cells.z0),
    covered: copy(cells.covered),
    dsm: copy(dsm.data),
    dtm: copy(rasters.dtm.data),
    ...(rasters.changed ? { changed: copy(rasters.changed) } : {}),
  };
  post(msg, [msg.px.buffer, msg.py.buffer, msg.z0.buffer, msg.covered.buffer, msg.dsm.buffer, msg.dtm.buffer, ...(msg.changed ? [msg.changed.buffer] : [])]);
}

async function serialHorizons(id: number, dsm: Raster, cells: CellSet, zmax: number, res: number): Promise<Float32Array> {
  const data = new Float32Array(cells.count * params.sectors);
  const input = { dsm, px: cells.px, py: cells.py, z0: cells.z0, count: cells.count, res };
  for (let start = 0; start < cells.count; start += HORIZON.chunkCells) {
    const end = Math.min(cells.count, start + HORIZON.chunkCells);
    computeHorizons(input, params, data, start, end, zmax);
    post({ type: 'progress', id, stage: 'horizon', done: end, total: cells.count });
    await yieldToEvents();
    if (id !== latestLoad) throw new Cancelled();
  }
  return data;
}

/** Helper threads for big lots; null where nested workers aren't supported. */
function threadCount(cells: number): number {
  if (cells <= HORIZON.parallelAboveCells || typeof Worker === 'undefined') return 1;
  const cores = (self as unknown as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 2;
  return Math.max(1, Math.min(HORIZON.maxThreads, cores - 1));
}

let activePool: { workers: Worker[]; cancel: () => void } | null = null;

function cancelPool() {
  activePool?.cancel();
  activePool = null;
}

async function parallelHorizons(id: number, dsm: Raster, cells: CellSet, zmax: number, threads: number, res: number): Promise<Float32Array> {
  const ranges = splitRanges(cells.count, threads);
  const done = new Array<number>(ranges.length).fill(0);
  const out = new Float32Array(cells.count * params.sectors);
  let workers: Worker[];
  try {
    workers = ranges.map(() => new Worker(new URL('./horizon.worker.ts', import.meta.url), { type: 'module' }));
  } catch {
    return serialHorizons(id, dsm, cells, zmax, res); // no nested workers here
  }
  return new Promise<Float32Array>((resolve, reject) => {
    let remaining = ranges.length;
    const stop = () => workers.forEach((w) => w.terminate());
    activePool = { workers, cancel: () => (stop(), reject(new Cancelled())) };
    ranges.forEach(([a, b], k) => {
      const w = workers[k]!;
      w.onmessage = (ev: MessageEvent<HorizonReply>) => {
        const msg = ev.data;
        if (msg.type === 'progress') {
          done[k] = msg.done;
          post({ type: 'progress', id, stage: 'horizon', done: done.reduce((x, y) => x + y, 0), total: cells.count });
          return;
        }
        out.set(msg.horizons, a * params.sectors);
        w.terminate();
        if (--remaining === 0) {
          activePool = null;
          resolve(out);
        }
      };
      w.onerror = (e) => {
        stop();
        activePool = null;
        reject(new Error(e.message || 'Horizon helper failed'));
      };
      const job: HorizonJob = {
        dsm: dsm.data.slice(),
        width: dsm.width,
        height: dsm.height,
        px: cells.px.slice(a, b),
        py: cells.py.slice(a, b),
        z0: cells.z0.slice(a, b),
        params,
        zmax,
        res,
        chunk: HORIZON.chunkCells,
      };
      w.postMessage(job, [job.dsm.buffer, job.px.buffer, job.py.buffer, job.z0.buffer]);
    });
  });
}

function compute(req: ComputeRequest): ComputeResult {
  if (!state) throw Object.assign(new Error('Nothing loaded'), { code: 'not-loaded' as ErrorCode });
  const { horizons: h, gammaDeg, lonLat } = state;
  const [lon, lat] = lonLat;
  const K = h.sectors;
  const prep = (d: LocalDate, stepMin: number) => prepareSamples(daySamples(d, lat, lon, stepMin), gammaDeg, K);
  const daylight = (s: { weightH: number }[]) => s.reduce((a, x) => a + x.weightH, 0);

  switch (req.kind) {
    case 'moment': {
      const s = momentSample(req.date, req.minuteOfDay, lat, lon);
      const [p] = prepareSamples([s], gammaDeg, K);
      return { kind: 'moment', values: momentMask(h, p!), altDeg: s.altDeg, azTrueDeg: s.azTrueDeg, time: s.time };
    }
    case 'day': {
      const samples = prep(req.date, SUN.dayStepMin);
      return { kind: 'day', values: sunHours(h, samples), daylightH: daylight(samples) };
    }
    case 'season': {
      const days = dateRange(req.start, req.end, SUN.seasonEveryDays).map((d) => prep(d, SUN.seasonStepMin));
      const meanDaylightH = days.length ? days.reduce((a, s) => a + daylight(s), 0) / days.length : 0;
      return { kind: 'season', values: seasonAverage(h, days), days: days.length, meanDaylightH };
    }
    case 'shade': {
      const days = dateRange(req.start, req.end, SUN.seasonEveryDays);
      const samples = days.flatMap((d) => prepareSamples(daySamples(d, lat, lon, SUN.shadeStepMin, req.window), gammaDeg, K));
      const windowHours = (days.length * Math.max(0, req.window.toMin - req.window.fromMin)) / 60;
      const r = shadeFinder(h, samples, windowHours);
      return { kind: 'shade', values: r.shadedPct, sunUpHours: r.sunUpHours, windowHours, days: days.length };
    }
    case 'inspect': {
      const months = Array.from({ length: 12 }, (_, m) =>
        [1, 8, 15, 22].map((day) => prep({ year: req.year, month: m + 1, day }, SUN.seasonStepMin)),
      );
      return { kind: 'inspect', cell: req.cell, inspection: inspectCell(h, req.cell, months, prep(req.date, SUN.dayStepMin)) };
    }
  }
}

function errorCode(e: unknown): ErrorCode {
  if (e instanceof Cancelled || e instanceof CancelledBuild) return 'cancelled';
  if (e instanceof TileEdgeError) return 'tile-edge';
  if (e instanceof NoLidarError) return e.reason === 'no-cells' ? 'no-cells' : 'no-lidar';
  const code = (e as { code?: ErrorCode }).code;
  if (code) return code;
  if (e instanceof TypeError || /fetch|network|Request failed|Error fetching/i.test(String(e))) return 'fetch';
  return 'internal';
}

scope.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'prefetch') {
      // Warm the COG headers while the lot is still being looked up; failures surface later in load.
      await Promise.allSettled(msg.urls.map((u) => openImage(u)));
    } else if (msg.type === 'load') {
      await load(msg.id, msg.request);
    } else {
      const t0 = performance.now();
      const result = compute(msg.request);
      const transfer = 'values' in result ? [result.values.buffer] : [];
      post({ type: 'result', id: msg.id, result, ms: Math.round(performance.now() - t0) }, transfer);
    }
  } catch (e) {
    if (errorCode(e) === 'internal') console.warn('VanShade worker:', e);
    post({ type: 'error', id: msg.id, code: errorCode(e), message: e instanceof Error ? e.message : String(e) });
  }
};
