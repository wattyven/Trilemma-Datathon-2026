// COG reads with geotiff.js in Node: cold/warm timings, bytes, coverage, DSM−DTM, vintage by pixel match.
import { readOut, writeOut, check } from './lib.ts';
import { probePoint, parallelLoad, openCog, readWindow, toLcc, instrumentFetch, net, resetNet } from './cog-probe.ts';

instrumentFetch();
const stac = readOut('stac-results.json');
const pts: any[] = stac.points.filter((p: any) => p.id !== 'vic');
const results: Record<string, any> = {};

// 1. Cold, realistic first load: lot + 200 m buffer ≈ 441×441 m window, DSM + DTM.
console.log('# 1. Cold window reads (fresh geotiff instances)');
results.cold = {};
for (const id of ['van', 'dnv', 'mr']) {
  const p = pts.find((x) => x.id === id);
  const t0 = performance.now();
  const r = await probePoint(p.dsm, p.dtm, p.lonLat, 220);
  const total = Math.round(performance.now() - t0);
  results.cold[id] = { totalMs: total, ...r };
  for (const k of ['dsm', 'dtm'] as const) {
    const x = (r as any)[k];
    console.log(`${id} ${k}: open ${x.open.ms} ms/${x.open.requests} req/${(x.open.bytes / 1024).toFixed(0)} KiB · 3×3 ${x.centre3x3.ms} ms/${x.centre3x3.requests} req · window ${x.window.size} ${x.window.ms} ms/${x.window.requests} req/${(x.window.bytes / 1024).toFixed(0)} KiB · warm ${x.warm.ms} ms/${x.warm.requests} req · ${JSON.stringify(x.window.stats)}`);
  }
  console.log(`${id}: total ${total} ms, DSM−DTM at point ${r.dsmMinusDtmAtPoint} m, γ=${r.convergenceDeg}°`);
}
results.parallel = {};
for (const id of ['van', 'dnv']) {
  const p = pts.find((x) => x.id === id);
  results.parallel[id] = await parallelLoad(p.dsm, p.dtm, p.lonLat, 220);
  console.log(`${id}: parallel cold DSM+DTM ${JSON.stringify(results.parallel[id])}`);
}
const d0 = results.cold.van.dsm.desc;
console.log('\nTIFF tags:', JSON.stringify(d0));

// 2. Coverage: one opened DSM/DTM pair, centre 3×3 at every test point.
console.log('\n# 2. Coverage at every test point');
const dsm = await openCog(pts[0].dsm);
const dtm = await openCog(pts[0].dtm);
results.coverage = [];
for (const p of pts) {
  const xy = toLcc(p.lonLat);
  const a = await readWindow(dsm.image, xy, 1);
  const b = await readWindow(dtm.image, xy, 1);
  const dsmV = a.data[4], dtmV = b.data[4];
  const nd = (v: number) => v < -1000 || Number.isNaN(v);
  const row = { id: p.id, dsm: +dsmV.toFixed(2), dtm: +dtmV.toFixed(2), dsmMinusDtm: +(dsmV - dtmV).toFixed(2), dsmNodata: nd(dsmV), dtmNodata: nd(dtmV) };
  results.coverage.push(row);
  console.log(`${p.id.padEnd(7)} DSM ${row.dsm.toFixed(2).padStart(8)}  DTM ${row.dtm.toFixed(2).padStart(8)}  Δ ${row.dsmMinusDtm.toFixed(2).padStart(6)}`);
}

// 3. Vintage: which acquisition project does the mosaic pixel come from? Compare a 3×3 block.
console.log('\n# 3. Vintage by pixel match (mosaic vs each candidate project)');
results.vintage = {};
for (const id of ['van', 'sry', 'mr']) {
  const p = pts.find((x) => x.id === id);
  const xy = toLcc(p.lonLat);
  const mosaic = Array.from((await readWindow(dsm.image, xy, 1)).data);
  const rows = [];
  for (const proj of p.projects) {
    try {
      const { image } = await openCog(proj.dsm);
      const vals = Array.from((await readWindow(image, xy, 1)).data);
      const maxDiff = Math.max(...vals.map((v, i) => Math.abs(v - mosaic[i])));
      rows.push({ project: proj.id, datetime: proj.datetime.slice(0, 10), footprintContains: proj.containsPoint, maxDiff: +maxDiff.toFixed(3), centre: +vals[4].toFixed(2) });
    } catch (e) {
      rows.push({ project: proj.id, error: String(e).slice(0, 120) });
    }
  }
  const match = rows.find((r: any) => r.maxDiff !== undefined && r.maxDiff < 0.01);
  results.vintage[id] = { mosaicCentre: +mosaic[4].toFixed(2), rows, sourceProject: match?.project ?? null };
  console.log(`${id}: mosaic centre ${mosaic[4].toFixed(2)} → source ${match?.project ?? 'no exact match'}`);
  rows.forEach((r: any) => console.log('    ', JSON.stringify(r)));
}

// 4. Checks.
console.log('\n# 4. Checks');
for (const c of results.coverage) check(`${c.id}: DSM and DTM have data at the point`, !c.dsmNodata && !c.dtmNodata);
check('Compression is decodable by geotiff.js (window stats valid)', results.cold.van.dsm.window.stats.valid > 0, `Compression=${d0.compression} Predictor=${d0.predictor}`);
check('TileOffsets are loaded lazily', results.cold.van.dsm.open.bytes < 1_000_000, `open fetched ${(results.cold.van.dsm.open.bytes / 1024).toFixed(0)} KiB`);
check('Parallel cold DSM+DTM lot window < 5 s (Node, this connection)', results.parallel.van.ms < 5000, `${results.parallel.van.ms} ms, ${results.parallel.van.mib} MiB`);
writeOut('cog-results.json', results);
resetNet();
void net;
