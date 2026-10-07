// Elevation fetch, horizon precompute and every output, off the main thread.
import { ELEVATION, HORIZON, SUN } from '../config';
import { openImage, readWindow, tileGrid } from '../elevation/cog';
import { bboxOf, lotWindow, ringsToPixel, TileEdgeError, type PixelWindow } from '../elevation/window';
import { maxValue, NoLidarError, nodataFraction, selectCells, withObserver, type CellSet, type Observer, type Raster } from '../engine/grid';
import { computeHorizons, type HorizonParams } from '../engine/horizon';
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
  const t0 = performance.now();
  const key = `${req.dsmUrl}|${req.dtmUrl}|${JSON.stringify(req.lot3979)}|${req.bufferM}|${req.cellCap}`;
  let rasters: Pick<State, 'window' | 'dsm' | 'dtm' | 'cells'>;

  if (state && state.key === key) {
    rasters = { window: state.window, dsm: state.dsm, dtm: state.dtm, cells: withObserver(state.cells, req.observer) };
  } else {
    post({ type: 'progress', id, stage: 'elevation', done: 0, total: 2 });
    const [dsmImg, dtmImg] = await Promise.all([openImage(req.dsmUrl), openImage(req.dtmUrl)]);
    const tile = tileGrid(dsmImg);
    const dtmTile = tileGrid(dtmImg);
    if (JSON.stringify(tile) !== JSON.stringify(dtmTile)) throw new Error('DSM and DTM grids differ'); // gotcha #6
    const window = lotWindow(bboxOf(req.lot3979), req.bufferM, tile);
    const [dsmData, dtmData] = await Promise.all([readWindow(dsmImg, window), readWindow(dtmImg, window)]);
    if (id !== latestLoad) throw new Cancelled();
    const dsm: Raster = { width: window.width, height: window.height, data: dsmData };
    const dtm: Raster = { width: window.width, height: window.height, data: dtmData };
    const cells = selectCells(dsm, dtm, ringsToPixel(window, req.lot3979), {
      cap: req.cellCap,
      observer: req.observer,
      coveredM: ELEVATION.coveredM,
      lotNodataMax: ELEVATION.lotNodataMax,
    });
    rasters = { window, dsm, dtm, cells };
    post({ type: 'progress', id, stage: 'elevation', done: 2, total: 2 });
  }
  const t1 = performance.now();

  const { cells, dsm } = rasters;
  const data = new Float32Array(cells.count * params.sectors);
  const zmax = maxValue(dsm);
  const input = { dsm, px: cells.px, py: cells.py, z0: cells.z0, count: cells.count };
  for (let start = 0; start < cells.count; start += HORIZON.chunkCells) {
    const end = Math.min(cells.count, start + HORIZON.chunkCells);
    computeHorizons(input, params, data, start, end, zmax);
    post({ type: 'progress', id, stage: 'horizon', done: end, total: cells.count });
    await yieldToEvents();
    if (id !== latestLoad) throw new Cancelled();
  }
  const t2 = performance.now();

  state = {
    key,
    ...rasters,
    observerKey: JSON.stringify(req.observer satisfies Observer),
    horizons: { data, count: cells.count, sectors: params.sectors },
    lonLat: req.lonLat,
    gammaDeg: req.gammaDeg,
  };

  const copy = <T extends Float32Array | Uint8Array>(a: T) => a.slice() as T;
  const msg: FromWorker = {
    type: 'loaded',
    id,
    summary: {
      window: rasters.window,
      cells: cells.count,
      candidates: cells.candidates,
      dropped: cells.dropped,
      step: cells.step,
      gammaDeg: req.gammaDeg,
      bufferNodataFrac: nodataFraction(dsm),
      timings: { elevationMs: Math.round(t1 - t0), horizonMs: Math.round(t2 - t1) },
    },
    px: copy(cells.px),
    py: copy(cells.py),
    z0: copy(cells.z0),
    covered: copy(cells.covered),
    dsm: copy(dsm.data),
  };
  post(msg, [msg.px.buffer, msg.py.buffer, msg.z0.buffer, msg.covered.buffer, msg.dsm.buffer]);
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
  if (e instanceof Cancelled) return 'cancelled';
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
    if (msg.type === 'load') {
      await load(msg.id, msg.request);
    } else {
      const t0 = performance.now();
      const result = compute(msg.request);
      const transfer = 'values' in result ? [result.values.buffer] : [];
      post({ type: 'result', id: msg.id, result, ms: Math.round(performance.now() - t0) }, transfer);
    }
  } catch (e) {
    post({ type: 'error', id: msg.id, code: errorCode(e), message: e instanceof Error ? e.message : String(e) });
  }
};
