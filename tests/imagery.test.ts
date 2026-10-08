import { describe, expect, it } from 'vitest';
import type { PixelWindow } from '../src/elevation/window';
import { fromPixel } from '../src/elevation/window';
import { applyAffine } from '../src/geo/gridAffine';
import { localFrame } from '../src/geo/local';
import { fromCrs, toCrs } from '../src/geo/proj';
import { gridToPhotoUv, photoBox, photoToLocal } from '../src/imagery/georef';
import { IMAGERY_SOURCES, MERC_HALF, exportUrl, imageryFor, tileRange, tileUrl } from '../src/imagery/sources';

describe('aerial photo sources', () => {
  it('matches each municipality, keeping the Districts, Cities and Township apart', () => {
    expect(imageryFor('District of North Vancouver')?.id).toBe('dnv');
    expect(imageryFor('City of North Vancouver')).toBeNull();
    expect(imageryFor('Township of Langley')?.id).toBe('township-langley');
    expect(imageryFor('City of Langley')?.id).toBe('city-langley');
    expect(imageryFor('City of Vancouver')?.id).toBe('vancouver');
    expect(imageryFor('Electoral Area A')?.id).toBe('vancouver'); // UBC and the UEL
    expect(imageryFor('City of Port Coquitlam')?.id).toBe('port-coquitlam');
    expect(imageryFor('City of Coquitlam')?.id).toBe('coquitlam');
    for (const gap of ['City of Richmond', 'City of New Westminster', 'District of West Vancouver', 'City of Port Moody', 'Village of Anmore'])
      expect(imageryFor(gap)).toBeNull();
  });

  it('gives every source an open licence and a credit line', () => {
    for (const s of IMAGERY_SOURCES) {
      expect(s.licence).toMatch(/^Open Government Licence – /);
      expect(s.credit).toContain(String(s.year));
      expect(s.service.url).toMatch(/^https:\/\//);
    }
  });

  it('builds Web Mercator export and tile requests', () => {
    const surrey = IMAGERY_SOURCES.find((s) => s.id === 'surrey')!.service;
    if (surrey.kind === 'tiles') throw new Error('expected export');
    const u = new URL(exportUrl(surrey, { minX: 1, minY: 2, maxX: 3, maxY: 4 }, 800, 600));
    expect(u.pathname).toMatch(/MapServer\/export$/);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ bbox: '1.00,2.00,3.00,4.00', bboxSR: '3857', imageSR: '3857', size: '800,600', format: 'jpg', f: 'image', layers: 'show:0' });
    const van = IMAGERY_SOURCES.find((s) => s.id === 'vancouver')!.service;
    if (van.kind !== 'tiles') throw new Error('expected tiles');
    expect(tileUrl(van, 82846, 179471)).toMatch(/\/tile\/19\/179471\/82846$/);
  });

  it('finds the tiles covering a box (matching the slippy-map tile formula)', () => {
    const [lon, lat] = [-123.1139, 49.2613];
    const [x, y] = toCrs('EPSG:3857', [lon, lat]);
    const r = tileRange({ minX: x - 1, minY: y - 1, maxX: x + 1, maxY: y + 1 }, 19);
    const n = 2 ** 19, rad = (lat * Math.PI) / 180;
    expect([r.x0, r.y0]).toEqual([Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)]);
    const size = (2 * MERC_HALF) / 2 ** 19;
    expect(r.box.maxX - r.box.minX).toBeCloseTo(size * (r.x1 - r.x0 + 1), 6);
    expect(r.box.minX).toBeLessThanOrEqual(x - 1);
    expect(r.box.maxY).toBeGreaterThanOrEqual(y + 1);
  });
});

describe('placing a photo', () => {
  const c = toCrs('EPSG:3979', [-123.1139, 49.2613]);
  const W: PixelWindow = { crs: 'EPSG:3979', col0: 0, row0: 0, width: 440, height: 440, x0: Math.round(c[0]) - 220, y0: Math.round(c[1]) + 220, res: 1 };
  const [mx, my] = toCrs('EPSG:3857', [-123.1139, 49.2613]);
  const box = { minX: mx - 150, minY: my - 150, maxX: mx + 150, maxY: my + 150 };

  it('maps grid pixels to photo coordinates to within 2 cm (a photo pixel is 15 cm)', () => {
    const a = gridToPhotoUv(W, box);
    let worst = 0;
    for (const p of [[10, 10], [220, 220], [400, 30], [37, 391]] as [number, number][]) {
      const [x, y] = toCrs('EPSG:3857', fromCrs('EPSG:3979', fromPixel(W, p)));
      const exact = [(x - box.minX) / 300, (box.maxY - y) / 300];
      const got = applyAffine(a, p);
      worst = Math.max(worst, Math.hypot(got[0] - exact[0]!, got[1] - exact[1]!) * 300 / 1.53); // metres on the ground
    }
    expect(worst).toBeLessThan(0.02);
    // ~25° grid convergence: the grid's columns run at an angle across the photo.
    expect(Math.abs(Math.atan2(a.col[1], a.col[0]) * 180 / Math.PI)).toBeGreaterThan(20);
  });

  it('maps photo pixels to local metres', () => {
    const frame = localFrame([-123.1139, 49.2613]);
    const a = photoToLocal(box, 1000, 1000, frame);
    const centre = applyAffine(a, [500, 500]);
    expect(Math.hypot(centre[0], centre[1])).toBeLessThan(0.05);
    // 300 Mercator units ≈ 196 m on the ground at this latitude.
    expect(Math.hypot(...(applyAffine(a, [1000, 500]).map((v, i) => v - centre[i]!) as [number, number]))).toBeCloseTo(98, 0);
  });

  it('covers the lot and its margin in either grid', () => {
    const d = 0.0001;
    const lot = [[[[-123.1139 - d, 49.2613 - d], [-123.1139 + d, 49.2613 - d], [-123.1139 + d, 49.2613 + d], [-123.1139 - d, 49.2613 + d], [-123.1139 - d, 49.2613 - d]]]] as [number, number][][][];
    const b = photoBox(lot, 48);
    for (const crs of ['EPSG:3979', 'EPSG:3157'] as const) {
      const [cx, cy] = toCrs(crs, [-123.1139, 49.2613]);
      for (const corner of [[cx - 55, cy - 55], [cx + 55, cy + 55]] as [number, number][]) {
        const [x, y] = toCrs('EPSG:3857', fromCrs(crs, corner));
        expect(x).toBeGreaterThan(b.minX);
        expect(x).toBeLessThan(b.maxX);
        expect(y).toBeGreaterThan(b.minY);
        expect(y).toBeLessThan(b.maxY);
      }
    }
  });
});
