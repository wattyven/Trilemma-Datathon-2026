// Worker-side builders: turn an elevation spec into DSM/DTM rasters on an analysis window.
// Each builder chooses its grid (CRS + metres per pixel); everything downstream works in that
// grid's pixels and converts to metres with `window.res`.
import { ELEVATION, HIRES } from '../config';
import { bilinear, type Raster } from '../engine/grid';
import type { CopcSpec, ElevationSpec, HrdemSpec, LidarbcSpec, SourceInfo } from '../engine/protocol';
import type { Position, Ring } from '../geo/polygon';
import { fromCrs, toCrs, type GridCrs } from '../geo/proj';
import { openImage, readWindow, tileGrid } from './cog';
import { rasterizeCopc } from './copc';
import { fillHoles, median } from './pointRaster';
import { regionOfBox, resampleInto } from './resample';
import { alignedWindow, bboxOf, embedWindow, fromPixel, lotWindow, toPixel, type Bbox, type PixelWindow } from './window';

export interface BuiltRasters {
  window: PixelWindow;
  dsm: Raster;
  dtm: Raster;
  /** Lot polygons in the window's CRS. */
  lot: Ring[][];
  source: SourceInfo;
}

export function projectRings(rings: Ring[][], crs: GridCrs): Ring[][] {
  return rings.map((poly) => poly.map((ring) => ring.map((p) => toCrs(crs, p))));
}

const grow = (b: Bbox, m: number): Bbox => ({ minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m });

async function openHrdem(spec: HrdemSpec) {
  const [dsmImg, dtmImg] = await Promise.all([openImage(spec.dsmUrl), openImage(spec.dtmUrl)]);
  const tile = tileGrid(dsmImg);
  if (JSON.stringify(tile) !== JSON.stringify(tileGrid(dtmImg))) throw new Error('DSM and DTM grids differ'); // gotcha #6
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
 * HRDEM resampled into a UTM 10N grid at `res` metres: the base that sharper sources are laid
 * over. Reads enough of the 3979 tile to cover the rotated UTM window, plus a pixel for bilinear.
 */
async function hrdemOnUtm(spec: HrdemSpec, lotLonLat: Ring[][], bufferM: number, res: number, isCurrent: () => boolean) {
  const { dsmImg, dtmImg, tile } = await openHrdem(spec);
  const lot = projectRings(lotLonLat, 'EPSG:3157');
  const bbox = bboxOf(lot);
  const window = alignedWindow(bbox, bufferM, res, 'EPSG:3157');
  const srcWindow = lotWindow(windowBoxIn(window, tile.crs), 2, tile);
  const dtmWindow = lotWindow(bboxOf(projectRings(lotLonLat, tile.crs)), Math.min(ELEVATION.dtmMarginM, bufferM) + 2, tile);
  const [dsmSrc, dtmSrc] = await Promise.all([readWindow(dsmImg, srcWindow), readWindow(dtmImg, dtmWindow)]);
  if (!isCurrent()) throw new CancelledBuild();
  return {
    window,
    lot,
    bbox,
    dsm: resampleInto(window, srcWindow, dsmSrc),
    dtm: resampleInto(window, dtmWindow, dtmSrc),
  };
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

/**
 * NRCan point cloud: highest return per 0.5 m cell for the lot + `HIRES.copcRefineM`, on top of
 * HRDEM resampled to the same UTM grid. The ground model stays HRDEM's.
 */
export async function buildCopc(hrdem: HrdemSpec, spec: CopcSpec, lotLonLat: Ring[][], bufferM: number, isCurrent: () => boolean): Promise<Omit<BuiltRasters, 'source'> & { detail: string }> {
  const base = await hrdemOnUtm(hrdem, lotLonLat, bufferM, HIRES.copcResM, isCurrent);
  const { window } = base;
  const box = grow(base.bbox, refineMargin(base.bbox));
  const region = regionOfBox(window, box);
  const { grid, ground, stats } = await rasterizeCopc(spec.urls, window, box, region, { maxPoints: HIRES.copcMaxPoints, targetDensity: HIRES.copcTargetDensity }, isCurrent);
  if (!isCurrent()) throw new CancelledBuild();
  fillHoles(grid, region, 2);
  const patch = patchSurface(window, base, grid.zmax, region, ground);
  const detail = `${(stats.points / 1e6).toFixed(1)} M points in ${stats.nodes} nodes${stats.failed ? ` (${stats.failed} skipped)` : ''}, ${(stats.bytes / 1e6).toFixed(1)} MB, datum ${fmtOffset(patch.datumOffsetM)} (${patch.datumFrom})`;
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

/**
 * LidarBC 1 m DSM (and DEM near the lot) from a newer survey, on top of HRDEM resampled to the
 * same UTM grid (it fills any gap between survey tiles). Datum-checked against HRDEM ground.
 */
export async function buildLidarbc(hrdem: HrdemSpec, spec: LidarbcSpec, lotLonLat: Ring[][], bufferM: number, isCurrent: () => boolean): Promise<Omit<BuiltRasters, 'source'> & { detail: string }> {
  const base = await hrdemOnUtm(hrdem, lotLonLat, bufferM, 1, isCurrent);
  const { window } = base;
  const n = window.width * window.height;
  const dsm = new Float32Array(n).fill(NaN), dem = new Float32Array(n).fill(NaN);
  const all: Bbox = { minX: window.x0, maxX: window.x0 + window.width * window.res, minY: window.y0 - window.height * window.res, maxY: window.y0 };
  const nearLot = grow(base.bbox, Math.min(ELEVATION.dtmMarginM, bufferM));
  await Promise.all([...spec.dsm.map((u) => pasteLidarbcTile(u, window, all, dsm)), ...spec.dem.map((u) => pasteLidarbcTile(u, window, nearLot, dem))]);
  if (!isCurrent()) throw new CancelledBuild();

  // Ground samples: the newer DEM against HRDEM's, every third cell near the lot.
  const ground: [number, number, number][] = [];
  const dtmRegion = regionOfBox(window, nearLot);
  for (let r = dtmRegion.r0; r < dtmRegion.r1; r += 3)
    for (let c = dtmRegion.c0; c < dtmRegion.c1; c += 3) {
      const z = dem[r * window.width + c]!;
      if (z === z) ground.push([...fromPixel(window, [c + 0.5, r + 0.5]), z]);
    }
  const lotRegion = regionOfBox(window, grow(base.bbox, HIRES.copcRefineM));
  const d = datumOffset(window, base, dsm, lotRegion, ground);
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
  }
}
