// Elevation → horizons → sun results for the selected lot, and everything the view shows about
// them: the 3D scene (lazy-loaded) and 2D map, the shared timeline, legend, readout, inspector,
// notices and debug facts.
import { ELEVATION, OBSERVERS } from './config';
import { copy } from './copy';
import type { GeocodeMatch } from './data/geocoder';
import type { Parcel } from './data/parcels';
import { loadHiresIndex, refinementFor, type SourcePreference } from './elevation/hires';
import { findMosaicItem } from './elevation/stac';
import { vintageFor } from './elevation/vintage';
import { EngineError, ShadeEngine } from './engine/client';
import type { ComputeResult, ElevationSpec, LoadedMessage } from './engine/protocol';
import { daySamples, momentSample, type SunSample } from './engine/sun';
import { applyAffine, gridToLocalAffine } from './geo/gridAffine';
import { mapGeometry, polygonsOf, type Position } from './geo/polygon';
import type { LotScene } from './scene/view3d';
import { isLowPower, webglAvailable } from './scene/webgl';
import type { CellGrid } from './ui/cellPaint';
import { CLASS_RGB, SHADE_RGB, SUN_RGB, cividisGradient, css } from './ui/colors';
import { requestFor, type ChangeKind, type ControlState, type Controls } from './ui/controls';
import { renderInspector } from './ui/inspector';
import { HOURS_SCALE_MAX, type Layer, type LotCanvas } from './ui/lotCanvas';
import { setAnalysisNotices, setFact, type LotViewElements } from './ui/lotView';
import type { Steps } from './ui/status';
import { minuteLabel, type Timeline, type TimelineState } from './ui/timeline';

export interface AnalysisElements {
  legend: HTMLElement;
  readout: HTMLElement;
  summary: HTMLElement;
  inspector: HTMLElement;
  debug: HTMLDListElement;
  sceneHost: HTMLElement;
  mapCanvas: HTMLCanvasElement;
  hud: HTMLElement;
  compass: HTMLElement;
  sunNote: HTMLElement;
  viewNote: HTMLElement;
  viewRadios: HTMLInputElement[];
  shadowsToggle: HTMLInputElement;
  compareToggle: HTMLInputElement;
  resetView: HTMLButtonElement;
  caveatLidar: HTMLElement;
  aboutLidar: HTMLElement;
}

export class NoCoverageError extends Error {}

let engineInstance: ShadeEngine | null = null;
const engine = () => (engineInstance ??= new ShadeEngine());

export function errorMessage(e: unknown): string {
  if (e instanceof NoCoverageError) return copy.noLidarArea;
  if (e instanceof EngineError) {
    if (e.code === 'no-lidar') return copy.noLidar;
    if (e.code === 'no-cells') return copy.noCells;
    if (e.code === 'tile-edge') return copy.tileEdge;
    if (e.code === 'internal') return copy.workerDown;
  }
  return copy.elevationDown;
}

export type View = '3d' | 'map';

export class Analysis {
  private loaded: LoadedMessage | null = null;
  private result: ComputeResult | null = null;
  private lotRequest: Parameters<ShadeEngine['load']>[0] | null = null;
  private computeSeq = 0;
  private compareSeq = 0;
  private timings: Record<string, number> = {};
  private vintageText = '';
  private scene: LotScene | null = null;
  private sceneUnavailable = false;
  private view: View = '3d';
  private pathCache: { key: string; samples: SunSample[] } | null = null;
  private inspectedCell: number | null = null;
  private threads = 1;
  private pickSeq = 0;
  /** The current lot (for restarting a refinement an observer change interrupted). */
  private lot: { parcel: Parcel; signal: AbortSignal } | null = null;
  /** The sharper surface loading (or loaded) after the first result. */
  private refinement: { spec: ElevationSpec; state: 'running' | 'interrupted' | 'done' | 'failed'; note?: string } | null = null;
  private refineSeq = 0;
  /** Debug: force a surface (URL `elev=`). */
  sourcePreference: SourcePreference = 'auto';
  /** Called when the user switches between 3D and map (for the shareable URL). */
  onViewChange: (v: View) => void = () => {};

