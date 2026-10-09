// Live: the "best of both" surface around two lots. At 410 W Georgia (Deloitte Summit, finished
// 2023) the tower must come from LidarBC 2025; around the Kitsilano library (houses on every side)
// almost everything stays 2016 detail.
//   npx vitest run --config spike/vitest.live.config.ts spike/20-change
import { createLazPerf } from 'laz-perf/lib/node/index.js';
import { describe, expect, it } from 'vitest';
import { buildRasters } from '../src/elevation/build';
import { useLazPerf } from '../src/elevation/copc';
import { refinementOptions } from '../src/elevation/hires';
import { findMosaicItem } from '../src/elevation/stac';
import { toPixel } from '../src/elevation/window';
import type { Ring } from '../src/geo/polygon';
import { toCrs } from '../src/geo/proj';

function lot([lon, lat]: [number, number], sizeM = 40): Ring[][] {
  const dLat = sizeM / 2 / 111_320, dLon = sizeM / 2 / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [[[[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]]]];
}

/** Largest 4-connected area of `mask` (cells), with its centre in pixels. */
function largestArea(mask: Uint8Array, w: number, h: number) {
  const seen = new Uint8Array(w * h);
  let best = { cells: [] as number[] };
  for (let k = 0; k < w * h; k++) {
    if (!mask[k] || seen[k]) continue;
    const cells = [k];
    seen[k] = 1;
    for (let i = 0; i < cells.length; i++) {
      const q = cells[i]!, r = Math.floor(q / w), c = q % w;
      for (const j of [q + 1, q - 1, q + w, q - w]) {
        const rr = Math.floor(j / w), cc = j % w;
        if (j >= 0 && j < w * h && Math.abs(rr - r) + Math.abs(cc - c) === 1 && mask[j] && !seen[j]) {
          seen[j] = 1;
          cells.push(j);
        }
      }
    }
    if (cells.length > best.cells.length) best = { cells };
  }
  const cx = best.cells.reduce((s, q) => s + (q % w) + 0.5, 0) / best.cells.length, cy = best.cells.reduce((s, q) => s + Math.floor(q / w) + 0.5, 0) / best.cells.length;
  return { cells: best.cells, cx, cy };
}

// Node needs no CORS, so the "proxy" can be the LidarBC object store itself.
const PROXY = 'https://nrs.objectstore.gov.bc.ca';

describe('best of both, live', () => {
  it('takes the Deloitte Summit (built 2023) from 2025 and keeps the rest at 2016 detail', async () => {
    useLazPerf(await createLazPerf());
    const ll: [number, number] = [-123.1158778, 49.2805094];
    const item = (await findMosaicItem(ll))!;
    const o = await refinementOptions({ dsmUrl: item.dsm, dtmUrl: item.dtm }, lot(ll), ll, PROXY);
    expect(o.best?.kind).toBe('merged');
    const t0 = performance.now();
    const merged = await buildRasters(o.best!, lot(ll), 200, () => true);
    const t1 = performance.now();
    const detailed = await buildRasters(o.detailed!, lot(ll), 200, () => true); // from the cache: no download
    const t2 = performance.now();
    const w = merged.window, res = w.res;
    const big = largestArea(merged.changed!, w.width, w.height);
    const [ax, ay] = toPixel(w, toCrs('EPSG:3157', ll));
    const rise = big.cells.reduce((s, q) => s + merged.dsm.data[q]! - detailed.dsm.data[q]!, 0) / big.cells.length;
    const areaM2 = big.cells.length * res * res, offM = Math.hypot(big.cx - ax, big.cy - ay) * res;
    console.log(`410 W Georgia: ${merged.source.detail}`);
    console.log(`  largest change ${areaM2.toFixed(0)} m², ${offM.toFixed(1)} m from the address, ${rise.toFixed(1)} m higher than 2016; best of both ${Math.round(t1 - t0)} ms, then most detailed ${Math.round(t2 - t1)} ms`);
    expect(areaM2).toBeGreaterThan(1000);
    expect(offM).toBeLessThan(15);
    expect(rise).toBeGreaterThan(50);
  }, 180_000);

  it('changes little around the Kitsilano library', async () => {
    useLazPerf(await createLazPerf());
    const ll: [number, number] = [-123.1686926, 49.2647221]; // 2425 MacDonald St
    const item = (await findMosaicItem(ll))!;
    const o = await refinementOptions({ dsmUrl: item.dsm, dtmUrl: item.dtm }, lot(ll), ll, PROXY);
    const merged = await buildRasters(o.best!, lot(ll), 200, () => true);
    console.log(`Kitsilano: ${merged.source.detail}`);
    expect(merged.source.changedShare!).toBeLessThan(0.05);
  }, 180_000);
});
