// Cell inspector: average sun-hours by month (12 bars, one series) and the selected
// day's sun/shade strip. Chart marks follow common charting practice: ≤ 24 px bars with a 4 px rounded
// top, square at the baseline, 2 px gaps; hairline solid grid; text in ink, never the data colour;
// a single series needs no legend (the title names it); a text view is always available.
import { CLASS_THRESHOLDS } from '../config';
import { copy } from '../copy';
import { formatLocal } from '../engine/sun';
import { SHADE_RGB, SUN_RGB, css } from './colors';
import { CHART_BAR } from './tokens';

export interface Bar {
  month: string;
  hours: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChartModel {
  bars: Bar[];
  yMax: number;
  ticks: number[];
  refY: number; // y of the full-sun reference line
  plot: { left: number; top: number; width: number; height: number };
}

const SVG = 'http://www.w3.org/2000/svg';

/** Bars for 12 monthly values in a width × height box (with room for axis labels). */
export function monthlyChartModel(hours: number[], width = 320, height = 150, refH = CLASS_THRESHOLDS.fullSunH): ChartModel {
  const plot = { left: 34, top: 8, width: width - 42, height: height - 30 };
  const peak = Math.max(refH, ...hours);
  const yMax = Math.max(4, Math.ceil(peak / 4) * 4);
  const band = plot.width / hours.length;
  const w = Math.min(24, band - 2); // cap thickness, leave a ≥ 2 px surface gap
  const y = (v: number) => plot.top + plot.height * (1 - v / yMax);
  const bars = hours.map((v, i) => {
    const top = y(Math.max(0, v));
    return { month: copy.inspector.months[i] ?? String(i + 1), hours: v, x: plot.left + band * i + (band - w) / 2, y: top, w, h: plot.top + plot.height - top };
  });
  return { bars, yMax, ticks: [0, yMax / 2, yMax], refY: y(refH), plot };
}

export interface StripRun {
  start: number;
  end: number;
  sunlit: boolean;
}

/** Merge consecutive samples with the same state; each sample stands for the gap to the next. */
export function stripRuns(strip: { time: number; sunlit: boolean }[]): StripRun[] {
  if (!strip.length) return [];
  const step = strip.length > 1 ? strip[1]!.time - strip[0]!.time : 600_000;
  const runs: StripRun[] = [];
  for (const s of strip) {
    const start = s.time - step / 2, end = s.time + step / 2;
    const last = runs.at(-1);
    if (last && last.sunlit === s.sunlit) last.end = end;
    else runs.push({ start, end, sunlit: s.sunlit });
  }
  return runs;
}

/** "07:10–10:40, 13:20–16:05" for the sunny runs. */
export function sunnyPeriods(runs: StripRun[]): string {
  return runs.filter((r) => r.sunlit).map((r) => `${formatLocal(r.start)}–${formatLocal(r.end)}`).join(', ');
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A column with a 4 px rounded top and a square base. */
function barPath(b: Bar): string {
  const r = Math.min(4, b.w / 2, b.h);
  const x0 = b.x, x1 = b.x + b.w, y0 = b.y, y1 = b.y + b.h;
  return `M${x0},${y1} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x1 - r} Q${x1},${y0} ${x1},${y0 + r} V${y1} Z`;
}

export interface InspectorData {
  heading: string; // e.g. "6.4 h of direct sun a day"
  details: string[]; // e.g. ["Roof or tree overhead", "Measured at 38.6 m"]
  monthlyHours: number[];
  strip: { time: number; sunlit: boolean }[];
  dateLabel: string;
  year: number;
  /** Full-sun threshold for the reference line. */
  fullSunH: number;
}

export function renderInspector(root: HTMLElement, d: InspectorData) {
  root.replaceChildren();
  root.hidden = false;
  const h = document.createElement('h3');
  h.textContent = d.heading;
  const meta = document.createElement('p');
  meta.className = 'inspector-meta';
  meta.textContent = d.details.join(' · ');

  // Monthly bars.
  const m = monthlyChartModel(d.monthlyHours, 320, 150, d.fullSunH);
  const title = document.createElement('p');
  title.className = 'chart-title';
  title.textContent = copy.inspector.monthlyTitle(d.year);
  const svg = el('svg', { viewBox: '0 0 320 150', role: 'img', 'aria-label': copy.inspector.monthlyAria(d.monthlyHours) });
  svg.classList.add('chart');
  for (const t of m.ticks) {
    const y = m.plot.top + m.plot.height * (1 - t / m.yMax);
    svg.append(el('line', { x1: m.plot.left, x2: m.plot.left + m.plot.width, y1: y, y2: y, class: 'grid' }));
    svg.append(el('text', { x: m.plot.left - 6, y: y + 4, class: 'tick', 'text-anchor': 'end' }, t === m.yMax ? `${t} h` : `${t}`));
  }
  for (const b of m.bars) {
    const g = el('g', { class: 'bar' });
    g.append(el('title', {}, copy.inspector.barTitle(b.month, b.hours)));
    g.append(el('rect', { x: b.x - 1, y: m.plot.top, width: b.w + 2, height: m.plot.height, class: 'hit' })); // hover target > mark
    if (b.h > 0.5) g.append(el('path', { d: barPath(b), fill: CHART_BAR }));
    g.append(el('text', { x: b.x + b.w / 2, y: m.plot.top + m.plot.height + 14, class: 'tick', 'text-anchor': 'middle' }, b.month.slice(0, 1)));
    svg.append(g);
  }
  svg.append(el('line', { x1: m.plot.left, x2: m.plot.left + m.plot.width, y1: m.refY, y2: m.refY, class: 'ref' }));
  // Label at the left, above the line: winter bars there are short, so it rarely sits on a bar.
  svg.append(el('text', { x: m.plot.left + 4, y: m.refY - 4, class: 'ref-label' }, copy.inspector.fullSunLine(d.fullSunH)));

  // Day strip.
  const runs = stripRuns(d.strip);
  const stripTitle = document.createElement('p');
  stripTitle.className = 'chart-title';
  stripTitle.textContent = copy.inspector.stripTitle(d.dateLabel);
  const strip = el('svg', { viewBox: '0 0 320 34', role: 'img', 'aria-label': copy.inspector.stripAria(sunnyPeriods(runs)) });
  strip.classList.add('strip');
  if (runs.length) {
    const t0 = runs[0]!.start, t1 = runs.at(-1)!.end, span = Math.max(1, t1 - t0);
    for (const r of runs) {
      const x = 4 + (312 * (r.start - t0)) / span, w = Math.max(1, (312 * (r.end - r.start)) / span - 2); // 2 px gap
      strip.append(el('rect', { x, y: 2, width: w, height: 12, rx: 2, fill: css(r.sunlit ? SUN_RGB : SHADE_RGB) }));
    }
    strip.append(el('text', { x: 4, y: 30, class: 'tick' }, formatLocal(t0)));
    strip.append(el('text', { x: 316, y: 30, class: 'tick', 'text-anchor': 'end' }, formatLocal(t1)));
  }
  const key = document.createElement('p');
  key.className = 'legend';
  for (const [rgbv, label] of [[SUN_RGB, copy.legend.sun], [SHADE_RGB, copy.legend.shade]] as const) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = css(rgbv);
    item.append(sw, label);
    key.append(item);
  }
  const periods = document.createElement('p');
  periods.className = 'inspector-meta';
  const sunny = sunnyPeriods(runs);
  periods.textContent = sunny ? copy.inspector.sunnyAt(sunny) : copy.inspector.noSun;

  // Text view of the bars.
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = copy.inspector.asText;
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th scope="col"></th><th scope="col"></th></tr></thead>';
  table.tHead!.rows[0]!.cells[0]!.textContent = copy.inspector.monthHeader;
  table.tHead!.rows[0]!.cells[1]!.textContent = copy.inspector.hoursHeader;
  const tbody = table.createTBody();
  m.bars.forEach((b) => {
    const tr = tbody.insertRow();
    tr.insertCell().textContent = b.month;
    tr.insertCell().textContent = b.hours.toFixed(1);
  });
  details.append(summary, table);

  root.append(h, meta, title, svg, stripTitle, strip, key, periods, details);
}