  constructor(
    private map: LotCanvas,
    private controls: Controls,
    private timeline: Timeline,
    private lotEls: LotViewElements,
    private els: AnalysisElements,
  ) {
    for (const r of els.viewRadios)
      r.addEventListener('change', () => {
        if (!r.checked) return;
        this.setView(r.value as View);
        this.onViewChange(this.view);
      });
    els.shadowsToggle.addEventListener('change', () => this.scene?.setShadows(els.shadowsToggle.checked));
    els.compareToggle.addEventListener('change', () => void this.updateCompare());
    els.resetView.addEventListener('click', () => this.scene?.resetView());
  }

  /** Run the whole pipeline for a lot already drawn on the map. */
  async start(parcel: Parcel, match: GeocodeMatch, steps: Steps, signal: AbortSignal) {
    this.refineSeq++; // abandon the previous lot's refinement
    this.refinement = null;
    this.lot = { parcel, signal };
    this.loaded = null;
    this.result = null;
    this.els.inspector.hidden = true;
    this.inspectedCell = null;
    this.els.summary.textContent = '';
    this.els.readout.textContent = '';
    this.els.legend.hidden = true;
    this.els.hud.hidden = true;
    this.showView('map'); // the outline, until the 3D terrain is ready
    setAnalysisNotices(this.lotEls, []);

    const centre = this.map.frame.origin;
    steps.set('elevation', 'active');
    const t0 = performance.now();
    // Same point as prefetch(), so this is usually a cache hit.
    const item = await findMosaicItem(match.lonLat, signal);
    if (!item) throw new NoCoverageError();
    this.timings = { stacMs: Math.round(performance.now() - t0) };

    void vintageFor(centre, signal).then((v) => {
      if (!v || signal.aborted) return;
      this.vintageText = copy.lidarValue(v.label, v.date);
      setFact(this.lotEls, 'lidar', copy.lidarFact, this.vintageText);
      this.els.caveatLidar.textContent = copy.caveatLidar(v.date.slice(0, 4));
      this.els.aboutLidar.textContent = copy.aboutLidar(v.label, v.date.slice(0, 4));
      this.renderDebug();
    });

    this.lotRequest = {
      elevation: { kind: 'hrdem', hrdem: { dsmUrl: item.dsm, dtmUrl: item.dtm }, label: 'NRCan HRDEM 1 m', year: null },
      lotLonLat: polygonsOf(parcel.geometry),
      lonLat: centre,
      observer: OBSERVERS[this.controls.get().observer],
      bufferM: ELEVATION.bufferM,
      cellCap: ELEVATION.cellCap,
    };
    const scenePromise = this.ensureScene(); // fetch three.js while elevation loads
    await this.load(steps, signal, true);
    await scenePromise;
    if (signal.aborted) return;
    this.buildScene(parcel);
    steps.set('sunlight', 'active');
    this.timeline.setLocation(centre); // positions the sun; emits a change
    await this.compute(signal);
    steps.set('sunlight', 'done');
    this.controls.show();
    this.showView(this.view);
    void this.refine();
  }

  /**
   * Progressive refinement: with the first (HRDEM 1 m) result on screen, load a sharper surface in
   * the background and swap it in. Any failure just keeps the first result.
   */
  private async refine() {
    const lot = this.lot, req = this.lotRequest;
    if (!lot || !req || lot.signal.aborted) return;
    const seq = ++this.refineSeq;
    let spec = this.refinement?.state === 'interrupted' ? this.refinement.spec : null;
    if (!spec && req.elevation.kind === 'hrdem') spec = await refinementFor(req.elevation.hrdem, req.lotLonLat, req.lonLat, this.sourcePreference).catch(() => null);
    if (!spec || seq !== this.refineSeq || lot.signal.aborted) return;
    this.refinement = { spec, state: 'running' };
    this.renderSurfaceFact();
    try {
      const refinedReq = { ...req, observer: OBSERVERS[this.controls.get().observer], elevation: spec };
      const loaded = await engine().load(refinedReq, undefined, lot.signal);
      if (seq !== this.refineSeq || lot.signal.aborted) return;
      this.lotRequest = refinedReq; // observer changes now reuse the sharper rasters
      this.refinement.state = 'done';
      await this.swapIn(loaded, lot.parcel, lot.signal);
    } catch (e) {
      if (seq !== this.refineSeq || !this.refinement) return;
      // Superseded by an observer reload (onControls restarts it), or a real failure.
      if ((e as { name?: string }).name === 'AbortError') this.refinement.state = 'interrupted';
      else this.refinement = { ...this.refinement, state: 'failed', note: e instanceof Error ? e.message : String(e) };
    } finally {
      if (seq === this.refineSeq) {
        this.renderSurfaceFact();
        this.renderDebug();
      }
    }
  }

