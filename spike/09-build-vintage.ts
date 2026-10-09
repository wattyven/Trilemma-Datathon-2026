// Builds src/elevation/vintage.json: every HRDEM LiDAR acquisition project that touches Metro
// Vancouver, with its real footprint (the per-project extent GeoJSON; STAC item geometries
// over-claim, see docs/DATA_SOURCES.md §4.3) clipped to the regional box and simplified.
// The mosaic uses the newest project covering a point, so the app picks the newest match.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getJson, SPIKE_DIR } from './lib.ts';

type Pt = [number, number];
const BOX = { minX: -123.5, minY: 49.0, maxX: -122.2, maxY: 49.6 };
const TOLERANCE_DEG = 0.0001; // ~10 m

function clipRing(ring: Pt[]): Pt[] {
  // Sutherland–Hodgman against each side of the box.
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= BOX.minX, (a, b) => [BOX.minX, a[1] + ((b[1] - a[1]) * (BOX.minX - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= BOX.maxX, (a, b) => [BOX.maxX, a[1] + ((b[1] - a[1]) * (BOX.maxX - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= BOX.minY, (a, b) => [a[0] + ((b[0] - a[0]) * (BOX.minY - a[1])) / (b[1] - a[1]), BOX.minY]],
    [(p) => p[1] <= BOX.maxY, (a, b) => [a[0] + ((b[0] - a[0]) * (BOX.maxY - a[1])) / (b[1] - a[1]), BOX.maxY]],
  ];
  let out = ring.slice(0, -1);
  for (const [inside, cross] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]!, prev = input[(i + input.length - 1) % input.length]!;
      if (inside(cur)) {
        if (!inside(prev)) out.push(cross(prev, cur));
        out.push(cur);
      } else if (inside(prev)) out.push(cross(prev, cur));
    }
    if (!out.length) return [];
  }
  return [...out, out[0]!];
}

function simplify(points: Pt[], tol: number): Pt[] {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a]!, [bx, by] = points[b]!;
    const len = Math.hypot(bx - ax, by - ay);
    let best = -1, bestD = tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i]!;
      // A closed ring starts and ends on the same point: measure from that point instead.
      const d = len < 1e-12 ? Math.hypot(px - ax, py - ay) : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const round = (p: Pt): Pt => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];

const label = (id: string) => id.replace(/-1m$/, '').replace(/^(BC|NRCAN|VILLE_[A-Z_]+?)-/, '$1 ').replace(/_/g, ' ').replace(/^VILLE /, 'City of ');

const search = `https://datacube.services.geo.ca/stac/api/search?collections=hrdem-lidar&limit=100&bbox=${BOX.minX},${BOX.minY},${BOX.maxX},${BOX.maxY}`;
const { json } = await getJson(search);
const projects: any[] = [];
for (const item of json.features ?? []) {
  const { json: ext } = await getJson(`https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/${item.id}-extent.geojson`);
  const g = ext.geometry ?? ext.features?.[0]?.geometry;
  const polys: Pt[][][] = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const clipped: Pt[][][] = [];
  for (const rings of polys) {
    const out = rings.map((r) => clipRing(r)).filter((r) => r.length >= 4).map((r) => simplify(r, TOLERANCE_DEG).map(round)).filter((r) => r.length >= 4);
    if (out.length && out[0]!.length >= 4) clipped.push(out);
  }
  if (!clipped.length) continue;
  projects.push({ id: item.id, date: String(item.properties.datetime).slice(0, 10), label: label(item.id), geometry: { type: 'MultiPolygon', coordinates: clipped } });
  console.log(`${item.id.padEnd(48)} ${String(item.properties.datetime).slice(0, 10)}  ${clipped.length} polygon(s)`);
}
projects.sort((a, b) => b.date.localeCompare(a.date));
const out = {
  source: 'NRCan HRDEM hrdem-lidar per-project extents, clipped to Metro Vancouver and simplified (~10 m). Built by spike/09-build-vintage.ts.',
  built: new Date().toISOString().slice(0, 10),
  projects,
};
const path = join(SPIKE_DIR, '..', 'src', 'elevation', 'vintage.json');
writeFileSync(path, JSON.stringify(out));
console.log(`\n${projects.length} projects → ${path} (${(JSON.stringify(out).length / 1024).toFixed(1)} KiB)`);
