// Worker-side builders: turn an elevation spec into DSM/DTM rasters on an analysis window.
// Each builder chooses its grid (CRS + metres per pixel); everything downstream works in that
// grid's pixels and converts to metres with `window.res`.
import { ELEVATION, HIRES } from '../config';
import { bilinear, type Raster } from '../engine/grid';
import type { CopcSpec, ElevationSpec, HrdemSpec, LidarbcSpec, SourceInfo } from '../engine/protocol';
import type { Position, Ring } from '../geo/polygon';
import { fromCrs, toCrs, type GridCrs } from '../geo/proj';
import { LruCache, memo } from './cache';
import { openImage, readWindow, tileGrid } from './cog';
import { changeMask, composeSurface, maxPool2, regionToCoarse, upsampleNearest } from './change';
import { rasterizeCopc, type CopcStats } from './copc';
import { fillHoles, median, removeSpikes } from './pointRaster';
import { regionOfBox, resampleInto } from './resample';
import { alignedWindow, bboxOf, embedWindow, fromPixel, lotWindow, toPixel, type Bbox, type PixelWindow } from './window';

export interface BuiltRasters {
  window: PixelWindow;
  dsm: Raster;
  dtm: Raster;
  /** Lot polygons in the window's CRS. */
  lot: Ring[][];
  source: SourceInfo;
  /** "Best of both": 1 where the newer survey replaced the older one. */
  changed?: Uint8Array;
}

export function projectRings(rings: Ring[][], crs: GridCrs): Ring[][] {
  return rings.map((poly) => poly.map((ring) => ring.map((p) => toCrs(crs, p))));
}

const grow = (b: Bbox, m: number): Bbox => ({ minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m });

async function openHrdem(spec: HrdemSpec) {
  const [dsmImg, dtmImg] = await Promise.all([openImage(spec.dsmUrl), openImage(spec.dtmUrl)]);
  const tile = tileGrid(dsmImg);
  if (JSON.stringify(tile) !== JSON.stringify(tileGrid(dtmImg))) throw new Error('DSM and DTM grids differ'); // docs/DEVELOPMENT.md, gotcha 6
  return { dsmImg, dtmImg, tile };
}

/** NRCan HRDEM 1 m mosaic (EPSG:3979): DSM for lot + buffer, DTM for lot + a small margin. */
export async function buildHrdem(spec: HrdemSpec, lotLonLat: Ring[][], bufferM: number, isCurrent: () => boolean): Promise<Omit<BuiltRasters, 'source'>> {
  const { dsmImg, dtmImg, tile } = await openHrdem(spec);
  const lot = projectRings(lotLonLat, tile.crs);
  const bbox = bboxOf(lot);
  const window = lotWindow(bbox, bufferM, tile);
  // Ground heights matter only on and near the lot, so read far fewer DTM tiles than DSM tiles.
  const dtmWindow = lotWindow(bbox, Math.min(ELEVATION.dtmMarginM, bufferM), tile);
  const [dsmData, dtmNear] = await Promise.all([readWindow(dsmImg, window), readWindow(dtmImg, dtmWindow)]);
  if (!isCurrent()) throw new CancelledBuild();
  return {
    window,
    lot,
    dsm: { width: window.width, height: window.height, data: dsmData },
    dtm: { width: window.width, height: window.height, data: embedWindow(window, dtmWindow, dtmNear) },
  };
}

/** The box in `crs` that contains a whole window from another CRS (its corners, projected). */
function windowBoxIn(w: PixelWindow, crs: GridCrs): Bbox {
  const corners: Position[] = [[0, 0], [w.width, 0], [0, w.height], [w.width, w.height]].map((p) => toCrs(crs, fromCrs(w.crs, fromPixel(w, p as Position))));
  return bboxOf([[corners]]);
}

/**
 * The UTM 10N analysis window for a lot at `res` metres. Edges sit on whole metres whatever the
 * pixel size, so the 0.5 m and 1 m windows of a lot cover the same ground, cell for 2 × 2 cells.
 */