  /** Replace the loaded grid with a sharper one for the same lot, keeping the view and inspector. */
  private async swapIn(loaded: LoadedMessage, parcel: Parcel, signal: AbortSignal) {
    const inspectedAt = this.inspectedCell !== null ? this.cellLocal(this.inspectedCell) : null;
    // Synchronously with adopting the new grid, retire results computed on the old one.
    this.computeSeq++;
    this.compareSeq++;
    this.pickSeq++;
    this.result = null;
    this.adopt(loaded, true);
    this.buildScene(parcel, true);
    this.updateSun();
    if (inspectedAt) {
      this.inspectedCell = this.nearestCell(inspectedAt);
      if (this.inspectedCell !== null) this.scene?.setCursor(this.inspectedCell);
    }
    if (this.refinement?.spec.year && this.refinement.spec.kind !== 'hrdem') {
      const year = this.refinement.spec.year;
      if (!this.vintageText.startsWith(year)) {
        this.vintageText = copy.lidarValue(copy.lidarNearLot(this.refinement.spec.label), year);
        setFact(this.lotEls, 'lidar', copy.lidarFact, this.vintageText);
      }
    }
    await this.compute(signal);
    await this.updateCompare();
    this.showView(this.view);
  }

  /** Local position (metres from the lot's origin) of a cell in the loaded grid. */
  private cellLocal(cell: number): Position | null {
    const l = this.loaded;
    if (!l || cell >= l.px.length) return null;
    return applyAffine(gridToLocalAffine(l.summary.window, this.map.frame), [l.px[cell]!, l.py[cell]!]);
  }

  private nearestCell(p: Position): number | null {
    const l = this.loaded;
    if (!l) return null;
    const a = gridToLocalAffine(l.summary.window, this.map.frame);
    let best: number | null = null, bestD = Infinity;
    for (let i = 0; i < l.px.length; i++) {
      const [x, y] = applyAffine(a, [l.px[i]!, l.py[i]!]);
      const d = (x - p[0]) ** 2 + (y - p[1]) ** 2;
      if (d < bestD) [best, bestD] = [i, d];
    }
    return best;
  }

  private renderSurfaceFact() {
    const s = this.loaded?.summary;
    if (!s) return;
    const r = this.refinement;
    const value =
      r?.state === 'running' ? copy.surface.refining(s.source.resM)
      : s.source.kind !== 'hrdem' ? copy.surface.refined(s.source.resM, s.source.year)
      : copy.surface.base(s.source.resM);
    setFact(this.lotEls, 'surface', copy.surfaceFact, value);
  }

  /** Start the slow parts as soon as the address is known, in parallel with the lot lookup. */
  prefetch(lonLat: [number, number], signal: AbortSignal) {
    void loadHiresIndex().catch(() => {});
    void findMosaicItem(lonLat, signal)
      .then((item) => item && engine().prefetch(item.dsm, item.dtm))
      .catch(() => {}); // load() reports real failures
    if (!this.sceneUnavailable && webglAvailable()) void import('./scene/view3d').catch(() => {});
  }

  private async ensureScene(): Promise<void> {
    if (this.scene || this.sceneUnavailable) return;
    if (!webglAvailable()) {
      this.sceneUnavailable = true;
      this.view = 'map';
      this.els.viewNote.textContent = copy.view.webglMissing;
      this.els.viewNote.hidden = false;
      this.els.viewRadios.forEach((r) => (r.disabled = r.value === '3d'));
      return;
    }
    const { LotScene } = await import('./scene/view3d');
    this.scene = new LotScene(
      this.els.sceneHost,
      {
        onPick: (cell) => void this.pick(cell),
        onHover: (cell) => this.hover(cell),
        onCamera: (deg) => (this.els.compass.style.transform = `rotate(${deg}deg)`),
      },
      { lowPower: isLowPower() },
    );
    this.scene.canvas.setAttribute('aria-label', copy.view.keyboard);
    this.scene.setShadows(this.els.shadowsToggle.checked);
  }

  private cellGrid(): CellGrid | null {
    const l = this.loaded;
    if (!l) return null;
    const w = l.summary.window;
    return { width: w.width, height: w.height, px: l.px, py: l.py, covered: l.covered, step: l.summary.step };
  }

