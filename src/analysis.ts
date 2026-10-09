// Elevation → horizons → sun results for the selected lot, and everything the view shows about
// them: the 3D scene (lazy-loaded) and 2D map, the shared timeline, legend, readout, inspector,
// notices and debug facts.
import { ELEVATION, IMAGERY, OBSERVERS } from './config';
import { copy } from './copy';
import type { GeocodeMatch } from './data/geocoder';
import type { Parcel } from './data/parcels';
import { displayJurisdiction } from './data/scope';
import { fetchPhoto, type Photo } from './imagery/fetch';
import { gridToPhotoUv, photoBox, photoToLocal } from './imagery/georef';
import { imageryFor } from './imagery/sources';
import { loadHiresIndex, refinementOptions, refinementOrder, SOURCE_CHOICES, type RefinementOptions, type SourceChoice, type SourcePreference } from './elevation/hires';
import { findMosaicItem } from './elevation/stac';
import { vintageFor, type Vintage } from './elevation/vintage';
import { EngineError, ShadeEngine } from './engine/client';
import type { ComputeResult, ElevationSpec, HrdemSpec, LoadedMessage } from './engine/protocol';
import { daySamples, isoDate, momentSample, type LocalDate, type SunSample } from './engine/sun';
import { MOSTLY_COVERED, sideOf, summarizeLot } from './engine/lotSummary';
import { findSpots, type Spots } from './engine/spots';
import { applyAffine, gridToLocalAffine } from './geo/gridAffine';
import { mapGeometry, polygonsOf, type Position } from './geo/polygon';
import type { LotScene } from './scene/view3d';
import { isLowPower, webglAvailable } from './scene/webgl';
import { hatchMaskRgba, maskBounds, stretchScale, type CellGrid } from './ui/cellPaint';
import { CEDAR_RGB, CLASS_RGB, SHADE_RGB, SUN_RGB, cividisGradient, css } from './ui/colors';
import { requestFor, seasonRange, type ChangeKind, type ControlState, type Controls } from './ui/controls';
import { renderInspector } from './ui/inspector';
import { HOURS_SCALE_MAX, type Layer, type LotCanvas } from './ui/lotCanvas';
import { setAnalysisNotices, setFact, setRichText, type LotViewElements } from './ui/lotView';
import { SpotPins, type PinSpec, type SpotKind } from './ui/spotPins';
import type { Steps } from './ui/status';
import { dayMinuteRange, middayMinute, minuteLabel, type Timeline, type TimelineState } from './ui/timeline';

export interface AnalysisElements {
  headline: HTMLElement;
  timelineNote: HTMLElement;
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
  photoToggle: HTMLInputElement;
  opacityInput: HTMLInputElement;
  opacityWrap: HTMLElement;
  photoCredit: HTMLElement;
  elevationWrap: HTMLElement;
  elevationSelect: HTMLSelectElement;
  changesWrap: HTMLElement;
  changesToggle: HTMLInputElement;
  changesLabel: HTMLElement;
  /** The layer over the view that holds the sunniest / shadiest pins. */
  spotLayer: HTMLElement;
  /** Basic mode's maximum / minimum summary. */
  basicSummary: HTMLElement;
}