export function utmWindow(lotLonLat: Ring[][], bufferM: number, res: number) {
  const lot = projectRings(lotLonLat, 'EPSG:3157');
  const bbox = bboxOf(lot);
  return { lot, bbox, window: alignedWindow(bbox, bufferM, res, 'EPSG:3157', 1) };
}

// Downloaded pieces, kept per lot so switching surfaces doesn't fetch again (see cache.ts).
type UtmBase = ReturnType<typeof utmWindow> & { dsm: Float32Array; dtm: Float32Array };
const baseCache = new LruCache<UtmBase>(4);
const copyBase = (b: UtmBase): UtmBase => ({ ...b, dsm: b.dsm.slice(), dtm: b.dtm.slice() });

/**
 * HRDEM resampled into a UTM 10N grid at `res` metres: the base that sharper sources are laid
 * over. Reads enough of the 3979 tile to cover the rotated UTM window, plus a pixel for bilinear.
 */
function hrdemOnUtm(spec: HrdemSpec, lotLonLat: Ring[][], bufferM: number, res: number, isCurrent: () => boolean): Promise<UtmBase> {
  return memo(
    baseCache,
    JSON.stringify([spec, lotLonLat, bufferM, res]),
    async () => {
      const { dsmImg, dtmImg, tile } = await openHrdem(spec);
      const w = utmWindow(lotLonLat, bufferM, res);
      const srcWindow = lotWindow(windowBoxIn(w.window, tile.crs), 2, tile);
      const dtmWindow = lotWindow(bboxOf(projectRings(lotLonLat, tile.crs)), Math.min(ELEVATION.dtmMarginM, bufferM) + 2, tile);
      const [dsmSrc, dtmSrc] = await Promise.all([readWindow(dsmImg, srcWindow), readWindow(dtmImg, dtmWindow)]);
      if (!isCurrent()) throw new CancelledBuild();
      return { ...w, dsm: resampleInto(w.window, srcWindow, dsmSrc), dtm: resampleInto(w.window, dtmWindow, dtmSrc) };
    },
    copyBase,
    isCurrent,
  );
}

/** What a sharper surface patch changed, for the debug panel. */
export interface PatchStats {
  filled: number;
  datumOffsetM: number;
  datumFrom: 'ground' | 'surface';
}

type Region = { c0: number; r0: number; c1: number; r1: number };

/**
 * Vertical datum offset of a sharper surface against HRDEM: the median of (ground samples − HRDEM
 * DTM) or, with too few ground samples, of (surface − HRDEM DSM) over `region`. Throws when absurd.
 */
export function datumOffset(window: PixelWindow, base: { dsm: Float32Array; dtm: Float32Array }, patch: Float32Array, region: Region, ground: [number, number, number][]): Pick<PatchStats, 'datumOffsetM' | 'datumFrom'> {
  const { width, height } = window;
  const dtm: Raster = { width, height, data: base.dtm };
  const groundDiffs = ground.map(([x, y, z]) => {
    const [px, py] = toPixel(window, [x, y]);
    return z - bilinear(dtm, px, py);
  });
  let datumFrom: PatchStats['datumFrom'] = 'ground';
  let offset = groundDiffs.filter((d) => d === d).length >= 50 ? median(groundDiffs) : null;
  if (offset === null) {
    datumFrom = 'surface';
    const diffs: number[] = [];
    for (let r = region.r0; r < region.r1; r += 2) for (let c = region.c0; c < region.c1; c += 2) diffs.push(patch[r * width + c]! - base.dsm[r * width + c]!);
    offset = median(diffs);
  }
  if (offset === null || Math.abs(offset) > HIRES.maxDatumOffsetM) throw new Error(`Heights don't line up with HRDEM (offset ${offset})`);
  return { datumOffsetM: offset, datumFrom };
}

