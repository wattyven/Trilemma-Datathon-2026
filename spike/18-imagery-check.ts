// Fetches a lot-sized aerial photo from every municipal source (as the browser would, with an
// Origin header) and checks CORS, content type, size and that it isn't blank.
//   node spike/18-imagery-check.ts
import proj4 from 'proj4';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGERY_SOURCES, exportUrl, tileRange, tileUrl } from '../src/imagery/sources.ts';
import { OUT_DIR, ORIGIN } from './lib.ts';

const POINTS: Record<string, [number, number]> = {
  vancouver: [-123.1139, 49.2613],
  burnaby: [-122.9946, 49.247],
  surrey: [-122.849, 49.191],
  coquitlam: [-122.8616074, 49.2394162],
  dnv: [-123.0780745, 49.3360657],
  delta: [-123.0835, 49.0855],
  mapleridge: [-122.6, 49.2194],
  'township-langley': [-122.6588767, 49.1202891],
  'city-langley': [-122.6575906, 49.1042438],
  'port-coquitlam': [-122.7637, 49.2622],
  'white-rock': [-122.7976004, 49.0235959],
};
mkdirSync(OUT_DIR, { recursive: true });

for (const src of IMAGERY_SOURCES) {
  const [x, y] = proj4('EPSG:4326', 'EPSG:3857', POINTS[src.id]!);
  const half = 80 * 1.53; // 160 m on the ground
  const box = { minX: x - half, maxX: x + half, minY: y - half, maxY: y + half };
  const urls = src.service.kind === 'tiles'
    ? (() => { const r = tileRange(box, src.service.zoom); return [tileUrl(src.service, r.x0, r.y0)]; })()
    : [exportUrl(src.service, box, 1024, 1024)];
  for (const url of urls) {
    const t0 = performance.now();
    const res = await fetch(url, { headers: { Origin: ORIGIN } });
    const buf = Buffer.from(await res.arrayBuffer());
    const acao = res.headers.get('access-control-allow-origin');
    const type = res.headers.get('content-type');
    // Blank check: JPEG/PNG of a single colour compresses to almost nothing.
    const verdict = res.ok && acao && buf.length > 20_000 ? 'ok' : 'CHECK';
    writeFileSync(join(OUT_DIR, `imagery-${src.id}.${type?.includes('png') ? 'png' : 'jpg'}`), buf);
    console.log(`${verdict.padEnd(5)} ${src.id.padEnd(17)} ${res.status} ${type} ${(buf.length / 1024).toFixed(0)} KiB ACAO=${acao} ${Math.round(performance.now() - t0)} ms`);
  }
}
