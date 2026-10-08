// Worker-side builders: turn an elevation spec into DSM/DTM rasters on an analysis window.
// Each builder chooses its grid (CRS + metres per pixel); everything downstream works in that
// grid's pixels and converts to metres with `window.res`.
import { ELEVATION } from '../config';
import type { Raster } from '../engine/grid';
import type { ElevationSpec, HrdemSpec, SourceInfo } from '../engine/protocol';
import type { Ring } from '../geo/polygon';
import { toCrs, type GridCrs } from '../geo/proj';
import { openImage, readWindow, tileGrid } from './cog';
import { bboxOf, embedWindow, lotWindow, type PixelWindow } from './window';

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

/** NRCan HRDEM 1 m mosaic (EPSG:3979): DSM for lot + buffer, DTM for lot + a small margin. */
export async function buildHrdem(spec: HrdemSpec, lotLonLat: Ring[][], bufferM: number, isCurrent: () => boolean): Promise<Omit<BuiltRasters, 'source'>> {
  const [dsmImg, dtmImg] = await Promise.all([openImage(spec.dsmUrl), openImage(spec.dtmUrl)]);
  const tile = tileGrid(dsmImg);
  if (JSON.stringify(tile) !== JSON.stringify(tileGrid(dtmImg))) throw new Error('DSM and DTM grids differ'); // gotcha #6
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

export class CancelledBuild extends Error {}

export async function buildRasters(spec: ElevationSpec, lotLonLat: Ring[][], bufferM: number, isCurrent: () => boolean): Promise<BuiltRasters> {
  switch (spec.kind) {
    case 'hrdem': {
      const r = await buildHrdem(spec.hrdem, lotLonLat, bufferM, isCurrent);
      return { ...r, source: { kind: 'hrdem', label: spec.label, year: spec.year, resM: r.window.res } };
    }
  }
}