/** Copy a patch's valid cells (minus the datum offset) into `into` within a region; returns the count. */
function applyPatch(width: number, into: Float32Array, patch: Float32Array, offset: number, region: Region): number {
  let filled = 0;
  for (let r = region.r0; r < region.r1; r++) {
    for (let c = region.c0; c < region.c1; c++) {
      const k = r * width + c;
      const v = patch[k]!;
      if (v === v) {
        into[k] = v - offset;
        filled++;
      }
    }
  }
  return filled;
}

function checkCoverage(window: PixelWindow, patch: Float32Array, region: Region) {
  let valid = 0;
  for (let r = region.r0; r < region.r1; r++) for (let c = region.c0; c < region.c1; c++) if (patch[r * window.width + c] === patch[r * window.width + c]) valid++;
  const total = Math.max(1, (region.r1 - region.r0) * (region.c1 - region.c0));
  if (valid / total < HIRES.minFilled) throw new Error(`The sharper data covers only ${Math.round((100 * valid) / total)}% of the area near the lot`);
}

/**
 * Lay a point-derived surface over the base DSM inside `region`, after removing its vertical datum
 * offset against HRDEM. Throws when the patch is too sparse or the offset absurd.
 */
export function patchSurface(
  window: PixelWindow,
  base: { dsm: Float32Array; dtm: Float32Array },
  patch: Float32Array,
  region: Region,
  ground: [number, number, number][],
): PatchStats {
  const d = datumOffset(window, base, patch, region, ground);
  checkCoverage(window, patch, region);
  return { filled: applyPatch(window.width, base.dsm, patch, d.datumOffsetM, region), ...d };
}

const fmtOffset = (m: number) => `${m >= 0 ? '+' : ''}${m.toFixed(2)} m`;

/** Margin around the lot for the sharper surface: the full margin, unless that reads too large an area. */
export function refineMargin(lot: Bbox): number {
  const w = lot.maxX - lot.minX, h = lot.maxY - lot.minY;
  // Largest m with (w + 2m)(h + 2m) ≤ max area: 4m² + 2(w + h)m + wh − A = 0.
  const fit = (-2 * (w + h) + Math.sqrt(4 * (w + h) ** 2 - 16 * (w * h - HIRES.copcMaxBoxM2))) / 8;
  return Math.max(HIRES.copcMinRefineM, Math.min(HIRES.copcRefineM, Number.isFinite(fit) ? Math.floor(fit) : 0));
}

/** A lot's point-cloud surface: highest return per cell in `region`, spikes removed, small holes filled (datum not yet corrected). */
interface CopcPart {
  box: Bbox;
  region: Region;
  zmax: Float32Array;
  ground: [number, number, number][];
  stats: CopcStats;
}
const copcCache = new LruCache<CopcPart>(4);

function copcPart(spec: CopcSpec, window: PixelWindow, lotBox: Bbox, isCurrent: () => boolean): Promise<CopcPart> {
  const box = grow(lotBox, refineMargin(lotBox));
  return memo(
    copcCache,
    JSON.stringify([spec.urls, window, box]),
    async () => {
      const region = regionOfBox(window, box);
      const { grid, ground, stats } = await rasterizeCopc(spec.urls, window, box, region, { maxPoints: HIRES.copcMaxPoints, targetDensity: HIRES.copcTargetDensity }, isCurrent);
      if (!isCurrent()) throw new CancelledBuild();
      removeSpikes(grid.zmax, window.width, window.height, region, HIRES.spikeRiseM);
      fillHoles(grid, region, 2);
      return { box, region, zmax: grid.zmax, ground, stats };
    },
    (p) => ({ ...p, zmax: p.zmax.slice() }),
    isCurrent,
  );
}

const copcDetail = (stats: CopcStats) =>
  `${(stats.points / 1e6).toFixed(1)} M points in ${stats.nodes} nodes${stats.failed ? ` (${stats.failed} skipped)` : ''}, ${(stats.bytes / 1e6).toFixed(1)} MB`;

/**
 * NRCan point cloud: highest return per 0.5 m cell for the lot + `HIRES.copcRefineM`, on top of
 * HRDEM resampled to the same UTM grid. The ground model stays HRDEM's.
 */
