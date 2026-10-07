// Elevation → horizons → sun results for the selected lot, and everything the debug view shows
// about them: heatmap layer, legend, hover readout, inspector text, notices and debug facts.
import { ELEVATION, OBSERVERS } from './config';
import { copy } from './copy';
import type { GeocodeMatch } from './data/geocoder';
import type { Parcel } from './data/parcels';
import { findMosaicItem } from './elevation/stac';
import { vintageFor } from './elevation/vintage';
import { EngineError, ShadeEngine } from './engine/client';
import type { ComputeResult, LoadedMessage } from './engine/protocol';
import { formatLocal } from './engine/sun';
import { gridToLocalAffine } from './geo/gridAffine';
import { mapGeometry, polygonsOf } from './geo/polygon';
import { convergenceDeg, toLcc } from './geo/proj';
import { CLASS_RGB, SHADE_RGB, SUN_RGB, cividisGradient, css } from './ui/colors';
import { requestFor, type ChangeKind, type Controls } from './ui/controls';
import { HOURS_SCALE_MAX, type Layer, type LotCanvas } from './ui/lotCanvas';
import { setAnalysisNotices, setFact, type LotViewElements } from './ui/lotView';
import type { Steps } from './ui/status';

export interface AnalysisElements {
  legend: HTMLElement;
  readout: HTMLElement;
  summary: HTMLElement;
  inspector: HTMLElement;
  debug: HTMLDListElement;
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
  }
  return copy.elevationDown;
}

export class Analysis {
  private loaded: LoadedMessage | null = null;
  private result: ComputeResult | null = null;
  private lotRequest: Parameters<ShadeEngine['load']>[0] | null = null;
  private computeSeq = 0;
  private timings: Record<string, number> = {};
  private vintageText = '';

  constructor(
    private canvas: LotCanvas,
    private controls: Controls,
    private lotEls: LotViewElements,
    private els: AnalysisElements,
  ) {}

  /** Run the whole pipeline for a lot already drawn on the canvas. */
  async start(parcel: Parcel, match: GeocodeMatch, steps: Steps, signal: AbortSignal) {
    this.loaded = null;
    this.result = null;
    this.els.inspector.hidden = true;
    this.els.summary.textContent = '';
    this.els.readout.textContent = '';
    this.els.legend.hidden = true;
    setAnalysisNotices(this.lotEls, []);

    const centre = this.canvas.frame.origin;
    steps.set('elevation', 'active');
    const t0 = performance.now();
    const item = await findMosaicItem(centre, signal);
    if (!item) throw new NoCoverageError();
    this.timings = { stacMs: Math.round(performance.now() - t0) };

    void vintageFor(centre, signal).then((v) => {
      if (!v || signal.aborted) return;
      this.vintageText = copy.lidarValue(v.label, v.date);
      setFact(this.lotEls, 'lidar', copy.lidarFact, this.vintageText);
      this.renderDebug();
    });

    this.lotRequest = {
      dsmUrl: item.dsm,
      dtmUrl: item.dtm,
      lot3979: polygonsOf(mapGeometry(parcel.geometry, toLcc)),
      lonLat: centre,
      gammaDeg: convergenceDeg(centre),
      observer: OBSERVERS[this.controls.get().observer],
      bufferM: ELEVATION.bufferM,
      cellCap: ELEVATION.cellCap,
    };
    await this.load(steps, signal);
    steps.set('sunlight', 'active');
    await this.compute(signal);
    steps.set('sunlight', 'done');
    this.controls.show();
  }

  private async load(steps: Steps | null, signal?: AbortSignal) {
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
    this.loaded = loaded;
    const s = loaded.summary;
    this.timings = { ...this.timings, elevationMs: s.timings.elevationMs, horizonMs: s.timings.horizonMs };
    this.canvas.setAnalysis({
      window: s.window,
      dsm: loaded.dsm,
      gammaDeg: s.gammaDeg,
      px: loaded.px,
      py: loaded.py,
      covered: loaded.covered,
      step: s.step,
      affine: gridToLocalAffine(s.window, this.canvas.frame),
    });
    const notices: string[] = [];
    if (s.step > 1) notices.push(copy.analysisNotices.coarsened(s.step));
    if (s.dropped > 0) notices.push(copy.analysisNotices.dropped(s.dropped));
    if (s.bufferNodataFrac > ELEVATION.bufferNodataWarn) notices.push(copy.analysisNotices.bufferNodata(Math.max(1, Math.round(100 * s.bufferNodataFrac))));
    setAnalysisNotices(this.lotEls, notices);
  }

