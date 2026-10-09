// BC Address Geocoder probe.
import { getJson, politeGet, corsSummary, writeOut, writeSample, check, stats } from './lib.ts';
import { TEST_ADDRESSES, LOCALITY_CANDIDATES, METRO_BBOX } from './addresses.ts';

const BASE = 'https://geocoder.api.gov.bc.ca';

function q(path: string, params: Record<string, string | number | boolean>) {
  const u = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

function haversineM(a: number[], b: number[]) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const bboxStr = `${METRO_BBOX.minLon},${METRO_BBOX.minLat},${METRO_BBOX.maxLon},${METRO_BBOX.maxLat}`;
const results: Record<string, any> = {};

// 1. Test addresses with parcelPoint vs accessPoint.
console.log('\n# 1. Test addresses (parcelPoint vs accessPoint)');
const geocoded: any[] = [];
for (const a of TEST_ADDRESSES) {
  const common = { addressString: a.address, maxResults: 1, outputSRS: 4326, echo: false };
  const { r, json } = await getJson(q('/addresses.json', { ...common, locationDescriptor: 'parcelPoint' }));
  const f = json.features?.[0];
  const { json: ja } = await getJson(q('/addresses.json', { ...common, locationDescriptor: 'accessPoint' }));
  const fa = ja.features?.[0];
  const p = f?.properties ?? {};
  const row = {
    id: a.id,
    query: a.address,
    fullAddress: p.fullAddress,
    score: p.score,
    matchPrecision: p.matchPrecision,
    localityName: p.localityName,
    localityType: p.localityType,
    electoralArea: p.electoralArea,
    locationDescriptor: p.locationDescriptor,
    locationPositionalAccuracy: p.locationPositionalAccuracy,
    lonLat: f?.geometry?.coordinates,
    accessPointLonLat: fa?.geometry?.coordinates,
    parcelToAccessM: f && fa ? Math.round(haversineM(f.geometry.coordinates, fa.geometry.coordinates)) : null,
    ms: r.ms,
    expectInScope: a.expectInScope,
  };
  geocoded.push(row);
  console.log(`${a.id.padEnd(7)} ${String(p.score).padStart(3)} ${String(p.matchPrecision).padEnd(13)} ${String(p.localityName).padEnd(22)} ${JSON.stringify(row.lonLat)}  parcel↔access ${row.parcelToAccessM} m`);
  if (a.id === 'van') {
    writeSample('geocoder-address.json', json);
    results.cors = corsSummary(r.headers);
  }
}
writeOut('geocode.json', geocoded);
results.geocoded = geocoded;

// 2. locationDescriptor values.
console.log('\n# 2. locationDescriptor values');
results.locationDescriptors = {};
for (const d of ['any', 'accessPoint', 'frontDoorPoint', 'parcelPoint', 'rooftopPoint', 'routingPoint', 'bogusPoint']) {
  const r = await politeGet(q('/addresses.json', { addressString: TEST_ADDRESSES[0].address, maxResults: 1, outputSRS: 4326, locationDescriptor: d }));
  let desc: string | undefined, coords: unknown;
  try {
    const j = JSON.parse(r.text);
    desc = j.features?.[0]?.properties?.locationDescriptor;
    coords = j.features?.[0]?.geometry?.coordinates;
  } catch { desc = r.text.slice(0, 120); }
  results.locationDescriptors[d] = { status: r.status, returned: desc, coords };
  console.log(`${d.padEnd(15)} ${r.status} → ${desc} ${JSON.stringify(coords)}`);
}

// 3. Autocomplete behaviour.
console.log('\n# 3. Autocomplete');
results.autocomplete = {};
const partials = ['453 W 12', '4949 Cana', '13450 104', '3871 North Fr', 'Main St'];
for (const s of partials) {
  for (const variant of ['plain', 'filtered'] as const) {
    const params: Record<string, string | number | boolean> = {
      addressString: s, autoComplete: true, maxResults: 5, outputSRS: 4326, brief: true, locationDescriptor: 'parcelPoint', bbox: bboxStr,
    };
    if (variant === 'filtered') params.matchPrecisionNot = 'STREET,BLOCK,INTERSECTION,LOCALITY,PROVINCE';
    const { r, json } = await getJson(q('/addresses.json', params));
    const rows = (json.features ?? []).map((f: any) => `${f.properties.fullAddress} [${f.properties.matchPrecision}, ${f.properties.score}]`);
    results.autocomplete[`${s} (${variant})`] = { ms: r.ms, rows };
    console.log(`"${s}" ${variant.padEnd(8)} ${r.ms} ms`);
    rows.forEach((x: string) => console.log('     ' + x));
    if (s === '453 W 12' && variant === 'filtered') writeSample('geocoder-autocomplete.json', json);
  }
}

// 4. bbox and localityName filters.
console.log('\n# 4. bbox / localityName filters');
{
  const { json: inBox } = await getJson(q('/addresses.json', { addressString: '1 Centennial Sq, Victoria', maxResults: 3, outputSRS: 4326, bbox: bboxStr }));
  const vicRows = (inBox.features ?? []).map((f: any) => `${f.properties.fullAddress} [${f.properties.matchPrecision}]`);
  results.bboxExcludesVictoria = vicRows;
  check('bbox drops a Victoria address', !vicRows.some((x: string) => x.includes('Victoria')), JSON.stringify(vicRows));
  const { json: byLoc } = await getJson(q('/addresses.json', { addressString: '453 W 12th Ave', maxResults: 3, outputSRS: 4326, localityName: 'Burnaby,Surrey' }));
  const locRows = (byLoc.features ?? []).map((f: any) => `${f.properties.fullAddress} [${f.properties.matchPrecision}, ${f.properties.score}]`);
  results.localityFilter = locRows;
  console.log('localityName=Burnaby,Surrey for "453 W 12th Ave":', locRows);
}

// 5. Locality names actually returned.
console.log('\n# 5. Locality names');
results.localities = {};
for (const name of LOCALITY_CANDIDATES) {
  const { json } = await getJson(q('/addresses.json', { addressString: `${name}, BC`, maxResults: 1, outputSRS: 4326, echo: true }));
  const f = json.features?.[0];
  const p = f?.properties ?? {};
  const row = { localityName: p.localityName, localityType: p.localityType, matchPrecision: p.matchPrecision, score: p.score, electoralArea: p.electoralArea, lonLat: f?.geometry?.coordinates };
  results.localities[name] = row;
  const exact = p.matchPrecision === 'LOCALITY' && p.localityName?.toLowerCase() === name.toLowerCase();
  console.log(`${exact ? '✓' : '·'} ${name.padEnd(30)} → ${String(p.localityName).padEnd(28)} ${String(p.localityType).padEnd(28)} ${p.matchPrecision} ${p.score}`);
}

// 6. Sample real sites on a coarse grid to see which locality names real addresses carry.
console.log('\n# 6. Nearest-site locality sampling (coarse grid)');
results.siteSamples = [];
const seen = new Map<string, number>();
const nx = 8, ny = 6;
for (let i = 0; i < nx; i++) {
  for (let j = 0; j < ny; j++) {
    const lon = METRO_BBOX.minLon + ((i + 0.5) / nx) * (METRO_BBOX.maxLon - METRO_BBOX.minLon);
    const lat = METRO_BBOX.minLat + ((j + 0.5) / ny) * (METRO_BBOX.maxLat - METRO_BBOX.minLat);
    const r = await politeGet(q('/sites/nearest.json', { point: `${lon.toFixed(4)},${lat.toFixed(4)}`, outputSRS: 4326, maxDistance: 3000 }));
    if (r.status !== 200) { results.siteSamples.push({ lon, lat, status: r.status }); continue; }
    const j2 = JSON.parse(r.text);
    const p = j2.properties ?? j2.features?.[0]?.properties;
    if (!p) continue;
    results.siteSamples.push({ lon, lat, fullAddress: p.fullAddress, localityName: p.localityName, localityType: p.localityType, electoralArea: p.electoralArea });
    seen.set(p.localityName, (seen.get(p.localityName) ?? 0) + 1);
  }
}
console.log([...seen.entries()].map(([k, v]) => `${k} (${v})`).join(', '));
results.siteLocalities = Object.fromEntries(seen);

// 7. Checks.
console.log('\n# 7. Checks');
for (const g of geocoded) {
  const [lon, lat] = g.lonLat ?? [NaN, NaN];
  const inBox = lon >= METRO_BBOX.minLon && lon <= METRO_BBOX.maxLon && lat >= METRO_BBOX.minLat && lat <= METRO_BBOX.maxLat;
  check(`${g.id}: in Metro bbox == expected (${g.expectInScope})`, inBox === g.expectInScope);
  check(`${g.id}: CIVIC_NUMBER precision, parcelPoint`, g.matchPrecision === 'CIVIC_NUMBER' && g.locationDescriptor === 'parcelPoint', `${g.matchPrecision}/${g.locationDescriptor}`);
}
results.stats = stats;
writeOut('geocoder-results.json', results);
console.log(`\n${stats.requests} requests, ${stats.cacheHits} cache hits. CORS: ${JSON.stringify(results.cors)}`);