export async function buildCopc(hrdem: HrdemSpec, spec: CopcSpec, lotLonLat: Ring[][], bufferM: number, isCurrent: () => boolean): Promise<Omit<BuiltRasters, 'source'> & { detail: string }> {
  const { window, bbox } = utmWindow(lotLonLat, bufferM, HIRES.copcResM);
  const [base, part] = await Promise.all([hrdemOnUtm(hrdem, lotLonLat, bufferM, HIRES.copcResM, isCurrent), copcPart(spec, window, bbox, isCurrent)]);
  if (!isCurrent()) throw new CancelledBuild();
  const patch = patchSurface(window, base, part.zmax, part.region, part.ground);
  const detail = `${copcDetail(part.stats)}, datum ${fmtOffset(patch.datumOffsetM)} (${patch.datumFrom})`;
  return {
    window,
    lot: base.lot,
    dsm: { width: window.width, height: window.height, data: base.dsm },
    dtm: { width: window.width, height: window.height, data: base.dtm },
    detail,
  };
}

/**
 * Read one LidarBC 1 m GeoTIFF (EPSG:3157 + CGVD2013, strip-organised) for the part of `box` it
 * covers and write its valid pixels into `out` on the window's grid.
 */
async function pasteLidarbcTile(url: string, window: PixelWindow, box: Bbox, out: Float32Array): Promise<boolean> {
  const img = await openImage(url, { blockSize: HIRES.lidarbcBlockSize });
  const epsg = img.getGeoKeys()?.ProjectedCSTypeGeoKey;
  if (epsg !== 3157 && epsg !== 2955) throw new Error(`LidarBC tile in an unexpected CRS (EPSG:${epsg})`); // 2955 = NAD83(CSRS) UTM 10N too
  const [ox, oy] = img.getOrigin() as [number, number];
  const res = Math.abs(img.getResolution()[0]!);
  const minX = Math.max(box.minX, window.x0, ox), maxX = Math.min(box.maxX, window.x0 + window.width * window.res, ox + img.getWidth() * res);
  const maxY = Math.min(box.maxY, window.y0, oy), minY = Math.max(box.minY, window.y0 - window.height * window.res, oy - img.getHeight() * res);
  if (minX >= maxX || minY >= maxY) return false;
  const c0 = Math.floor((minX - ox) / res), c1 = Math.ceil((maxX - ox) / res);
  const r0 = Math.floor((oy - maxY) / res), r1 = Math.ceil((oy - minY) / res);
  const sub: PixelWindow = { crs: 'EPSG:3157', col0: c0, row0: r0, width: c1 - c0, height: r1 - r0, x0: ox + c0 * res, y0: oy - r0 * res, res };
  const data = await readWindow(img, sub);
  // Same grid spacing and (in practice) whole-metre origins, so this copies pixels exactly.
  resampleInto(window, sub, data, regionOfBox(window, { minX, minY, maxX, maxY }), out);
  return true;
}

/** A lot's LidarBC mosaic on its 1 m UTM window: DSM for the whole window (spikes removed), DEM near the lot. */
interface LidarbcPart {
  dsm: Float32Array;
  dem: Float32Array;
  nearLot: Bbox;
}
const lidarbcCache = new LruCache<LidarbcPart>(4);

function lidarbcPart(spec: LidarbcSpec, window: PixelWindow, nearLot: Bbox, isCurrent: () => boolean): Promise<LidarbcPart> {
  return memo(
    lidarbcCache,
    JSON.stringify([spec, window, nearLot]),
    async () => {
      const n = window.width * window.height;
      const dsm = new Float32Array(n).fill(NaN), dem = new Float32Array(n).fill(NaN);
      const all: Bbox = { minX: window.x0, maxX: window.x0 + window.width * window.res, minY: window.y0 - window.height * window.res, maxY: window.y0 };
      await Promise.all([...spec.dsm.map((u) => pasteLidarbcTile(u, window, all, dsm)), ...spec.dem.map((u) => pasteLidarbcTile(u, window, nearLot, dem))]);
      if (!isCurrent()) throw new CancelledBuild();
      removeSpikes(dsm, window.width, window.height, { c0: 0, r0: 0, c1: window.width, r1: window.height }, HIRES.spikeRiseM);
      return { dsm, dem, nearLot };
    },
    (p) => ({ ...p, dsm: p.dsm.slice(), dem: p.dem.slice() }),
    isCurrent,
  );
}

