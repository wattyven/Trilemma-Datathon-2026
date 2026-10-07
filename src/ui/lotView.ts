// Phase 1 debug view: the lot outline on a 2D canvas (true north up) plus its facts.
// Phase 3 replaces the canvas with the three.js scene; the info panel stays.
import { copy } from '../copy';
import type { Parcel, ParcelNotice } from '../data/parcels';
import { frameForGeometry } from '../geo/local';
import { bounds, mapGeometry, polygonsOf, type AreaGeometry, type Position } from '../geo/polygon';

export interface LotViewModel {
  address: string;
  jurisdiction: string;
  candidates: Parcel[];
  selected: number;
  point: Position; // lon/lat of the geocoded address
  notices: ParcelNotice[];
  onSelect(index: number): void;
}

export interface LotViewElements {
  section: HTMLElement;
  canvas: HTMLCanvasElement;
  heading: HTMLElement;
  facts: HTMLDListElement;
  notices: HTMLUListElement;
  switcher: HTMLFieldSetElement;
  options: HTMLElement;
}

let resizeObserver: ResizeObserver | null = null;

export function renderLot(els: LotViewElements, model: LotViewModel) {
  const parcel = model.candidates[model.selected];
  if (!parcel) return;
  els.section.hidden = false;
  els.heading.textContent = model.address;

  const facts: [string, string][] = [
    [copy.facts.jurisdiction, model.jurisdiction],
    [copy.facts.area, copy.areaM2(parcel.areaM2)],
    [copy.facts.type, parcel.parcelClass],
  ];
  if (parcel.planNumber) facts.push([copy.facts.plan, parcel.planNumber]);
  els.facts.replaceChildren(
    ...facts.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );

  els.notices.replaceChildren(
    ...model.notices.map((n) => {
      const li = document.createElement('li');
      li.textContent = copy.notices[n];
      li.dataset.notice = n;
      return li;
    }),
  );

  renderSwitcher(els, model);

  const draw = () => drawLot(els.canvas, model);
  draw();
  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(draw);
  resizeObserver.observe(els.canvas);
}

export function hideLot(els: LotViewElements) {
  resizeObserver?.disconnect();
  resizeObserver = null;
  els.section.hidden = true;
  els.canvas.dataset.state = 'empty';
}

function renderSwitcher(els: LotViewElements, model: LotViewModel) {
  if (model.candidates.length < 2) {
    els.switcher.hidden = true;
    els.options.replaceChildren();
    return;
  }
  els.switcher.hidden = false;
  els.options.replaceChildren(
    ...model.candidates.map((p, i) => {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'lot-choice';
      radio.value = String(i);
      radio.checked = i === model.selected;
      radio.addEventListener('change', () => model.onSelect(i));
      const parts = [i === 0 ? copy.switcherBest : `${copy.switcherOther} ${i + 1}`, p.parcelClass, copy.areaM2(p.areaM2)];
      if (!p.containsPoint) parts.push(copy.metresAway(p.distanceM));
      label.append(radio, ` ${parts.join(' · ')}`);
      return label;
    }),
  );
}

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

function niceLength(maxM: number): number {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  return steps.filter((s) => s <= maxM).pop() ?? 1;
}

function drawLot(canvas: HTMLCanvasElement, model: LotViewModel) {
  const parcel = model.candidates[model.selected];
  if (!parcel) return;
  const cssW = canvas.clientWidth || 480;
  const cssH = canvas.clientHeight || 360;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const ink = cssVar(canvas, '--ink', '#1f2a24');
  const muted = cssVar(canvas, '--muted', '#6b746f');
  const lotFill = cssVar(canvas, '--lot-fill', 'rgba(232, 163, 61, 0.25)');
  const lotLine = cssVar(canvas, '--lot-line', '#b5761c');

  // Frame: metres east / true north, centred on the selected lot.
  const frame = frameForGeometry(parcel.geometry);
  const project = (g: AreaGeometry) => mapGeometry(g, frame.toLocal);
  const selected = project(parcel.geometry);
  const point = frame.toLocal(model.point);
  const b = bounds(selected);
  const minX = Math.min(b.minX, point[0]), maxX = Math.max(b.maxX, point[0]);
  const minY = Math.min(b.minY, point[1]), maxY = Math.max(b.maxY, point[1]);
  const pad = 36;
  const scale = Math.min((cssW - 2 * pad) / Math.max(maxX - minX, 1), (cssH - 2 * pad) / Math.max(maxY - minY, 1));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const toPx = ([x, y]: Position): Position => [cssW / 2 + (x - cx) * scale, cssH / 2 - (y - cy) * scale];

  const tracePath = (g: AreaGeometry) => {
    ctx.beginPath();
    for (const rings of polygonsOf(g)) {
      for (const ring of rings) {
        ring.forEach((p, i) => {
          const [px, py] = toPx(p);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
      }
    }
  };

  // Other candidates, dashed and quiet.
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = muted;
  ctx.lineWidth = 1;
  model.candidates.forEach((c, i) => {
    if (i === model.selected) return;
    tracePath(project(c.geometry));
    ctx.stroke();
  });
  ctx.setLineDash([]);

  // Selected lot.
  tracePath(selected);
  ctx.fillStyle = lotFill;
  ctx.fill('evenodd');
  ctx.strokeStyle = lotLine;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Address point.
  const [px, py] = toPx(point);
  ctx.beginPath();
  ctx.arc(px, py, 4, 0, Math.PI * 2);
  ctx.fillStyle = ink;
  ctx.fill();

  // North arrow (true north: the frame's +y axis).
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.5;
  const nx = cssW - 22, ny = 18;
  ctx.beginPath();
  ctx.moveTo(nx, ny);
  ctx.lineTo(nx - 6, ny + 14);
  ctx.lineTo(nx, ny + 10);
  ctx.lineTo(nx + 6, ny + 14);
  ctx.closePath();
  ctx.fill();
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', nx, ny + 28);

  // Scale bar.
  const barM = niceLength((cssW * 0.3) / scale);
  const barPx = barM * scale;
  const sx = 14, sy = cssH - 14;
  ctx.beginPath();
  ctx.moveTo(sx, sy - 4);
  ctx.lineTo(sx, sy);
  ctx.lineTo(sx + barPx, sy);
  ctx.lineTo(sx + barPx, sy - 4);
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(`${barM} m`, sx + barPx + 6, sy);

  canvas.dataset.state = 'lot';
}
