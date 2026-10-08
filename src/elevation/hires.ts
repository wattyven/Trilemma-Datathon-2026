// Which sharper elevation source can refine a lot's first (HRDEM) result. Main thread; the file
// index (hires-index.json, from spike/12-hires-index.ts) is loaded only when a lot is analysed.
import { ELEVATION, HIRES, LIDARBC_PROXY } from '../config';
import type { CopcSpec, ElevationSpec, HrdemSpec, LidarbcSpec } from '../engine/protocol';
import type { Position, Ring } from '../geo/polygon';
import { ringSignedArea } from '../geo/polygon';
import { toCrs } from '../geo/proj';
import { bcgsTilesInBox } from './bcgs';
import { vintageAt } from './vintage';
import type { Bbox } from './window';

export interface HiresIndex {
  copc: {
    base: string;
    projects: string[];
    /** BCGS id → [project, file tail after "bc_<id>", year, MB], newest first. */
    tiles: Record<string, [number, string, number, number][]>;
    /** "E5180_N54470" (1 km UTM tile, SW corner / 100 m) → [project, template, year, MB]. */
    utm: Record<string, [number, number, number, number][]>;
    templates: string[];
  };
  lidarbc: { base: string; tiles: Record<string, [number, string, number][]> };
}

let indexPromise: Promise<HiresIndex> | null = null;
export const loadHiresIndex = () => (indexPromise ??= import('./hires-index.json').then((m) => m.default as unknown as HiresIndex));

export interface CopcChoice {
  copc: CopcSpec;
  /** e.g. "Lower Mainland 2016". */
  project: string;
  year: number;
}

/** Survey year: the project folder's year (file names carry processing dates), else the file's. */
function projectYear(prefix: string, fileYear: number): number {
  return Number(/_(\d{4})\/$/.exec(prefix)?.[1] ?? fileYear);
}

export function projectLabel(prefix: string): string {
  const name = prefix.split('/').filter(Boolean).at(-1) ?? prefix;
  if (/^FHIMP/.test(name)) return `Fraser Valley (FHIMP) ${projectYear(prefix, 0)}`;
  return name.replace(/_/g, ' ');
}

const lonLatBox = (polys: Ring[][]): Bbox => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rings of polys)
    for (const [x, y] of rings[0] ?? []) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  return { minX, minY, maxX, maxY };
};

/** Lot area in m² (outer rings, UTM). */
export function lotAreaM2(polys: Ring[][]): number {
  let a = 0;
  for (const rings of polys) if (rings[0]) a += Math.abs(ringSignedArea(rings[0].map((p) => toCrs('EPSG:3157', p))));
  return a;
}

/** 1 km UTM tile keys touching a UTM box. */
function utmKeys(b: Bbox): string[] {
  const keys: string[] = [];
  for (let e = Math.floor(b.minX / 1000); e <= Math.floor(b.maxX / 1000); e++)
    for (let n = Math.floor(b.minY / 1000); n <= Math.floor(b.maxY / 1000); n++) keys.push(`E${String(e * 10).padStart(4, '0')}_N${String(n * 10).padStart(5, '0')}`);
  return keys;
}

function utmBox(polys: Ring[][], marginM: number): Bbox {
  const pts: Position[] = polys.flatMap((rings) => (rings[0] ?? []).map((p) => toCrs('EPSG:3157', p)));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs) - marginM, minY: Math.min(...ys) - marginM, maxX: Math.max(...xs) + marginM, maxY: Math.max(...ys) + marginM };
}

function degBox(b: Bbox, marginM: number) {
  const lat = (b.minY + b.maxY) / 2;
  const dLat = marginM / 111_320, dLon = marginM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { south: b.minY - dLat, north: b.maxY + dLat, west: b.minX - dLon, east: b.maxX + dLon };
}

/**
 * The newest point-cloud survey that covers every tile under the lot itself, no older than
 * `minYear` (the HRDEM survey at the lot: an older cloud would be a step back in time). Files for
 * the margin around the lot are added when that survey has them (none over open water).
 */
