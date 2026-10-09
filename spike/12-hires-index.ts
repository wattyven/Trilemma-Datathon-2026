// Builds src/elevation/hires-index.json: which high-resolution LiDAR files exist for each BCGS
// 1:2 500 tile in Metro Vancouver.
//  - NRCan CanElevation point clouds (COPC, readable from the browser): every BC project in the bucket.
//  - LidarBC 1 m DSM/DEM rasters (newer; read through the CORS proxy), years after the 2016 base survey.
// Both buckets answer S3 ListObjectsV2, so this is a handful of listing requests, made one at a time.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { politeGet, SPIKE_DIR } from './lib.ts';

const COPC_BASE = 'https://canelevation-lidar-point-clouds.s3.ca-central-1.amazonaws.com/';
const BC_BASE = 'https://nrs.objectstore.gov.bc.ca/gdwuts';
const METRO = { south: 48.98, west: -123.55, north: 49.62, east: -122.15 };
const TILE = /bc_(092g\d{3}_[1-4]_[1-4]_[1-4])_/;

// Tile bounds (copied from src/elevation/bcgs.ts so this script runs under plain Node).
function tileBounds(id: string) {
  const m = /^092g(\d{3})_([1-4])_([1-4])_([1-4])$/.exec(id)!;
  const n = Number(m[1]) - 1;
  let south = 49 + Math.floor(n / 10) * 0.1, west = -124 + (n % 10) * 0.2, h = 0.1, w = 0.2;
  for (const q of [m[2], m[3], m[4]].map(Number)) {
    h /= 2; w /= 2;
    if (q >= 3) south += h;
    if (q === 2 || q === 4) west += w;
  }
  return { south, west, north: south + h, east: west + w };
}
const inMetro = (id: string) => {
  const b = tileBounds(id);
  return b.north > METRO.south && b.south < METRO.north && b.east > METRO.west && b.west < METRO.east;
};

async function listAll(base: string, prefix: string, delimiter = false): Promise<{ keys: { key: string; size: number }[]; prefixes: string[] }> {
  const keys: { key: string; size: number }[] = [], prefixes: string[] = [];
  let token = '';
  for (;;) {
    const q = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
    if (delimiter) q.set('delimiter', '/');
    if (token) q.set('continuation-token', token);
    const r = await politeGet(`${base}${base.endsWith('/') ? '' : '/'}?${q}`.replace('/?', base.endsWith('/') ? '?' : '?'), { gapMs: 150 });
    for (const m of r.text.matchAll(/<Contents><Key>([^<]+)<\/Key>.*?<Size>(\d+)<\/Size>/g)) keys.push({ key: m[1]!, size: Number(m[2]) });
    for (const m of r.text.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix>/g)) prefixes.push(m[1]!);
    const next = /<NextContinuationToken>([^<]+)</.exec(r.text);
    if (!next) break;
    token = next[1]!;
  }
  return { keys, prefixes };
}