/** Ground samples for the datum check: a DEM's valid cells near the lot, every third one. */
function demGround(window: PixelWindow, dem: Float32Array, near: Bbox): [number, number, number][] {
  const ground: [number, number, number][] = [];
  const g = regionOfBox(window, near);
  for (let r = g.r0; r < g.r1; r += 3)
    for (let c = g.c0; c < g.c1; c += 3) {
      const z = dem[r * window.width + c]!;
      if (z === z) ground.push([...fromPixel(window, [c + 0.5, r + 0.5]), z]);
    }
  return ground;
}

/**
 * LidarBC 1 m DSM (and DEM near the lot) from a newer survey, on top of HRDEM resampled to the
 * same UTM grid (it fills any gap between survey tiles). Datum-checked against HRDEM ground.
 */
export async function buildLidarbc(hrdem: HrdemSpec, spec: LidarbcSpec, lotLonLat: Ring[][], bufferM: number, isCurrent: () => boolean): Promise<Omit<BuiltRasters, 'source'> & { detail: string }> {
  const { window, bbox } = utmWindow(lotLonLat, bufferM, 1);
  const nearLot = grow(bbox, Math.min(ELEVATION.dtmMarginM, bufferM));
  const [base, { dsm, dem }] = await Promise.all([hrdemOnUtm(hrdem, lotLonLat, bufferM, 1, isCurrent), lidarbcPart(spec, window, nearLot, isCurrent)]);
  if (!isCurrent()) throw new CancelledBuild();
  const n = window.width * window.height;
  const lotRegion = regionOfBox(window, grow(bbox, HIRES.copcRefineM));
  const d = datumOffset(window, base, dsm, lotRegion, demGround(window, dem, nearLot));
  checkCoverage(window, dsm, lotRegion);
  const full = { c0: 0, r0: 0, c1: window.width, r1: window.height };
  const filled = applyPatch(window.width, base.dsm, dsm, d.datumOffsetM, full);
  applyPatch(window.width, base.dtm, dem, d.datumOffsetM, full); // newer ground near the lot
  return {
    window,
    lot: base.lot,
    dsm: { width: window.width, height: window.height, data: base.dsm },
    dtm: { width: window.width, height: window.height, data: base.dtm },
    detail: `${spec.dsm.length} DSM + ${spec.dem.length} DEM tiles, ${Math.round((100 * filled) / n)}% of the window, datum ${fmtOffset(d.datumOffsetM)} (${d.datumFrom})`,
  };
}

/**
 * "Best of both": the point cloud at 0.5 m wherever it agrees with the newer LidarBC survey, and
 * LidarBC wherever something changed (change.ts), plus LidarBC beyond the point cloud's area and
 * its newer ground model near the lot. Each survey is datum-checked against HRDEM ground first.
 */