  private async compute(signal?: AbortSignal) {
    if (!this.loaded) return;
    const seq = ++this.computeSeq;
    const { result, ms } = await engine().compute(requestFor(this.controls.get()), signal);
    if (seq !== this.computeSeq) return; // a newer request superseded this one
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
        await this.load(null);
      }
      await this.compute();
    } catch (e) {
      if ((e as { name?: string }).name !== 'AbortError') this.els.summary.textContent = errorMessage(e);
    }
  }

  private layer(): Layer | null {
    const r = this.result;
    if (!r || r.kind === 'inspect') return null;
    const kind = r.kind === 'moment' ? 'moment' : r.kind === 'shade' ? 'percent' : 'hours';
    return { kind, values: r.values, asClasses: kind === 'hours' && this.controls.get().classes };
  }

  private render() {
    const layer = this.layer();
    this.canvas.setLayer(layer);
    this.renderLegend(layer);
    this.renderSummary();
    this.renderDebug();
    this.els.readout.textContent = copy.readout.hint;
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
      copy.legend.classes.forEach((t, i) => L.append(swatch(css(CLASS_RGB[i as 0 | 1 | 2]), t)));
    } else {
      const bar = document.createElement('div');
      bar.className = 'legend-bar';
      const label = document.createElement('span');
      label.className = 'legend-title';
      label.textContent = layer.kind === 'percent' ? copy.legend.percent : copy.legend.hours;
      const ramp = document.createElement('span');
      ramp.className = 'ramp';
      // Shade % is drawn with the ramp reversed: more shade = darker.
      ramp.style.background = cividisGradient();
      if (layer.kind === 'percent') ramp.style.transform = 'scaleX(-1)';
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

  hover(cell: number | null) {
    const r = this.result, l = this.loaded;
    if (!r || !l || r.kind === 'inspect') return;
    if (cell === null) {
      this.els.readout.textContent = copy.readout.hint;
      return;
    }
    const v = r.values[cell]!;
    const main =
      r.kind === 'moment' ? (v ? copy.readout.sunNow : copy.readout.shadeNow)
      : r.kind === 'shade' ? copy.readout.percent(v)
      : copy.readout.hours(v);
    const extra = [l.covered[cell] ? copy.readout.covered : '', copy.readout.height(l.z0[cell]!)].filter(Boolean);
    this.els.readout.textContent = `${main} · ${extra.join(' · ')}`;
  }

  async pick(cell: number) {
    if (!this.loaded) return;
    const s = this.controls.get();
    const req = requestFor({ ...s, mode: 'day' });
    if (req.kind !== 'day') return;
    try {
      const { result } = await engine().compute({ kind: 'inspect', cell, date: req.date, year: s.year });
      if (result.kind !== 'inspect') return;
      const { monthlyHours, strip } = result.inspection;
      const months = monthlyHours.map((h, i) => `${copy.inspector.months[i]} ${h.toFixed(1)} h`).join(' · ');
      const bar = strip.map((x) => (x.sunlit ? '█' : '·')).join('');
      const first = strip[0] ? formatLocal(strip[0].time) : '';
      const last = strip.at(-1) ? formatLocal(strip.at(-1)!.time) : '';
      this.els.inspector.textContent = `${copy.inspector.title}\n${months}\n\n${copy.inspector.strip(s.date)}\n${first} ${bar} ${last}`;
      this.els.inspector.hidden = false;
    } catch (e) {
      this.els.inspector.textContent = errorMessage(e);
      this.els.inspector.hidden = false;
    }
  }

  private renderDebug() {
    const l = this.loaded;
    if (!l) return;
    const s = l.summary;
    const rows: [string, string][] = [
      ['Grid convergence γ', `${s.gammaDeg.toFixed(2)}°`],
      ['Cells', `${s.cells.toLocaleString('en-CA')} at ${s.step} m${s.dropped ? ` (${s.dropped} nodata dropped)` : ''}`],
      ['Window', `${s.window.width} × ${s.window.height} m, ${(100 * s.bufferNodataFrac).toFixed(1)}% nodata`],
      ['LiDAR', this.vintageText || '…'],
      ['Timings', Object.entries(this.timings).map(([k, v]) => `${k.replace(/Ms$/, '')} ${v} ms`).join(', ')],
    ];
    this.els.debug.replaceChildren(
      ...rows.flatMap(([k, v]) => [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })]),
    );
  }
}