// ── NRCan COPC ──────────────────────────────────────────────────────────────────
const projects: string[] = [];
for (const root of ['pointclouds_nuagespoints/BC/', 'pointclouds_nuagespoints/NRCAN/']) {
  const { prefixes } = await listAll(COPC_BASE, root, true);
  projects.push(...prefixes.filter((p) => root.endsWith('BC/') || /BC|Lower_Mainland|Vancouver|Fraser/i.test(p)));
}
console.log('COPC projects considered:', projects.map((p) => p.split('/').at(-2)).join(', '));
// BCGS-named tiles store only the file-name tail after "bc_<id>"; 1 km UTM tiles (FHIMP 2023) are
// keyed "E<easting/100>_N<northing/100>" (south-west corner) and store the full file name.
const copcTiles: Record<string, [number, string, number, number][]> = {};
const copcUtm: Record<string, [number, number, number, number][]> = {};
const templates: string[] = [];
const projectList: string[] = [];
const UTM_TILE = /_1km_E(\d{4})_N(\d{5})_/;
const utmInMetro = (e: number, n: number) => e * 100 + 1000 > 465_000 && e * 100 < 565_000 && n * 100 + 1000 > 5_428_000 && n * 100 < 5_498_000;
for (const prefix of projects) {
  const { keys } = await listAll(COPC_BASE, prefix);
  let kept = 0;
  for (const { key, size } of keys) {
    if (!key.endsWith('.copc.laz')) continue;
    const file = key.slice(prefix.length);
    const year = Number(/_(\d{4})(\d{4})?\.copc\.laz$/.exec(key)?.[1] ?? /_(\d{4})\//.exec(prefix)?.[1] ?? 0);
    const mb = Math.round(size / 1e5) / 10;
    let pi = projectList.indexOf(prefix);
    const id = TILE.exec(key)?.[1];
    const utm = UTM_TILE.exec(key);
    if (id && inMetro(id)) {
      if (pi < 0) pi = projectList.push(prefix) - 1;
      (copcTiles[id] ??= []).push([pi, file.slice(`bc_${id}`.length), year, mb]);
      kept++;
    } else if (utm && utmInMetro(Number(utm[1]), Number(utm[2]))) {
      if (pi < 0) pi = projectList.push(prefix) - 1;
      const yr = Number(/_(\d{4})\d{4}_NAD83/.exec(key)?.[1] ?? /_(\d{4})\//.exec(prefix)?.[1] ?? 0);
      // Names differ only by the tile's E/N: keep one template per project.
      const template = file.replace(`_1km_E${utm[1]}_N${utm[2]}_`, '_1km_{EN}_');
      let ti = templates.indexOf(template);
      if (ti < 0) ti = templates.push(template) - 1;
      (copcUtm[`E${utm[1]}_N${utm[2]}`] ??= []).push([pi, ti, yr, mb]);
      kept++;
    }
  }
  console.log(`  ${prefix.split('/').at(-2)}: ${keys.length} files, ${kept} in Metro Vancouver`);
}
for (const list of [...Object.values(copcTiles), ...Object.values(copcUtm)]) list.sort((a, b) => b[2] - a[2]); // newest first

// ── LidarBC rasters ─────────────────────────────────────────────────────────────
const { prefixes: years } = await listAll(BC_BASE, '092/092g/', true);
// Files are bc_<id>_xli1m_utm10_<dates>_dsm.tif and bc_<id>_xli1m_utm10_<dates>.tif (DEM): store <dates>.
const lidarbcTiles: Record<string, [number, string, number][]> = {};
for (const yp of years) {
  const year = Number(/(\d{4})\/$/.exec(yp)?.[1]);
  if (!year || year <= 2016) continue; // 2016 is already the HRDEM base survey
  const dsm = (await listAll(BC_BASE, `${yp}dsm/`)).keys;
  const dem = (await listAll(BC_BASE, `${yp}dem/`)).keys;
  const demIds = new Set(dem.map((k) => k.key.split('/').at(-1)!));
  let kept = 0;
  for (const { key } of dsm) {
    const id = TILE.exec(key)?.[1];
    const dates = /_xli1m_utm10_(\d{8}_\d{8})_dsm\.tif$/.exec(key)?.[1];
    if (!id || !dates || !inMetro(id)) continue;
    const hasDem = demIds.has(`bc_${id}_xli1m_utm10_${dates}.tif`) ? 1 : 0;
    (lidarbcTiles[id] ??= []).push([year, dates, hasDem]);
    kept++;
  }
  console.log(`  LidarBC ${year}: ${dsm.length} DSM, ${dem.length} DEM tiles, ${kept} in Metro Vancouver`);
}
for (const list of Object.values(lidarbcTiles)) list.sort((a, b) => b[0] - a[0]);

const out = {
  source: 'Built by spike/12-hires-index.ts from S3 listings. Tiles are BCGS 1:2 500 ids; entries newest first.',
  built: new Date().toISOString().slice(0, 10),
  // copc.tiles[id] = [projectIndex, file tail after "bc_<id>", year, MB]
  // copc.utm["E5180_N54470"] = [projectIndex, templateIndex, year, MB]; file = template with {EN} → E5180_N54470
  copc: { base: COPC_BASE, projects: projectList, tiles: copcTiles, utm: copcUtm, templates },
  // lidarbc.tiles[id] = [year, "<start>_<end>" dates, has DEM 0/1]
  lidarbc: { base: `${BC_BASE}/092/092g/`, tiles: lidarbcTiles },
};
const path = join(SPIKE_DIR, '..', 'src', 'elevation', 'hires-index.json');
writeFileSync(path, JSON.stringify(out));
console.log(`\nCOPC tiles: ${Object.keys(copcTiles).length} BCGS + ${Object.keys(copcUtm).length} UTM, LidarBC tiles: ${Object.keys(lidarbcTiles).length} → ${path} (${(JSON.stringify(out).length / 1024).toFixed(0)} KiB)`);
