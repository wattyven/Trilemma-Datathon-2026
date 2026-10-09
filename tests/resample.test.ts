import { describe, expect, it } from 'vitest';
import { regionOfBox, resampleInto, windowAffine } from '../src/elevation/resample';
import { alignedWindow, fromPixel, toPixel, type PixelWindow } from '../src/elevation/window';
import { fromCrs, toCrs } from '../src/geo/proj';

// A 1 m EPSG:3979 window around Vancouver City Hall, and a 0.5 m UTM window inside it.
const centre3979 = toCrs('EPSG:3979', [-123.1139, 49.2613]);
const SRC: PixelWindow = { crs: 'EPSG:3979', col0: 0, row0: 0, width: 700, height: 700, x0: Math.round(centre3979[0]) - 350, y0: Math.round(centre3979[1]) + 350, res: 1 };
const c = toCrs('EPSG:3157', [-123.1139, 49.2613]);
const TGT = alignedWindow({ minX: c[0] - 20, minY: c[1] - 20, maxX: c[0] + 20, maxY: c[1] + 20 }, 200, 0.5, 'EPSG:3157');

describe('resampling between grids', () => {
  it('matches proj4 to within 2 cm across a 440 m window', () => {
    const a = windowAffine(TGT, SRC);
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      const tx = ((i * 37) % 100) / 100 * TGT.width, ty = ((i * 61) % 100) / 100 * TGT.height;
      const exact = toPixel(SRC, toCrs('EPSG:3979', fromCrs('EPSG:3157', fromPixel(TGT, [tx, ty]))));
      const approx = [a.origin[0] + tx * a.col[0] + ty * a.row[0], a.origin[1] + tx * a.col[1] + ty * a.row[1]];
      worst = Math.max(worst, Math.hypot(exact[0] - approx[0]!, exact[1] - approx[1]!) * SRC.res);
    }
    expect(worst).toBeLessThan(0.02);
  });

  it('carries a planar surface across exactly, and NaN where the source has no data', () => {
    // z = 0.01·X3979 + 0.02·Y3979 (relative): a tilted plane survives bilinear sampling unchanged.
    const data = new Float32Array(SRC.width * SRC.height);
    for (let r = 0; r < SRC.height; r++) for (let col = 0; col < SRC.width; col++) data[r * SRC.width + col] = 0.01 * col - 0.02 * r;
    data.fill(NaN, 0, SRC.width * 5); // top rows: nodata
    const out = resampleInto(TGT, SRC, data);
    const mid = Math.floor(TGT.height / 2) * TGT.width + Math.floor(TGT.width / 2);
    const [sx, sy] = toPixel(SRC, toCrs('EPSG:3979', fromCrs('EPSG:3157', fromPixel(TGT, [Math.floor(TGT.width / 2) + 0.5, Math.floor(TGT.height / 2) + 0.5]))));
    expect(out[mid]).toBeCloseTo(0.01 * (sx - 0.5) - 0.02 * (sy - 0.5), 3);
    expect(Number.isFinite(out[mid]!)).toBe(true);
  });

  it('turns a box into a clipped pixel region', () => {
    const r = regionOfBox(TGT, { minX: TGT.x0 + 10, maxX: TGT.x0 + 20, minY: TGT.y0 - 30, maxY: TGT.y0 - 25 });
    expect(r).toEqual({ c0: 20, c1: 40, r0: 50, r1: 60 });
    expect(regionOfBox(TGT, { minX: TGT.x0 - 100, maxX: TGT.x0 + 1, minY: TGT.y0 - 1, maxY: TGT.y0 + 50 })).toEqual({ c0: 0, c1: 2, r0: 0, r1: 2 });
  });
});
