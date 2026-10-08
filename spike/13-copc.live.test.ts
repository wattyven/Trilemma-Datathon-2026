// Live: build the 0.5 m point-cloud surface for a few lots and report cost and the datum offset.
// npx vitest run --config spike/vitest.live.config.ts spike/13-copc
import { createLazPerf } from 'laz-perf/lib/node/index.js';
import { describe, expect, it } from 'vitest';
import { buildRasters } from '../src/elevation/build';
import { useLazPerf } from '../src/elevation/copc';
import { loadHiresIndex, selectCopc } from '../src/elevation/hires';
import { findMosaicItem } from '../src/elevation/stac';
import type { Ring } from '../src/geo/polygon';

function lot([lon, lat]: [number, number], sizeM = 30): Ring[][] {
  const dLat = sizeM / 2 / 111_320, dLon = sizeM / 2 / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [[[[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]]]];
}

const LOTS: [string, [number, number], number?][] = [
  ['Vancouver City Hall', [-123.1139388, 49.261317]],
  ['Kitsilano Branch Library', [-123.1686926, 49.2647221]],
  ['Maple Ridge', [-122.5999606, 49.2193815]],
  ['Maple Ridge, big lot', [-122.5999606, 49.2193815], 170],
];

describe('COPC surface, live', () => {
  for (const [name, lonLat, size] of LOTS) {
    it(name, async () => {
      useLazPerf(await createLazPerf());
      const item = await findMosaicItem(lonLat);
      const choice = selectCopc(await loadHiresIndex(), lot(lonLat, size), null);
      expect(item && choice).toBeTruthy();
      const t0 = performance.now();
      const r = await buildRasters(
        { kind: 'copc', hrdem: { dsmUrl: item!.dsm, dtmUrl: item!.dtm }, copc: choice!.copc, label: choice!.project, year: String(choice!.year) },
        lot(lonLat, size),
        200,
        () => true,
      );
      const ms = Math.round(performance.now() - t0);
      const nan = r.dsm.data.reduce((n, v) => n + (v === v ? 0 : 1), 0);
      console.log(`${name}: ${choice!.project}, ${choice!.copc.urls.length} file(s); ${r.window.width}×${r.window.height} @ ${r.window.res} m; ${r.source.detail}; ${ms} ms; DSM NaN ${(100 * nan / r.dsm.data.length).toFixed(2)}%`);
      expect(r.window.res).toBe(0.5);
    });
  }
});
