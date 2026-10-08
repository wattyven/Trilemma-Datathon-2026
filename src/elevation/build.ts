// Worker-side builders: turn an elevation spec into DSM/DTM rasters on an analysis window.
// Each builder chooses its grid (CRS + metres per pixel); everything downstream works in that
// grid's pixels and converts to metres with `window.res`.
import { ELEVATION, HIRES } from '../config';
import { bilinear, type Raster } from '../engine/grid';
import type { CopcSpec, ElevationSpec, HrdemSpec, SourceInfo } from '../engine/protocol';
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

/**
 * Lay a point-derived surface over the base DSM inside `region`, after removing its vertical datum
 * offset against HRDEM. The offset is the median of (ground points − HRDEM DTM) or, with too few
 * ground points, of (surface − HRDEM DSM). Throws when the patch is too sparse or the offset absurd.
 */
export function patchSurface(
  window: PixelWindow,
  base: { dsm: Float32Array; dtm: Float32Array },
  patch: Float32Array,
  region: { c0: number; r0: number; c1: number; r1: number },
  ground: [number, number, number][],
): PatchStats {
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
  if (offset === null || Math.abs(offset) > HIRES.maxDatumOffsetM) throw new Error(`Point-cloud heights don't line up with HRDEM (offset ${offset})`);

  let filled = 0;
  for (let r = region.r0; r < region.r1; r++) {
    for (let c = region.c0; c < region.c1; c++) {
      const k = r * width + c;
      const v = patch[k]!;
      if (v === v) {
        base.dsm[k] = v - offset;
        filled++;
      }
    }
  }
  const total = Math.max(1, (region.r1 - region.r0) * (region.c1 - region.c0));
  if (filled / total < HIRES.minFilled) throw new Error(`Point cloud covers only ${Math.round((100 * filled) / total)}% of the area near the lot`);
  return { filled, datumOffsetM: offset, datumFrom };
}

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
  const detail = `${(stats.points / 1e6).toFixed(1)} M points in ${stats.nodes} nodes${stats.failed ? ` (${stats.failed} skipped)` : ''}, ${(stats.bytes / 1e6).toFixed(1)} MB, datum ${patch.datumOffsetM >= 0 ? '+' : ''}${patch.datumOffsetM.toFixed(2)} m (${patch.datumFrom})`;
  return {
    window,
    lot: base.lot,
    dsm: { width: window.width, height: window.height, data: base.dsm },
    dtm: { width: window.width, height: window.height, data: base.dtm },
    detail,
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
  }
}