export async function buildMerged(
  hrdem: HrdemSpec,
  copc: CopcSpec,
  lidarbc: LidarbcSpec,
  lotLonLat: Ring[][],
  bufferM: number,
  isCurrent: () => boolean,
): Promise<Omit<BuiltRasters, 'source'> & { detail: string; changedShare: number }> {
  const fine = utmWindow(lotLonLat, bufferM, HIRES.copcResM), coarse = utmWindow(lotLonLat, bufferM, 1);
  const w05 = fine.window, w1 = coarse.window;
  const nearLot = grow(coarse.bbox, Math.min(ELEVATION.dtmMarginM, bufferM));
  const [base, old, newer] = await Promise.all([
    hrdemOnUtm(hrdem, lotLonLat, bufferM, HIRES.copcResM, isCurrent),
    copcPart(copc, w05, fine.bbox, isCurrent),
    lidarbcPart(lidarbc, w1, nearLot, isCurrent),
  ]);
  if (!isCurrent()) throw new CancelledBuild();

  const newer05 = upsampleNearest(newer.dsm, w1.width, w1.height);
  const lotRegion = regionOfBox(w05, grow(fine.bbox, HIRES.copcRefineM));
  const dOld = datumOffset(w05, base, old.zmax, old.region, old.ground);
  const dNew = datumOffset(w05, base, newer05, lotRegion, demGround(w1, newer.dem, nearLot));
  checkCoverage(w05, old.zmax, old.region);
  checkCoverage(w05, newer05, lotRegion);
  const old05 = old.zmax.map((v) => v - dOld.datumOffsetM);
  const new1 = newer.dsm.map((v) => v - dNew.datumOffsetM);

  const region1 = regionToCoarse(old.region);
  const { mask, areas } = changeMask(maxPool2(old05, w1.width, w1.height), new1, w1.width, w1.height, region1, {
    thresholdM: HIRES.changeThresholdM,
    minAreaCells: Math.round(HIRES.changeMinAreaM2 / (w1.res * w1.res)),
    growCells: Math.round(HIRES.changeGrowM / w1.res),
  });
  const { dsm, changed, changedShare } = composeSurface({ w1: w1.width, h1: w1.height, region05: old.region, old05, new1, mask1: mask, base05: base.dsm });
  // Ground near the lot from the newer survey.
  const dem05 = upsampleNearest(newer.dem, w1.width, w1.height);
  for (let k = 0; k < dem05.length; k++) if (dem05[k] === dem05[k]) base.dtm[k] = dem05[k]! - dNew.datumOffsetM;

  return {
    window: w05,
    lot: fine.lot,
    dsm: { width: w05.width, height: w05.height, data: dsm },
    dtm: { width: w05.width, height: w05.height, data: base.dtm },
    changed,
    changedShare,
    detail:
      `older: ${copcDetail(old.stats)}, datum ${fmtOffset(dOld.datumOffsetM)}; newer: ${lidarbc.dsm.length} DSM + ${lidarbc.dem.length} DEM tiles, datum ${fmtOffset(dNew.datumOffsetM)}; ` +
      `${(100 * changedShare).toFixed(1)}% changed in ${areas} area${areas === 1 ? '' : 's'}`,
  };
}

export class CancelledBuild extends Error {}

export async function buildRasters(spec: ElevationSpec, lotLonLat: Ring[][], bufferM: number, isCurrent: () => boolean): Promise<BuiltRasters> {
  switch (spec.kind) {
    case 'hrdem': {
      const r = await buildHrdem(spec.hrdem, lotLonLat, bufferM, isCurrent);
      return { ...r, source: { kind: 'hrdem', label: spec.label, year: spec.year, resM: r.window.res } };
    }
    case 'copc': {
      const { detail, ...r } = await buildCopc(spec.hrdem, spec.copc, lotLonLat, bufferM, isCurrent);
      return { ...r, source: { kind: 'copc', label: spec.label, year: spec.year, resM: r.window.res, detail } };
    }
    case 'lidarbc': {
      const { detail, ...r } = await buildLidarbc(spec.hrdem, spec.lidarbc, lotLonLat, bufferM, isCurrent);
      return { ...r, source: { kind: 'lidarbc', label: spec.label, year: spec.year, resM: r.window.res, detail } };
    }
    case 'merged': {
      const { detail, changedShare, ...r } = await buildMerged(spec.hrdem, spec.copc, spec.lidarbc, lotLonLat, bufferM, isCurrent);
      return { ...r, source: { kind: 'merged', label: spec.label, year: spec.year, oldYear: spec.oldYear, resM: r.window.res, detail, changedShare } };
    }
  }
}
