// The lot canvas: the Phase 1 outline, and once elevation is in, the Phase 2 debug heatmap
// (hillshaded DSM + per-cell results) drawn through the grid → local affine so TRUE north is up.
// Phase 3 replaces this with the three.js scene.
import type { PixelWindow } from '../elevation/window';
import { applyAffine, invertAffine, type GridAffine } from '../geo/gridAffine';
import { frameForGeometry, type LocalFrame } from '../geo/local';
import { bounds, mapGeometry, polygonsOf, type AreaGeometry, type Position } from '../geo/polygon';
import { WATER_RGB } from './colors';
import { buildCellIndex, cellAtPixel, layerRgba, paintCellsRgba, type Layer } from './cellPaint';
import { FITTED, MAP_ZOOM, panBy, zoomAbout, type FitView, type ZoomState } from './mapZoom';

export { HOURS_SCALE_MAX, type Layer, type LayerKind } from './cellPaint';

export interface OutlineModel {
  candidates: AreaGeometry[]; // lon/lat
  selected: number;
  point: Position; // lon/lat
}

export interface AnalysisModel {
  window: PixelWindow;
  dsm: Float32Array;
  gammaDeg: number;
  px: Float32Array;
  py: Float32Array;
  covered: Uint8Array;
  step: number;
  affine: GridAffine;
}

export interface CanvasHandlers {
  onHover(cell: number | null): void;
  onPick(cell: number): void;
}

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

function niceLength(maxM: number): number {
  return [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500].filter((s) => s <= maxM).pop() ?? 1;
}

/** Hillshade from true north-west at 45°, in grid space (light azimuth rotated by γ). */
function hillshade(w: PixelWindow, dsm: Float32Array, gammaDeg: number): ImageData {
  const W = w.width, H = w.height;
  const img = new ImageData(W, H);
  const az = ((315 + gammaDeg) * Math.PI) / 180, alt = Math.PI / 4;
  const lx = Math.sin(az) * Math.cos(alt), ln = Math.cos(az) * Math.cos(alt), lz = Math.sin(alt);
  const at = (x: number, y: number) => dsm[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))]!;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const z = dsm[y * W + x]!;
      if (Number.isNaN(z)) {
        img.data.set([...WATER_RGB, 255], o);
        continue;
      }
      const l = at(x - 1, y), r = at(x + 1, y), u = at(x, y - 1), d = at(x, y + 1);
      const dzdx = Number.isNaN(l) || Number.isNaN(r) ? 0 : (r - l) / (2 * w.res);
      const dzdn = Number.isNaN(u) || Number.isNaN(d) ? 0 : (u - d) / (2 * w.res); // +north is −py
      const s = Math.max(0, (-dzdx * lx - dzdn * ln + lz) / Math.hypot(dzdx, dzdn, 1));
      const g = 70 + 170 * s;
      img.data.set([g, g, g * 0.97, 255], o);
    }
  }
  return img;
}

export interface MapPhoto {
  image: HTMLCanvasElement;
  /** Photo pixel → local metres (see imagery/georef.ts). */
  affine: GridAffine;
}

export class LotCanvas {
  private outline: OutlineModel | null = null;
  private frameCache: LocalFrame | null = null;
  private analysis: AnalysisModel | null = null;
  private layer: Layer | null = null;
  private background: HTMLCanvasElement | null = null;
  private cellsLayer: HTMLCanvasElement | null = null;
  private cellIndex: Int32Array | null = null;
  private photo: MapPhoto | null = null;
  private changeMask: HTMLCanvasElement | null = null;
  /** The lot's cells in shade at the slider's time (the 3D view casts real shadows). */
  private shadowLayer: HTMLCanvasElement | null = null;
  private layerOpacity = 1;
  private view = { cx: 0, cy: 0, s: 1, w: 0, h: 0 };
  /** The visitor's zoom and pan, over the view that fits the lot (`fit`). */
  private zoom: ZoomState = FITTED;
  private fit: FitView = { cx: 0, cy: 0, s: 1 };
  private pointers = new Map<number, Position>();
  private pinch: { dist: number; zoom: ZoomState } | null = null;
  private dragged = false;
  private drawQueued = false;
  private ro: ResizeObserver;
  /** Called after every redraw, so the pins on the view can follow. */
  onDraw: () => void = () => {};
  /** Whether a click on a spot picks it (off in Basic). */
  pickable = true;
  /** The map's own north arrow; off while the view's compass is showing. */
  northArrow = true;