  private buildScene(parcel: Parcel, keepCamera = false) {
    const l = this.loaded, grid = this.cellGrid();
    if (!this.scene || !l || !grid) return;
    this.scene.setModel(
      {
      window: l.summary.window,
      dsm: l.dsm,
      dtm: l.dtm,
      affine: gridToLocalAffine(l.summary.window, this.map.frame),
      cells: grid,
      lotLocal: mapGeometry(parcel.geometry, this.map.frame.toLocal),
      },
      { keepCamera },
    );
  }

  get currentView(): View {
    return this.view;
  }

  /** Switch views (also used to restore a shared link before a lot loads). */
  setView(v: View) {
    if (v === '3d' && this.sceneUnavailable) return;
    this.view = v;
    if (this.loaded) this.showView(v);
    else this.els.viewRadios.forEach((r) => (r.checked = r.value === v));
  }

  private showView(v: View) {
    const use3d = v === '3d' && !!this.scene && !!this.loaded;
    this.els.sceneHost.hidden = !use3d;
    this.els.mapCanvas.hidden = use3d;
    this.els.hud.hidden = !use3d;
    for (const r of this.els.viewRadios) r.checked = r.value === (use3d ? '3d' : this.loaded ? 'map' : this.view);
    if (!use3d) this.map.draw();
    else this.scene!.invalidate();
  }

  private async load(steps: Steps | null, signal: AbortSignal | undefined, fresh: boolean) {
    if (!this.lotRequest) return;
    const loaded = await engine().load(
      this.lotRequest,
      (p) => {
        if (!steps) return;
        if (p.stage === 'horizon') {
          steps.set('elevation', 'done');
          steps.set('sunlight', 'active', copy.sunlightProgress(Math.round((100 * p.done) / Math.max(1, p.total))));
        }
      },
      signal,
    );
    this.adopt(loaded, fresh);
  }

  /** Take a freshly loaded grid: map model, timings, notices. */
  private adopt(loaded: LoadedMessage, fresh: boolean) {
    this.loaded = loaded;
    const s = loaded.summary;
    this.timings = { ...this.timings, elevationMs: s.timings.elevationMs, horizonMs: s.timings.horizonMs };
    this.threads = s.timings.threads;
    if (fresh) {
      this.map.setAnalysis({
        window: s.window,
        dsm: loaded.dsm,
        gammaDeg: s.gammaDeg,
        px: loaded.px,
        py: loaded.py,
        covered: loaded.covered,
        step: s.step,
        affine: gridToLocalAffine(s.window, this.map.frame),
      });
    }
    const notices: string[] = [];
    if (s.cellSizeM > s.source.resM) notices.push(copy.analysisNotices.coarsened(s.cellSizeM));
    if (s.dropped > 0) notices.push(copy.analysisNotices.dropped(s.dropped));
    if (s.bufferNodataFrac > ELEVATION.bufferNodataWarn) notices.push(copy.analysisNotices.bufferNodata(Math.max(1, Math.round(100 * s.bufferNodataFrac))));
    setAnalysisNotices(this.lotEls, notices);
    this.renderSurfaceFact();
  }

  /** Controls state with the timeline's date and time folded in. */
  private state(): ControlState {
    const t = this.timeline.get();
    return { ...this.controls.get(), date: t.date, time: minuteLabel(t.minute) };
  }

  private async compute(signal?: AbortSignal) {
    if (!this.loaded) return;
    const seq = ++this.computeSeq;
    const { result, ms } = await engine().compute(requestFor(this.state()), signal);
    if (seq !== this.computeSeq) return; // superseded
    this.result = result;
    this.timings = { ...this.timings, computeMs: ms };
    this.render();
  }

  /** Controls changed: reload horizons (observer), recompute (dates/mode) or just redraw. */
  async onControls(kind: ChangeKind) {
    if (!this.loaded || !this.lotRequest) return;
    try {
      if (kind === 'display') return this.render();
      this.els.summary.textContent = copy.summary.recalculating;
      if (kind === 'observer') {
        this.lotRequest = { ...this.lotRequest, observer: OBSERVERS[this.controls.get().observer] };
        await this.load(null, undefined, false);
      }
      await this.compute();
      await this.updateCompare();
      if (this.refinement?.state === 'interrupted') void this.refine();
    } catch (e) {
      if ((e as { name?: string }).name !== 'AbortError') this.els.summary.textContent = errorMessage(e);
    }
  }