/** The date halfway between two dates (calendar maths only). */
function middleDate(a: LocalDate, b: LocalDate): LocalDate {
  const day = (d: LocalDate) => Date.UTC(d.year, d.month - 1, d.day) / 86_400_000;
  const mid = new Date(Math.round((day(a) + day(b)) / 2) * 86_400_000);
  return { year: mid.getUTCFullYear(), month: mid.getUTCMonth() + 1, day: mid.getUTCDate() };
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
  /** Each cell's position in local metres, for the headline (refreshed with the grid). */
  private cellPositions: Position[] = [];
  /** The current result's sunniest and shadiest patches (found in render(), for the headline and pins). */
  private spots: Spots = { sunniest: null, shadiest: null };
  private pins: SpotPins;
  /** Basic mode (the default): the summary, dates and a full-width view; false shows Advanced options. */
  private basic = true;
  /** The current lot (for restarting a refinement an observer change interrupted). */
  private lot: { parcel: Parcel; signal: AbortSignal } | null = null;
  /** The sharper surface loading (or loaded) after the first result. */
  private refinement: { spec: ElevationSpec; state: 'running' | 'interrupted' | 'done' | 'failed'; note?: string } | null = null;
  private refineSeq = 0;
  /** The lot's HRDEM tile, its sharper surfaces (looked up once per lot) and any that failed to load. */
  private hrdemSpec: HrdemSpec | null = null;
  private options: RefinementOptions | null = null;
  private failedSpecs = new Set<ElevationSpec>();
  /** The "Elevation data" setting (URL `elev=`); set it with chooseSource(). */
  private preference: SourcePreference = 'best';
  /** The HRDEM survey at the lot, for the LiDAR facts. */
  private baseVintage: Vintage | null = null;
  private changesOn = false;
  private jurisdiction = '';
  /** On by default; `photoChosen` says whether the visitor (or their link) asked for it. */
  private photoOn = true;
  private photoChosen = false;
  private opacity: number = IMAGERY.defaultOpacity;
  private photo: Photo | null = null;
  private photoSeq = 0;
  /** Called when the user switches between 3D and map (for the shareable URL). */
  onViewChange: (v: View) => void = () => {};
  /** Called when the aerial photo or its opacity changes (for the shareable URL). */
  onPhotoChange: () => void = () => {};
  /** Called when the elevation choice or the change overlay changes (for the shareable URL). */
  onSourceChange: () => void = () => {};

  constructor(
    private map: LotCanvas,
    private controls: Controls,
    private timeline: Timeline,
    private lotEls: LotViewElements,
    private els: AnalysisElements,
  ) {
    this.pins = new SpotPins(els.spotLayer, (cell) => this.pickSpot(cell), () => (this.view === '3d' && !els.sceneHost.hidden ? (this.scene?.canvas ?? null) : null));
    map.onDraw = () => this.placePins();
    for (const r of els.viewRadios)
      r.addEventListener('change', () => {
        if (!r.checked) return;
        this.setView(r.value as View);
        this.onViewChange(this.view);
      });
    els.shadowsToggle.addEventListener('change', () => this.scene?.setShadows(!this.basic && els.shadowsToggle.checked));
    els.compareToggle.addEventListener('change', () => void this.updateCompare());
    els.resetView.addEventListener('click', () => this.scene?.resetView());
    els.photoToggle.addEventListener('change', () => {
      this.setPhotoEnabled(els.photoToggle.checked);
      this.onPhotoChange();
    });
    els.photoToggle.checked = this.photoOn;
    els.opacityWrap.hidden = !this.photoOn;
    els.opacityInput.addEventListener('input', () => {
      this.setResultsOpacity(Number(els.opacityInput.value));
      this.onPhotoChange();
    });
    els.elevationSelect.addEventListener('change', () => {
      this.chooseSource(els.elevationSelect.value as SourceChoice);
      this.onSourceChange();
    });
    els.changesToggle.addEventListener('change', () => {
      this.setChangesEnabled(els.changesToggle.checked);
      this.onSourceChange();
    });
  }

  get sourcePreference(): SourcePreference {
    return this.preference;
  }

  get changesEnabled(): boolean {
    return this.changesOn;
  }

  /**
   * The "Elevation data" setting (also restores a shared link). With a lot loaded, switches its
   * surface; the worker still has the downloads, so this re-composes rather than re-fetches.
   */
  chooseSource(pref: SourcePreference) {
    if (pref === this.preference) return;
    this.preference = pref;
    this.renderSourceChoice();
    if (!this.options || !this.lot) return;
    this.refinement = null;
    void this.refine();
  }

  /** Hatch the areas where the newer survey replaced the older one ("best of both" only). */
  setChangesEnabled(on: boolean) {
    this.changesOn = on;
    this.els.changesToggle.checked = on;
    this.applyChanges();
  }

  private renderSourceChoice() {
    const o = this.options ?? {};
    const sel = this.els.elevationSelect;
    // A choice only exists where "best of both" does (otherwise there's one surface).
    const choices = o.best?.kind === 'merged' ? SOURCE_CHOICES.filter((c) => o[c]) : [];
    this.els.elevationWrap.hidden = choices.length < 2;
    sel.replaceChildren(
      ...choices.map((c) => {
        const spec = o[c]!;
        const label =
          c === 'best' && spec.kind === 'merged' ? copy.elevationChoice.best(spec.oldYear, spec.year ?? '')
          : c === 'newest' ? copy.elevationChoice.newest(spec.year ?? '')
          : copy.elevationChoice.detailed(spec.year ?? '');
        return Object.assign(document.createElement('option'), { value: c, textContent: label });
      }),
    );
    sel.value = choices.includes(this.preference as SourceChoice) ? this.preference : 'best';
  }

  /** "LiDAR from", the caveat and the About line, for whichever surface is loaded. */
  private renderLidarFacts() {
    const s = this.loaded?.summary.source;
    const v = this.baseVintage;
    let fact: string | null = null, caveat: string | null = null, about: string | null = null;
    if (s?.kind === 'merged' && s.year && s.oldYear) {
      fact = copy.lidarMerged(s.oldYear, s.year);
      caveat = copy.caveatMerged(s.oldYear, s.year);
      about = copy.aboutMerged(s.oldYear, s.year);
    } else if (s && s.kind !== 'hrdem' && s.year && (!v || !v.date.startsWith(s.year))) {
      // A survey other than the HRDEM one at the lot.
      const label = s.kind === 'copc' ? `${s.label} point cloud` : s.label;
      fact = copy.lidarValue(copy.lidarNearLot(label), s.year);
      caveat = copy.caveatLidar(s.year);
      about = copy.aboutLidar(label, s.year);
    } else if (v) {
      fact = copy.lidarValue(v.label, v.date);
      caveat = copy.caveatLidar(v.date.slice(0, 4));
      about = copy.aboutLidar(v.label, v.date.slice(0, 4));
    }
    if (!fact) return;
    this.vintageText = fact;
    setFact(this.lotEls, 'lidar', copy.lidarFact, fact, true);
    this.renderDataFact();
    this.els.caveatLidar.textContent = caveat;
    this.els.aboutLidar.textContent = about;
  }

  private applyChanges() {
    const l = this.loaded, s = l?.summary.source;
    const available = !!l?.changed && s?.kind === 'merged' && (s.changedShare ?? 0) > 0;
    this.els.changesWrap.hidden = !available;
    if (available && s.oldYear) this.els.changesLabel.textContent = copy.changesToggle(s.oldYear);
    const show = available && this.changesOn;
    let canvas: HTMLCanvasElement | null = null, rect: ReturnType<typeof maskBounds> = null;
    if (show) {
      const { width, height } = l.summary.window;
      rect = maskBounds(l.changed!, width, height);
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.putImageData(new ImageData(hatchMaskRgba(l.changed!, width, height, CEDAR_RGB, 150), width, height), 0, 0);
    }
    this.scene?.setChangeMask(canvas && rect ? { image: canvas, rect } : null);
    this.map.setChangeMask(canvas);
    if (this.result) this.renderLegend(this.layer());
  }

  get photoEnabled(): boolean {
    return this.photoOn;
  }

  get resultsOpacity(): number {
    return this.opacity;
  }

  /** Aerial photo under the results, in both views (also restores a shared link). */
  setPhotoEnabled(on: boolean, chosen = true) {
    this.photoOn = on;
    this.photoChosen = chosen;
    this.els.photoToggle.checked = on;
    this.els.opacityWrap.hidden = !on;
    this.applyOpacity();
    void this.updatePhoto();
  }

  setResultsOpacity(opacity: number) {
    this.opacity = Math.min(1, Math.max(0.2, opacity));
    this.els.opacityInput.value = String(this.opacity);
    this.applyOpacity();
  }

  /** Results are see-through only over the photo; on the plain model they stay solid. */
  private applyOpacity() {
    const op = this.photoOn ? this.opacity : 1;
    this.scene?.setResultsOpacity(op);
    this.map.setLayerOpacity(op);
  }

  private clearPhoto() {
    this.photo = null;
    this.scene?.setPhoto(null);
    this.map.setPhoto(null);
  }

  private async updatePhoto() {
    const seq = ++this.photoSeq;
    const credit = this.els.photoCredit;
    const lot = this.lot;
    if (!this.photoOn || !this.loaded || !lot) {
      this.clearPhoto();
      credit.hidden = true;
      return;
    }
    credit.hidden = false;
    const source = imageryFor(this.jurisdiction);
    if (!source) {
      this.clearPhoto();
      credit.textContent = this.photoChosen ? copy.imagery.gap(this.jurisdiction) : copy.imagery.gapQuiet(this.jurisdiction);
      return;
    }
    credit.textContent = copy.imagery.loading;
    try {
      const photo = await fetchPhoto(source, photoBox(polygonsOf(lot.parcel.geometry), IMAGERY.marginM));
      if (seq !== this.photoSeq) return;
      if (!photo) {
        this.clearPhoto();
        credit.textContent = copy.imagery.noCoverage(source.owner);
        return;
      }
      this.applyPhoto(photo);
      credit.textContent = source.credit;
    } catch {
      if (seq !== this.photoSeq) return;
      this.clearPhoto();
      credit.textContent = copy.imagery.failed;
    }
    this.renderDebug();
  }

  /** Place the photo on the current grid (again after a refinement changes grids). */
  private applyPhoto(photo: Photo) {
    const l = this.loaded;
    if (!l) return;
    this.photo = photo;
    this.scene?.setPhoto({ image: photo.image, uv: gridToPhotoUv(l.summary.window, photo.box) });
    this.map.setPhoto({ image: photo.image, affine: photoToLocal(photo.box, photo.image.width, photo.image.height, this.map.frame) });
  }

  /** Run the whole pipeline for a lot already drawn on the map. */
  async start(parcel: Parcel, match: GeocodeMatch, steps: Steps, signal: AbortSignal) {
    this.refineSeq++; // abandon the previous lot's refinement
    this.refinement = null;
    this.options = null;
    this.failedSpecs.clear();
    this.lot = { parcel, signal };
    this.baseVintage = null;
    this.renderSourceChoice();
    this.map.setChangeMask(null);
    this.jurisdiction = displayJurisdiction(parcel, match);
    this.photoSeq++;
    this.clearPhoto();
    this.els.photoCredit.hidden = true;
    this.loaded = null;
    this.result = null;
    this.clearPins();
    this.els.basicSummary.replaceChildren();
    this.els.inspector.hidden = true;
    this.inspectedCell = null;
    this.els.summary.textContent = '';
    this.els.headline.textContent = '';
    this.els.timelineNote.hidden = true;
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
      this.baseVintage = v;
      this.renderLidarFacts();
      this.renderDebug();
    });

    this.hrdemSpec = { dsmUrl: item.dsm, dtmUrl: item.dtm };
    this.lotRequest = {
      elevation: { kind: 'hrdem', hrdem: this.hrdemSpec, label: 'NRCan HRDEM 1 m', year: null },
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
    void this.updatePhoto();
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
  private async refine(attempt = 0) {
    const lot = this.lot, req = this.lotRequest, hrdem = this.hrdemSpec;
    if (!lot || !req || !hrdem || lot.signal.aborted) return;
    const seq = ++this.refineSeq;
    this.options ??= await refinementOptions(hrdem, req.lotLonLat, req.lonLat).catch(() => ({}));
    if (seq !== this.refineSeq || lot.signal.aborted) return;
    this.renderSourceChoice();
    // Resume an interrupted load, or take the preferred surface that hasn't failed for this lot.
    const resume = this.refinement?.state === 'interrupted' ? this.refinement.spec : null;
    const spec = resume ?? refinementOrder(this.options, this.sourcePreference).find((s) => !this.failedSpecs.has(s));
    if (!spec || spec === req.elevation) return;
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
      // Superseded by an observer reload (onControls restarts it), or a real failure: those are
      // occasionally transient (a garbled range read), so try once more, then the next surface.
      if ((e as { name?: string }).name === 'AbortError') this.refinement.state = 'interrupted';
      else {
        this.refinement = { ...this.refinement, state: attempt === 0 ? 'interrupted' : 'failed', note: e instanceof Error ? e.message : String(e) };
        if (attempt === 0) setTimeout(() => seq === this.refineSeq && void this.refine(1), 2000);
        else {
          this.failedSpecs.add(spec);
          setTimeout(() => seq === this.refineSeq && void this.refine(), 0);
        }
      }
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
    this.clearPins(); // their cells belong to the old grid
    this.adopt(loaded, true);
    this.buildScene(parcel, true);
    if (this.photo) this.applyPhoto(this.photo);
    this.updateSun();
    if (inspectedAt) {
      this.inspectedCell = this.nearestCell(inspectedAt);
      if (this.inspectedCell !== null) this.scene?.setCursor(this.inspectedCell);
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
      r?.state === 'running' ? (s.source.kind === 'hrdem' ? copy.surface.refining(s.source.resM) : copy.surface.switching)
      : s.source.kind === 'merged' ? copy.surfaceMerged(s.source.oldYear ?? '', s.source.year ?? '', s.source.changedShare ?? 0)
      : s.source.kind !== 'hrdem' ? copy.surface.refined(s.source.kind, s.source.resM, s.source.year)
      : copy.surface.base(s.source.resM);
    setFact(this.lotEls, 'surface', copy.surfaceFact, value, true);
    this.renderDataFact();
  }

  /** The plain "3D data" fact: which laser scans, in words. */
  private renderDataFact() {
    const s = this.loaded?.summary.source;
    if (!s) return;
    const baseYear = this.baseVintage?.date.slice(0, 4) ?? null;
    const d = copy.data;
    const value =
      this.refinement?.state === 'running' && s.kind === 'hrdem' ? d.loading(baseYear)
      : s.kind === 'merged' && s.oldYear && s.year ? d.merged(s.oldYear, s.year)
      : s.kind === 'copc' ? d.detailed(s.year)
      : s.kind === 'lidarbc' ? d.newest(s.year)
      : d.base(baseYear);
    setFact(this.lotEls, 'data', copy.facts.data, value);
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
    this.scene.setShadows(!this.basic && this.els.shadowsToggle.checked);
    this.scene.setSunVisible(!this.basic);
    this.scene.onRender = () => this.placePins();
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
    this.applyOpacity(); // the scene may not have existed when the opacity was set
    this.applyChanges();
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
    this.placePins();
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
    const toLocal = gridToLocalAffine(s.window, this.map.frame);
    this.cellPositions = Array.from(loaded.px, (px, i) => applyAffine(toLocal, [px, loaded.py[i]!]));
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
    this.renderLidarFacts();
    this.applyChanges();
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
    if (this.basic) {
      // An average has no single moment: light the 3D view from midday in the middle of the dates.
      const { start, end } = seasonRange(this.controls.get());
      const mid = middleDate(start, end);
      const sun = momentSample(mid, middayMinute(dayMinuteRange(mid, lat, lon)), lat, lon);
      this.scene?.setSun({ azTrueDeg: sun.azTrueDeg, altDeg: sun.altDeg, path: [] });
      this.els.sunNote.hidden = true;
      return;
    }
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
    if (this.basic && kind === 'hours') {
      const { low, high } = this.openRange();
      return { kind, values: r.values, asClasses: false, scale: stretchScale(low, high) };
    }
    return { kind, values: r.values, asClasses: kind === 'hours' && c.classes, thresholds: { fullSunH: c.fullSunH, partSunH: c.partSunH } };
  }

  private render() {
    this.spots = this.findSpots();
    this.updatePins();
    const layer = this.layer();
    this.map.setLayer(layer);
    this.scene?.setLayer(layer);
    this.renderLegend(layer);
    this.renderSummary();
    this.renderBasicSummary();
    if (this.basic) this.updateSun(); // its light follows the dates
    // The time slider always moves the 3D sun, but only changes the colours in "One moment".
    const mode = this.controls.get().mode;
    const note = mode === 'season' || mode === 'shade' ? copy.timelineNote.average : mode === 'day' ? copy.timelineNote.day : '';
    this.els.timelineNote.textContent = note;
    this.els.timelineNote.hidden = !note;
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
      const sc = layer.scale;
      const labels =
        layer.kind === 'percent' ? ['0%', '50%', '100%']
        : sc ? [sc.min.toFixed(1), ((sc.min + sc.max) / 2).toFixed(1), `${sc.max.toFixed(1)} h`]
        : ['0', String(HOURS_SCALE_MAX / 2), `${HOURS_SCALE_MAX} h`];
      ticks.append(...labels.map((t) => Object.assign(document.createElement('span'), { textContent: t })));
      bar.append(label, ramp, ticks);
      L.append(bar);
    }
    L.append(swatch('repeating-linear-gradient(45deg, #333 0 2px, transparent 2px 5px)', copy.legend.covered, true));
    const s = this.loaded?.summary.source;
    if (this.changesOn && !this.els.changesWrap.hidden && s?.oldYear && s.year)
      L.append(swatch('repeating-linear-gradient(-45deg, var(--cedar) 0 2px, transparent 2px 5px)', copy.legend.changed(s.oldYear, s.year), true));
    const tipsLink = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: copy.tipsLink });
    tipsLink.dataset.showTips = ''; // main.ts opens the card
    L.append(tipsLink);
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
    setRichText(this.els.headline, this.headlineText());
  }

  /** Covered cells as the summary sees them: on roofs and decks they're exactly what's being measured. */
  private summaryCovered(): ArrayLike<number> {
    const l = this.loaded!;
    return this.controls.get().observer === 'surface' ? new Uint8Array(l.covered.length) : l.covered;
  }

  /** The sunniest and shadiest patches of the current result (none at a moment, mid-load, or on a lot that's nearly all roof). */
  private findSpots(): Spots {
    const none = { sunniest: null, shadiest: null };
    const r = this.result, l = this.loaded;
    if (!r || !l || r.kind === 'inspect' || r.kind === 'moment') return none;
    const covered = this.summaryCovered();
    let n = 0;
    for (let i = 0; i < covered.length; i++) n += covered[i] ? 1 : 0;
    if (covered.length && n / covered.length >= MOSTLY_COVERED) return none;
    const s = l.summary;
    // Basic compares about 2 m × 2 m patches (a small garden bed), whatever the grid's cell size.
    const blockCells = this.basic ? Math.max(1, Math.round(2 / s.cellSizeM)) : undefined;
    return findSpots({ mode: r.kind, values: r.values, covered, px: l.px, py: l.py, step: s.step, cellAreaM2: s.cellSizeM * s.cellSizeM, tight: this.basic, blockCells });
  }

  /** The lowest and highest value on open ground, the share under roofs or trees, and the open cells' positions. */
  private openRange(): { low: number; high: number; coveredShare: number; open: Position[] } {
    const r = this.result, l = this.loaded;
    const out = { low: Infinity, high: -Infinity, coveredShare: 0, open: [] as Position[] };
    if (!r || !l || r.kind === 'inspect') return out;
    const covered = this.summaryCovered();
    let n = 0;
    for (let i = 0; i < r.values.length; i++) {
      if (covered[i]) {
        n++;
        continue;
      }
      const v = r.values[i]!;
      if (v !== v) continue;
      if (v < out.low) out.low = v;
      if (v > out.high) out.high = v;
      out.open.push(this.cellPositions[i]!);
    }
    out.coveredShare = r.values.length ? n / r.values.length : 0;
    return out;
  }

  /** Basic mode: "Maximum: 11.5 hours, in the north-east", the same for the minimum, and the dates. */
  private renderBasicSummary() {
    const el = this.els.basicSummary;
    el.replaceChildren();
    const r = this.result;
    if (!this.basic || !r || r.kind !== 'season') return;
    const b = copy.basic;
    const { start, end } = seasonRange(this.controls.get());
    const p = (className: string, textContent: string) => Object.assign(document.createElement('p'), { className, textContent });
    el.append(p('period', b.period(isoDate(start), isoDate(end))));
    const range = this.openRange();
    if (range.coveredShare >= MOSTLY_COVERED || !range.open.length) {
      el.append(p('note', b.mostlyCovered));
      return;
    }
    const { sunniest, shadiest } = this.spots;
    if (!sunniest || !shadiest) el.append(p('even', b.even(range.low, range.high)));
    else {
      const dl = Object.assign(document.createElement('dl'), { className: 'basic-stats' });
      for (const [kind, spot] of [['sunniest', sunniest], ['shadiest', shadiest]] as const) {
        const row = document.createElement('div');
        const dt = document.createElement('dt');
        const dot = Object.assign(document.createElement('span'), { className: 'spot-dot' });
        dot.dataset.kind = kind;
        dot.setAttribute('aria-hidden', 'true');
        dt.append(dot, `${kind === 'sunniest' ? b.max : b.min}:`);
        const [before, word] = b.where(sideOf([this.cellPositions[spot.cell]!], range.open, 'middle'));
        const show = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: word });
        show.append(Object.assign(document.createElement('span'), { className: 'visually-hidden', textContent: b.show(kind) }));
        show.addEventListener('click', () => this.highlightSpot(kind));
        const dd = document.createElement('dd');
        dd.append(Object.assign(document.createElement('strong'), { textContent: b.hours(spot.value) }), `, ${before} `, show);
        row.append(dt, dd);
        dl.append(row);
      }
      el.append(dl);
    }
    if (sunniest && shadiest) el.append(p('note', b.spotSize));
    if (range.coveredShare >= 0.05) el.append(p('note', copy.headline.covered(range.coveredShare)));
  }

  /** Point at a spot: pulse its pin, put the 3D ring there and bring the view into sight. */
  highlightSpot(kind: SpotKind) {
    const s = this.spots[kind];
    if (!s) return;
    if (this.view === '3d') this.scene?.setCursor(s.cell);
    this.pins.highlight(kind);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.els.spotLayer.closest('.view-stage')?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }

  get isBasic(): boolean {
    return this.basic;
  }

  /** Basic or Advanced: what the 3D view shows (no cast shadows or sun arc in Basic), the colours and the summary. */
  setBasic(on: boolean) {
    this.basic = on;
    this.scene?.setShadows(!on && this.els.shadowsToggle.checked);
    this.scene?.setSunVisible(!on);
    this.updateSun();
    if (this.result) this.render();
  }

  /** Label the pins for the current spots (when the setting is on). */
  private updatePins() {
    const r = this.result;
    if (!r || r.kind === 'inspect' || r.kind === 'moment' || !this.controls.get().spots) return this.clearPins();
    const date = this.timeline.get().date;
    const specs: PinSpec[] = [];
    for (const kind of ['sunniest', 'shadiest'] as const) {
      const s = this.spots[kind];
      if (s) specs.push({ kind, cell: s.cell, ...copy.spots.pin(kind, r.kind, s.value, date) });
    }
    this.pins.set(specs);
    this.placePins();
  }

  private clearPins() {
    this.pins.clear();
  }

  /** Put the pins where the visible view shows their cells. */
  private placePins() {
    const scene = this.scene;
    if (this.view === '3d' && scene && !this.els.sceneHost.hidden) this.pins.place((c) => scene.projectCell(c));
    else this.pins.place((c) => (this.els.mapCanvas.hidden ? null : this.map.projectCell(c)));
  }

  /** A pin was clicked: put the 3D cursor there and show the spot's sun month by month. */
  private pickSpot(cell: number) {
    if (this.view === '3d') this.scene?.setCursor(cell);
    void this.pick(cell);
  }

  /** "What this means": the result in a sentence or three (engine/lotSummary.ts, copy.headline). */
  private headlineText(): string {
    const r = this.result, l = this.loaded;
    if (!r || !l || r.kind === 'inspect') return '';
    const s = this.state(), h = copy.headline;
    const onSurface = s.observer === 'surface';
    const mode = r.kind;
    const sum = summarizeLot({
      mode,
      values: r.values,
      covered: this.summaryCovered(),
      positions: this.cellPositions,
      thresholds: { fullSunH: s.fullSunH, partSunH: s.partSunH },
      spots: this.spots,
    });
    if (sum.coveredShare >= MOSTLY_COVERED) return h.mostlyCovered;
    const parts: string[] = [];
    if (mode === 'moment') {
      if (this.timeline.showingMiddayForNight) parts.push(h.darkNow);
      if (r.altDeg <= 0) parts.push(h.momentNight(s.time, s.date));
      else {
        parts.push(h.moment(sum.sunShare, s.time, s.date, onSurface));
        if (sum.sunniest) parts.push(h.momentSide(sum.sunniest.side));
      }
    } else if (mode === 'shade') {
      parts.push(sum.shadiest ? h.shade(sum.shadiest.side, sum.shadiest.value, s.fromTime, s.toTime, s.shadeStart, s.shadeEnd) : h.shadeNoSun);
    } else if (sum.sunniest && sum.shadiest) {
      const cls = h.classNames[sum.medianClass];
      const period = s.preset === 'custom' ? h.customPeriod(s.start, s.end) : (h.periods[s.preset] ?? '');
      parts.push(mode === 'day' ? h.day(sum.low, sum.high, cls, s.date, onSurface) : h.season(sum.low, sum.high, cls, period, onSurface));
      parts.push(h.sides(sum.sunniest.side, sum.sunniest.value, sum.shadiest.side));
    }
    if (!onSurface && sum.coveredShare >= 0.05 && parts.length) parts.push(h.covered(sum.coveredShare));
    return parts.join(' ');
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
      ['Surfaces', this.options ? SOURCE_CHOICES.filter((c) => this.options![c]).map((c) => `${c} = ${this.options![c]!.kind}`).join(', ') || 'none' : '…'],
      ['Cells', `${s.cells.toLocaleString('en-CA')} at ${s.cellSizeM} m${s.dropped ? ` (${s.dropped} nodata dropped)` : ''}`],
      ['Window', `${s.window.width * s.window.res} × ${s.window.height * s.window.res} m, ${(100 * s.bufferNodataFrac).toFixed(1)}% nodata`],
      ['LiDAR', this.vintageText || '…'],
      ['Aerial photo', this.photo ? `${this.photo.source.id}, ${this.photo.image.width} × ${this.photo.image.height} px` : this.photoOn ? 'none' : 'off'],
      ['3D', this.scene ? `WebGL${isLowPower() ? ', low-power settings' : ''}` : this.sceneUnavailable ? 'unavailable' : '…'],
      ['Timings', Object.entries(this.timings).map(([k, v]) => `${k.replace(/Ms$/, '')} ${v} ms`).join(', ') + (this.threads > 1 ? ` (horizon on ${this.threads} threads)` : '')],
    ];
    this.els.debug.replaceChildren(
      ...rows.flatMap(([k, v]) => [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })]),
    );
  }
}