  constructor(private canvas: HTMLCanvasElement, private handlers: CanvasHandlers) {
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(canvas);
    canvas.addEventListener('mousemove', (ev) => this.handlers.onHover(this.cellAt(ev)));
    canvas.addEventListener('mouseleave', () => this.handlers.onHover(null));
    canvas.addEventListener('click', (ev) => {
      if (this.dragged) return void (this.dragged = false); // the end of a drag, not a click
      if (!this.pickable) return;
      const c = this.cellAt(ev);
      if (c !== null) this.handlers.onPick(c);
    });
    // Zoom: the wheel (and a trackpad pinch) towards the pointer, two fingers on a touch screen; drag to move once closer in.
    canvas.addEventListener(
      'wheel',
      (ev) => {
        const [X, Y] = this.at(ev);
        if (this.zoomBy(Math.exp(-ev.deltaY * (ev.deltaMode ? 0.05 : 0.002)), X, Y)) ev.preventDefault(); // at a limit, the page scrolls
      },
      { passive: false },
    );
    canvas.addEventListener('pointerdown', (ev) => {
      if (!this.outline || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
      this.pointers.set(ev.pointerId, this.at(ev));
      this.dragged = false;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()] as [Position, Position];
        this.pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: this.zoom };
      }
      if (this.pointers.size === 2 || this.zoom.zoom > 1) canvas.setPointerCapture(ev.pointerId);
    });
    canvas.addEventListener('pointermove', (ev) => {
      const last = this.pointers.get(ev.pointerId);
      if (!last) return;
      const now = this.at(ev);
      this.pointers.set(ev.pointerId, now);
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()] as [Position, Position];
        const mid: Position = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const factor = Math.hypot(a[0] - b[0], a[1] - b[1]) / Math.max(this.pinch.dist, 1);
        this.zoom = this.pinch.zoom;
        this.zoomBy(factor, mid[0], mid[1]);
        this.dragged = true;
      } else if (this.pointers.size === 1 && this.zoom.zoom > 1) {
        const dX = now[0] - last[0], dY = now[1] - last[1];
        if (!this.dragged && Math.hypot(dX, dY) < 1) return;
        this.zoom = panBy(this.zoom, dX, dY, this.fit, this.view.w, this.view.h);
        this.dragged = true;
        this.requestDraw();
      }
    });
    const lift = (ev: PointerEvent) => {
      this.pointers.delete(ev.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
    };
    canvas.addEventListener('pointerup', lift);
    canvas.addEventListener('pointercancel', lift);
  }

  /** A pointer's position on the canvas, in CSS pixels. */
  private at(ev: MouseEvent): Position {
    const r = this.canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  /** Zoom by `factor` about a canvas point (the middle when left out); false if already at the limit. */
  zoomBy(factor: number, X = this.view.w / 2, Y = this.view.h / 2): boolean {
    if (!this.outline || !this.view.w) return false;
    const next = zoomAbout(this.zoom, factor, X, Y, this.fit, this.view.w, this.view.h);
    if (next.zoom === this.zoom.zoom && next.pan[0] === this.zoom.pan[0] && next.pan[1] === this.zoom.pan[1]) return false;
    this.zoom = next;
    this.requestDraw();
    return true;
  }

  zoomIn() {
    this.zoomBy(MAP_ZOOM.step);
  }

  zoomOut() {
    this.zoomBy(1 / MAP_ZOOM.step);
  }

  /** Back to the whole lot. */
  resetView() {
    this.zoom = FITTED;
    this.requestDraw();
  }

  /** One redraw per frame while zooming or dragging. */
  private requestDraw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  /** The local frame (x east, y true north) centred on the selected lot. */
  get frame(): LocalFrame {
    if (!this.frameCache) throw new Error('No lot drawn yet');
    return this.frameCache;
  }

  /** Forget the current lot (a new search started). */
  clear() {
    this.outline = null;
    this.frameCache = null;
    this.setAnalysis(null);
    this.canvas.dataset.state = 'empty';
  }

  setOutline(model: OutlineModel) {
    const sel = model.candidates[model.selected];
    if (!sel) return;
    this.outline = model;
    this.zoom = FITTED; // a new lot starts whole
    this.frameCache = frameForGeometry(sel);
    this.setAnalysis(null);
  }

  setAnalysis(model: AnalysisModel | null) {
    this.analysis = model;
    this.layer = null;
    this.cellsLayer = null;
    this.shadowLayer = null;
    this.background = null;
    this.cellIndex = null;
    if (model) {
      const bg = document.createElement('canvas');
      bg.width = model.window.width;
      bg.height = model.window.height;
      bg.getContext('2d')!.putImageData(hillshade(model.window, model.dsm, model.gammaDeg), 0, 0);
      this.background = bg;
      this.cellIndex = this.buildIndex(model);
    }
    this.draw();
  }

  /** An aerial photo under the results (null: the shaded-relief map). */
  setPhoto(photo: MapPhoto | null) {
    this.photo = photo;
    this.draw();
  }

  /** A window-sized translucent hatch drawn over the relief or photo, under the results. */
  setChangeMask(image: HTMLCanvasElement | null) {
    this.changeMask = image;
    this.draw();
  }

  setLayerOpacity(opacity: number) {
    this.layerOpacity = opacity;
    this.draw();
  }

  setLayer(layer: Layer | null) {
    this.layer = layer;
    this.cellsLayer = layer && this.analysis ? this.paintCells(this.analysis, layer) : null;
    this.draw();
  }

  /**
   * Shadows at one moment: `sun` is 1 for each cell in direct sun, 0 in shade (a moment result).
   * The shaded cells are darkened over the colours; null takes them away.
   */
  setShadows(sun: Uint8Array | null, label = '') {
    const m = this.analysis;
    this.shadowLayer = null;
    if (sun && m && sun.length === m.px.length) {
      const img = new ImageData(paintCellsRgba(this.grid(m), (i) => (sun[i] ? null : { rgb: [10, 16, 24], alpha: 150 }), false), m.window.width, m.window.height);
      const c = document.createElement('canvas');
      c.width = m.window.width;
      c.height = m.window.height;
      c.getContext('2d')!.putImageData(img, 0, 0);
      this.shadowLayer = c;
    }
    this.canvas.dataset.shadows = this.shadowLayer ? label : '';
    this.requestDraw();
  }

  private grid(m: AnalysisModel) {
    return { width: m.window.width, height: m.window.height, px: m.px, py: m.py, covered: m.covered, step: m.step };
  }

  private buildIndex(m: AnalysisModel): Int32Array {
    return buildCellIndex(this.grid(m));
  }

  private paintCells(m: AnalysisModel, layer: Layer): HTMLCanvasElement {
    const img = new ImageData(layerRgba(this.grid(m), layer), m.window.width, m.window.height);
    const c = document.createElement('canvas');
    c.width = m.window.width;
    c.height = m.window.height;
    c.getContext('2d')!.putImageData(img, 0, 0);
    return c;
  }

  /** Where a cell's centre appears on the canvas, in CSS pixels; null without a result grid or off the canvas. */
  projectCell(cell: number): { x: number; y: number } | null {
    const m = this.analysis;
    if (!m || cell < 0 || cell >= m.px.length || !this.view.w) return null;
    const [x, y] = applyAffine(m.affine, [m.px[cell]!, m.py[cell]!]);
    const { cx, cy, s, w, h } = this.view;
    const X = w / 2 + (x - cx) * s, Y = h / 2 - (y - cy) * s;
    return X >= 0 && Y >= 0 && X <= w && Y <= h ? { x: X, y: Y } : null;
  }

  private cellAt(ev: MouseEvent): number | null {
    const m = this.analysis;
    if (!m || !this.cellIndex || !this.frameCache) return null;
    const rect = this.canvas.getBoundingClientRect();
    const X = ev.clientX - rect.left, Y = ev.clientY - rect.top;
    const { cx, cy, s, w, h } = this.view;
    const local: Position = [cx + (X - w / 2) / s, cy - (Y - h / 2) / s];
    const [px, py] = invertAffine(m.affine, local);
    return cellAtPixel(this.grid(m), this.cellIndex, px, py);
  }

  draw() {
    const canvas = this.canvas;
    const o = this.outline;
    if (!o || !this.frameCache) return;
    const frame = this.frameCache;
    const cssW = canvas.clientWidth || 480, cssH = canvas.clientHeight || 360;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
    if (canvas.width !== W) canvas.width = W; // resizing clears and reallocates: only when it changes
    if (canvas.height !== H) canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const ink = cssVar(canvas, '--ink', '#1f2a24');
    const muted = cssVar(canvas, '--muted', '#6b746f');
    const lotLine = cssVar(canvas, '--lot-line', '#b5761c');

    const project = (g: AreaGeometry) => mapGeometry(g, frame.toLocal);
    const selected = project(o.candidates[o.selected]!);
    const point = frame.toLocal(o.point);
    const b = bounds(selected);
    const margin = this.analysis ? 15 : 0;
    const minX = Math.min(b.minX, point[0]) - margin, maxX = Math.max(b.maxX, point[0]) + margin;
    const minY = Math.min(b.minY, point[1]) - margin, maxY = Math.max(b.maxY, point[1]) + margin;
    const pad = 36;
    this.fit = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, s: Math.min((cssW - 2 * pad) / Math.max(maxX - minX, 1), (cssH - 2 * pad) / Math.max(maxY - minY, 1)) };
    this.zoom = zoomAbout(this.zoom, 1, cssW / 2, cssH / 2, this.fit, cssW, cssH); // re-clamped to this size
    const s = this.fit.s * this.zoom.zoom, cx = this.fit.cx + this.zoom.pan[0], cy = this.fit.cy + this.zoom.pan[1];
    this.view = { cx, cy, s, w: cssW, h: cssH };
    canvas.dataset.zoom = this.zoom.zoom.toFixed(2);
    canvas.toggleAttribute('data-zoomed', this.zoom.zoom > 1);
    canvas.style.touchAction = this.zoom.zoom > 1 ? 'none' : 'pan-y'; // closer in, one finger moves the map; otherwise the page
    const toPx = ([x, y]: Position): Position => [cssW / 2 + (x - cx) * s, cssH / 2 - (y - cy) * s];

    // Rasters: their pixel space → canvas, via an affine into local metres.
    const withAffine = (a: GridAffine, paint: () => void) => {
      ctx.save();
      ctx.setTransform(
        dpr * a.col[0] * s, -dpr * a.col[1] * s,
        dpr * a.row[0] * s, -dpr * a.row[1] * s,
        dpr * (cssW / 2 + (a.origin[0] - cx) * s), dpr * (cssH / 2 - (a.origin[1] - cy) * s),
      );
      paint();
      ctx.restore();
    };
    const m = this.analysis;
    if (m && this.background) {
      withAffine(m.affine, () => {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.background!, 0, 0);
      });
      const photo = this.photo;
      if (photo) withAffine(photo.affine, () => ctx.drawImage(photo.image, 0, 0));
      if (this.changeMask)
        withAffine(m.affine, () => {
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(this.changeMask!, 0, 0);
        });
      if (this.cellsLayer)
        withAffine(m.affine, () => {
          ctx.imageSmoothingEnabled = false;
          ctx.globalAlpha = this.layerOpacity;
          ctx.drawImage(this.cellsLayer!, 0, 0);
        });
      if (this.shadowLayer)
        withAffine(m.affine, () => {
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(this.shadowLayer!, 0, 0);
        });
    }

    const tracePath = (g: AreaGeometry) => {
      ctx.beginPath();
      for (const rings of polygonsOf(g)) {
        for (const ring of rings) {
          ring.forEach((p, i) => {
            const [qx, qy] = toPx(p);
            if (i === 0) ctx.moveTo(qx, qy);
            else ctx.lineTo(qx, qy);
          });
          ctx.closePath();
        }
      }
    };

    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = muted;
    ctx.lineWidth = 1;
    o.candidates.forEach((c, i) => {
      if (i === o.selected) return;
      tracePath(project(c));
      ctx.stroke();
    });
    ctx.setLineDash([]);

    tracePath(selected);
    if (!this.layer) {
      ctx.fillStyle = cssVar(canvas, '--lot-fill', 'rgba(232, 163, 61, 0.25)');
      ctx.fill('evenodd');
    }
    ctx.strokeStyle = this.layer ? '#ffffff' : lotLine;
    ctx.lineWidth = this.layer ? 2.5 : 2;
    ctx.stroke();
    if (this.layer) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // The address point helps while choosing a lot; with results it would read as a third pin.
    if (!this.layer) {
      const [px, py] = toPx(point);
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = ink;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (this.northArrow) drawNorthArrow(ctx, cssW - 22, 18, ink);
    drawScaleBar(ctx, cssH, s, cssW, ink);
    canvas.dataset.state = this.layer ? 'result' : this.analysis ? 'elevation' : 'lot';
    this.onDraw();
  }
}

function drawNorthArrow(ctx: CanvasRenderingContext2D, x: number, y: number, ink: string) {
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - 6, y + 14);
  ctx.lineTo(x, y + 10);
  ctx.lineTo(x + 6, y + 14);
  ctx.closePath();
  ctx.fill();
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', x, y + 28);
}

function drawScaleBar(ctx: CanvasRenderingContext2D, cssH: number, s: number, cssW: number, ink: string) {
  const barM = niceLength((cssW * 0.3) / s);
  const barPx = barM * s;
  const sx = 14, sy = cssH - 14;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(sx, sy - 4);
  ctx.lineTo(sx, sy);
  ctx.lineTo(sx + barPx, sy);
  ctx.lineTo(sx + barPx, sy - 4);
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.textAlign = 'left';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(`${barM} m`, sx + barPx + 6, sy);
}