  /** Timeline moved: re-aim the 3D sun; recompute what depends on the date or time. */
  async onTimeline(_t: TimelineState, dateChanged: boolean) {
    if (!this.loaded || !this.lotRequest) return;
    this.updateSun();
    const mode = this.controls.get().mode;
    try {
      if (mode === 'moment' || (mode === 'day' && dateChanged)) await this.compute();
      else if (dateChanged) this.refreshInspector(); // its day strip follows the date
      await this.updateCompare();
    } catch (e) {
      if ((e as { name?: string }).name !== 'AbortError') this.els.summary.textContent = errorMessage(e);
    }
  }

  private updateSun() {
    const req = this.lotRequest;
    if (!req) return;
    const [lon, lat] = req.lonLat;
    const t = this.timeline.get();
    const date = this.timeline.localDate();
    const sun = momentSample(date, t.minute, lat, lon);
    if (this.pathCache?.key !== t.date) this.pathCache = { key: t.date, samples: daySamples(date, lat, lon, 10) };
    this.scene?.setSun({ azTrueDeg: sun.azTrueDeg, altDeg: sun.altDeg, path: this.pathCache.samples });
    this.els.sunNote.hidden = sun.altDeg > 0;
    this.els.sunNote.textContent = copy.view.sunDown;
  }

  /** Debug: the engine's sun/shade at the slider time, laid over the 3D shadows. */
  private async updateCompare() {
    if (!this.scene || !this.loaded) return;
    if (!this.els.compareToggle.checked) return this.scene.setCompare(null);
    const seq = ++this.compareSeq;
    const t = this.timeline.get();
    const { result } = await engine().compute({ kind: 'moment', date: this.timeline.localDate(), minuteOfDay: t.minute });
    if (seq === this.compareSeq && result.kind === 'moment' && this.els.compareToggle.checked) this.scene.setCompare(result.values as Uint8Array);
  }

  private layer(): Layer | null {
    const r = this.result;
    if (!r || r.kind === 'inspect') return null;
    const kind = r.kind === 'moment' ? 'moment' : r.kind === 'shade' ? 'percent' : 'hours';
    const c = this.controls.get();
    return { kind, values: r.values, asClasses: kind === 'hours' && c.classes, thresholds: { fullSunH: c.fullSunH, partSunH: c.partSunH } };
  }

  private render() {
    const layer = this.layer();
    this.map.setLayer(layer);
    this.scene?.setLayer(layer);
    this.renderLegend(layer);
    this.renderSummary();
    this.renderDebug();
    this.els.readout.textContent = copy.inspector.hint;
    this.refreshInspector();
  }

  /** Keep an open inspector in step with the current mode, dates and thresholds. */
  private refreshInspector() {
    if (this.inspectedCell !== null && !this.els.inspector.hidden) void this.pick(this.inspectedCell);
  }

  private renderLegend(layer: Layer | null) {
    const L = this.els.legend;
    L.replaceChildren();
    L.hidden = !layer;
    if (!layer) return;
    const swatch = (color: string, text: string, hatch = false) => {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const sw = document.createElement('span');
      sw.className = hatch ? 'swatch hatch' : 'swatch';
      sw.style.background = color;
      item.append(sw, text);
      return item;
    };
    if (layer.kind === 'moment') {
      L.append(swatch(css(SUN_RGB), copy.legend.sun), swatch(css(SHADE_RGB), copy.legend.shade));
    } else if (layer.asClasses) {
      copy.legend.classes(layer.thresholds ?? this.controls.get()).forEach((t, i) => L.append(swatch(css(CLASS_RGB[i as 0 | 1 | 2]), t)));
    } else {
      const bar = document.createElement('div');
      bar.className = 'legend-bar';
      const label = document.createElement('span');
      label.className = 'legend-title';
      label.textContent = layer.kind === 'percent' ? copy.legend.percent : copy.legend.hours;
      const ramp = document.createElement('span');
      ramp.className = 'ramp';
      ramp.style.background = cividisGradient();
      if (layer.kind === 'percent') ramp.style.transform = 'scaleX(-1)'; // more shade = darker
      const ticks = document.createElement('span');
      ticks.className = 'ticks';
      const labels = layer.kind === 'percent' ? ['0%', '50%', '100%'] : ['0', String(HOURS_SCALE_MAX / 2), `${HOURS_SCALE_MAX} h`];
      ticks.append(...labels.map((t) => Object.assign(document.createElement('span'), { textContent: t })));
      bar.append(label, ramp, ticks);
      L.append(bar);
    }
    L.append(swatch('repeating-linear-gradient(45deg, #333 0 2px, transparent 2px 5px)', copy.legend.covered, true));
  }