export function selectCopc(index: HiresIndex, lotLonLat: Ring[][], minYear: number | null): CopcChoice | null {
  const { copc } = index;
  const lotDeg = lonLatBox(lotLonLat);
  // project index → { required tiles found, urls }
  const found = new Map<number, { required: Set<string>; urls: Set<string>; year: number }>();
  const add = (pi: number, tile: string, url: string, year: number, required: boolean) => {
    const f = found.get(pi) ?? { required: new Set<string>(), urls: new Set<string>(), year };
    if (required) f.required.add(tile);
    f.urls.add(url);
    f.year = Math.max(f.year, year);
    found.set(pi, f);
  };

  // BCGS-named files. A lot touches one to four tiles; the margin can add a few more.
  const lotTiles = new Set(bcgsTilesInBox(degBox(lotDeg, 1)));
  for (const id of new Set([...lotTiles, ...bcgsTilesInBox(degBox(lotDeg, HIRES.copcRefineM))]))
    for (const [pi, tail, year] of copc.tiles[id] ?? []) add(pi, id, `${copc.base}${copc.projects[pi]}bc_${id}${tail}`, projectYear(copc.projects[pi]!, year), lotTiles.has(id));
  // 1 km UTM files (FHIMP 2023, Lower Mainland 2019/2020).
  const lotUtm = new Set(utmKeys(utmBox(lotLonLat, 1)));
  for (const key of new Set([...lotUtm, ...utmKeys(utmBox(lotLonLat, HIRES.copcRefineM))]))
    for (const [pi, ti, year] of copc.utm[key] ?? []) add(pi, key, `${copc.base}${copc.projects[pi]}${copc.templates[ti]!.replace('{EN}', key)}`, projectYear(copc.projects[pi]!, year), lotUtm.has(key));

  let best: CopcChoice | null = null;
  for (const [pi, f] of found) {
    const prefix = copc.projects[pi]!;
    // Every tile under the lot must come from this survey: BCGS-named surveys need all lot BCGS tiles, UTM ones all lot UTM tiles.
    const usesUtm = [...f.urls].some((u) => u.includes('_1km_'));
    if (f.required.size < (usesUtm ? lotUtm.size : lotTiles.size)) continue;
    if (minYear !== null && f.year < minYear) continue;
    if (!best || f.year > best.year) best = { copc: { urls: [...f.urls].sort() }, project: projectLabel(prefix), year: f.year };
  }
  return best;
}

export interface LidarbcChoice {
  lidarbc: LidarbcSpec;
  year: number;
}

/**
 * LidarBC rasters for a lot: the newest survey year that has every tile under the lot, newer than
 * `afterYear`. DSMs for every tile the analysis window touches (from that year; HRDEM fills the
 * rest), DEMs for the tiles near the lot. URLs go through `proxy`.
 */
export function selectLidarbc(index: HiresIndex, lotLonLat: Ring[][], afterYear: number, proxy: string, bufferM: number = ELEVATION.bufferM): LidarbcChoice | null {
  const { tiles, base } = index.lidarbc;
  const lotDeg = lonLatBox(lotLonLat);
  const lotTiles = bcgsTilesInBox(degBox(lotDeg, 1));
  const years = lotTiles.map((id) => new Set((tiles[id] ?? []).map((e) => e[0])));
  const candidates = [...(years[0] ?? [])].filter((y) => y > afterYear && years.every((ys) => ys.has(y))).sort((a, b) => b - a);
  const year = candidates[0];
  if (year === undefined) return null;
  const path = new URL(base).pathname; // /gdwuts/092/092g/
  const url = (id: string, kind: 'dsm' | 'dem') => {
    const e = tiles[id]?.find((x) => x[0] === year);
    if (!e || (kind === 'dem' && !e[2])) return null;
    return `${proxy}${path}${year}/${kind}/bc_${id}_xli1m_utm10_${e[1]}${kind === 'dsm' ? '_dsm' : ''}.tif`;
  };
  const dsm = bcgsTilesInBox(degBox(lotDeg, bufferM + 10)).map((id) => url(id, 'dsm')).filter((u): u is string => !!u);
  const dem = bcgsTilesInBox(degBox(lotDeg, ELEVATION.dtmMarginM)).map((id) => url(id, 'dem')).filter((u): u is string => !!u);
  return { lidarbc: { dsm, dem }, year };
}

/** Debug override for which surface to use (URL `elev=`); `auto` picks the best available. */
export type SourcePreference = 'auto' | 'hrdem' | 'copc' | 'lidarbc';

/**
 * The sharper surface to load after the first HRDEM result, or null to keep HRDEM. Newer data
 * wins: LidarBC (through the proxy, when configured) if it's newer than both the HRDEM survey and
 * the best point cloud; else the point cloud, if it's no older than the HRDEM survey.
 */
export async function refinementFor(hrdem: HrdemSpec, lotLonLat: Ring[][], lonLat: Position, pref: SourcePreference = 'auto', proxy: string = LIDARBC_PROXY): Promise<ElevationSpec | null> {
  if (pref === 'hrdem' || lotAreaM2(lotLonLat) > HIRES.copcMaxLotM2) return null;
  const index = await loadHiresIndex();
  const vintage = vintageAt(lonLat);
  const hrdemYear = vintage ? Number(vintage.date.slice(0, 4)) : null;
  const copc = pref === 'lidarbc' ? null : selectCopc(index, lotLonLat, pref === 'copc' ? null : hrdemYear);
  if (proxy && pref !== 'copc') {
    const after = pref === 'lidarbc' ? 0 : Math.max(hrdemYear ?? 0, copc?.year ?? 0);
    const lb = selectLidarbc(index, lotLonLat, after, proxy);
    if (lb) return { kind: 'lidarbc', hrdem, lidarbc: lb.lidarbc, label: `LidarBC ${lb.year}`, year: String(lb.year) };
  }
  if (!copc) return null;
  return { kind: 'copc', hrdem, copc: copc.copc, label: copc.project, year: String(copc.year) };
}