  private renderSummary() {
    const r = this.result;
    if (!r) return;
    const t = copy.summary;
    this.els.summary.textContent =
      r.kind === 'season' ? t.season(r.days, r.meanDaylightH)
      : r.kind === 'day' ? t.day(r.daylightH)
      : r.kind === 'moment' ? t.moment(r.altDeg, r.azTrueDeg)
      : r.kind === 'shade' ? t.shade(r.windowHours ? (100 * r.sunUpHours) / r.windowHours : 0, r.days)
      : '';
  }

  private valueText(cell: number): string {
    const r = this.result;
    if (!r || r.kind === 'inspect') return '';
    const v = r.values[cell]!;
    return r.kind === 'moment' ? (v ? copy.readout.sunNow : copy.readout.shadeNow) : r.kind === 'shade' ? copy.readout.percent(v) : copy.readout.hours(v);
  }

  hover(cell: number | null) {
    const l = this.loaded;
    if (!l || !this.result) return;
    if (cell === null) {
      this.els.readout.textContent = copy.inspector.hint;
      return;
    }
    const extra = [l.covered[cell] ? copy.readout.covered : '', copy.readout.height(l.z0[cell]!)].filter(Boolean);
    this.els.readout.textContent = `${this.valueText(cell)} · ${extra.join(' · ')}`;
  }

  async pick(cell: number) {
    const l = this.loaded;
    if (!l) return;
    this.inspectedCell = cell;
    const seq = ++this.pickSeq;
    const s = this.state();
    const date = this.timeline.localDate();
    try {
      const { result } = await engine().compute({ kind: 'inspect', cell, date, year: s.year });
      if (result.kind !== 'inspect' || seq !== this.pickSeq) return;
      renderInspector(this.els.inspector, {
        heading: this.valueText(cell),
        details: [this.contextText(s), l.covered[cell] ? copy.inspector.covered : '', copy.inspector.height(l.z0[cell]!)].filter(Boolean),
        monthlyHours: result.inspection.monthlyHours,
        strip: result.inspection.strip,
        dateLabel: s.date,
        year: s.year,
        fullSunH: s.fullSunH,
      });
    } catch (e) {
      this.els.inspector.textContent = errorMessage(e);
      this.els.inspector.hidden = false;
    }
  }

  private contextText(s: ControlState): string {
    const c = copy.inspector.context;
    switch (s.mode) {
      case 'moment':
        return c.moment(s.date, s.time);
      case 'day':
        return c.day(s.date);
      case 'season':
        return s.preset === 'custom' ? c.custom(s.start, s.end) : c.season(copy.inspector.presets[s.preset] ?? s.preset, s.year);
      case 'shade':
        return c.shade(s.fromTime, s.toTime, s.shadeStart, s.shadeEnd);
    }
  }

  private renderDebug() {
    const l = this.loaded;
    if (!l) return;
    const s = l.summary;
    const rows: [string, string][] = [
      ['Grid convergence γ', `${s.gammaDeg.toFixed(2)}°`],
      ['Elevation source', `${s.source.label}${s.source.year ? ` ${s.source.year}` : ''} (${s.window.crs}, ${s.source.resM} m)${s.source.detail ? `; ${s.source.detail}` : ''}`],
      ['Refinement', this.refinement ? `${this.refinement.spec.label}: ${this.refinement.state}${this.refinement.note ? ` (${this.refinement.note})` : ''}` : 'none available'],
      ['Cells', `${s.cells.toLocaleString('en-CA')} at ${s.cellSizeM} m${s.dropped ? ` (${s.dropped} nodata dropped)` : ''}`],
      ['Window', `${s.window.width * s.window.res} × ${s.window.height * s.window.res} m, ${(100 * s.bufferNodataFrac).toFixed(1)}% nodata`],
      ['LiDAR', this.vintageText || '…'],
      ['3D', this.scene ? `WebGL${isLowPower() ? ', low-power settings' : ''}` : this.sceneUnavailable ? 'unavailable' : '…'],
      ['Timings', Object.entries(this.timings).map(([k, v]) => `${k.replace(/Ms$/, '')} ${v} ms`).join(', ') + (this.threads > 1 ? ` (horizon on ${this.threads} threads)` : '')],
    ];
    this.els.debug.replaceChildren(
      ...rows.flatMap(([k, v]) => [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })]),
    );
  }
}
