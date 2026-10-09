// Captures small, real API responses as Vitest fixtures (tests/fixtures/). Civic and commercial
// sites only, never homes; PIDs are stripped. Re-run only when a data source changes shape.
// `--strata` recaptures just the strata case (wfs-strata.json and points.json's `strata`).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import proj4 from 'proj4';
import { getJson, SPIKE_DIR } from './lib.ts';

proj4.defs('EPSG:3005', '+proj=aea +lat_0=45 +lon_0=-126 +lat_1=50 +lat_2=58.5 +x_0=1000000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');

const OUT = join(SPIKE_DIR, '..', 'tests', 'fixtures');
mkdirSync(OUT, { recursive: true });
const save = (name: string, data: unknown) => writeFileSync(join(OUT, name), JSON.stringify(data, null, 2) + '\n');

const GEO = 'https://geocoder.api.gov.bc.ca/addresses.json';
const BBOX = '-123.5,49.0,-122.2,49.6';
const resolveUrl = (q: string) => `${GEO}?${new URLSearchParams({ addressString: q, maxResults: '1', outputSRS: '4326', locationDescriptor: 'parcelPoint', echo: 'false' })}`;
const suggestUrl = (q: string) => `${GEO}?${new URLSearchParams({ addressString: q, autoComplete: 'true', maxResults: '8', outputSRS: '4326', locationDescriptor: 'parcelPoint', bbox: BBOX, matchPrecisionNot: 'STREET,BLOCK,INTERSECTION,LOCALITY,PROVINCE', echo: 'false' })}`;

const PROPS = 'PARCEL_FABRIC_POLY_ID,PLAN_NUMBER,PID_FORMATTED,PARCEL_STATUS,PARCEL_CLASS,OWNER_TYPE,MUNICIPALITY,REGIONAL_DISTRICT,FEATURE_AREA_SQM,WHEN_UPDATED,SHAPE';
const wfs = (cql: string, count: number, props = PROPS) =>
  `https://openmaps.gov.bc.ca/geo/pub/wfs?${new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: 'WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW', srsName: 'EPSG:4326', count: String(count), propertyName: props, CQL_FILTER: cql, outputFormat: 'application/json' })}`;
const intersects = ([lon, lat]: number[]) => `INTERSECTS(SHAPE,SRID=4326;POINT(${lon} ${lat}))`;
const dwithin = (ll: number[], m: number) => {
  const [x, y] = proj4('EPSG:4326', 'EPSG:3005', ll);
  return `DWITHIN(SHAPE,POINT(${x.toFixed(2)} ${y.toFixed(2)}),${m},meters)`;
};
const stripPids = (fc: any) => ({
  ...fc,
  features: (fc.features ?? []).map((f: any) => ({ ...f, properties: { ...f.properties, PID_FORMATTED: null } })),
});
const geocodeTrim = (fc: any) => ({ type: fc.type, features: fc.features });

// The strata case: a light-industrial Building Strata (30 units), not a residential tower.
const STRATA = '3871 North Fraser Way, Burnaby';
async function captureStrata() {
  const point = (await getJson(resolveUrl(STRATA))).json.features[0].geometry.coordinates;
  save('wfs-strata.json', stripPids((await getJson(wfs(intersects(point), 10))).json));
  return point;
}
if (process.argv.includes('--strata')) {
  const strata = await captureStrata();
  const file = join(OUT, 'points.json');
  save('points.json', { ...JSON.parse(readFileSync(file, 'utf8')), strata });
  console.log('strata', strata);
  process.exit(0);
}

// Geocoder fixtures.
const geocodes: Record<string, string> = {
  'resolve-van.json': '453 W 12th Ave, Vancouver',
  'resolve-cnv.json': '141 W 14th St, North Vancouver',
  'resolve-dnv.json': '355 W Queens Rd, North Vancouver',
  'resolve-coq-block.json': '3000 Guildford Way, Coquitlam',
  'resolve-victoria.json': '1 Centennial Sq, Victoria',
  'resolve-street.json': 'W 12th Ave, Vancouver',
};
const points: Record<string, number[]> = {};
for (const [file, q] of Object.entries(geocodes)) {
  const { json } = await getJson(resolveUrl(q));
  save(file, geocodeTrim(json));
  points[file] = json.features?.[0]?.geometry?.coordinates;
  console.log(file, json.features?.[0]?.properties?.fullAddress, json.features?.[0]?.properties?.matchPrecision);
}
{
  // Only the civic match: the other suggestions for "453 W 12" are homes.
  const { json } = await getJson(suggestUrl('453 W 12'));
  save('suggest-453-w-12.json', geocodeTrim({ ...json, features: json.features.filter((f: any) => f.properties.fullAddress.startsWith('453 W 12th Ave')) }));
}

// WFS fixtures.
const { json: van } = await getJson(wfs(intersects(points['resolve-van.json']!), 10));
save('wfs-van.json', stripPids(van));
const sry = (await getJson(resolveUrl('13450 104 Ave, Surrey'))).json.features[0].geometry.coordinates;
save('wfs-surrey-twins.json', stripPids((await getJson(wfs(intersects(sry), 10))).json));
const strata = await captureStrata();
const coq = points['resolve-coq-block.json']!;
save('wfs-coq-empty.json', (await getJson(wfs(intersects(coq), 10))).json);
save('wfs-coq-buffer.json', stripPids((await getJson(wfs(dwithin(coq, 15), 20))).json));
save('points.json', { van: points['resolve-van.json'], surrey: sry, strata, coqBlock: coq });

// Real MUNICIPALITY strings per member jurisdiction (attributes only, no geometry).
const halls: Record<string, string> = {
  'Village of Anmore': '2697 Sunnyside Rd, Anmore',
  'Village of Belcarra': '4084 Bedwell Bay Rd, Belcarra',
  'Bowen Island Municipality': '981 Artisan Lane, Bowen Island',
  'City of Burnaby': '4949 Canada Way, Burnaby',
  'City of Coquitlam': '1111 Brunette Ave, Coquitlam',
  'City of Delta': '4500 Clarence Taylor Cres, Delta',
  'City of Langley': '20399 Douglas Cres, Langley',
  'Township of Langley': '20338 65 Ave, Langley',
  'Village of Lions Bay': '400 Centre Rd, Lions Bay',
  'City of Maple Ridge': '11995 Haney Pl, Maple Ridge',
  'City of New Westminster': '511 Royal Ave, New Westminster',
  'City of North Vancouver': '141 W 14th St, North Vancouver',
  'District of North Vancouver': '355 W Queens Rd, North Vancouver',
  'City of Pitt Meadows': '12007 Harris Rd, Pitt Meadows',
  'City of Port Coquitlam': '2580 Shaughnessy St, Port Coquitlam',
  'City of Port Moody': '100 Newport Dr, Port Moody',
  'City of Richmond': '6911 No. 3 Rd, Richmond',
  'City of Surrey': '13450 104 Ave, Surrey',
  'City of Vancouver': '453 W 12th Ave, Vancouver',
  'District of West Vancouver': '750 17th St, West Vancouver',
  'City of White Rock': '15322 Buena Vista Ave, White Rock',
  'Tsawwassen First Nation': '1926 Tsawwassen Dr, Delta',
  'Electoral Area A (UBC)': '6138 Student Union Blvd, Vancouver',
};
const municipalities: any[] = [];
for (const [expected, q] of Object.entries(halls)) {
  const { json } = await getJson(resolveUrl(q));
  const f = json.features?.[0];
  const ll = f?.geometry?.coordinates;
  const row: any = { expected, query: q, fullAddress: f?.properties?.fullAddress, matchPrecision: f?.properties?.matchPrecision, localityName: f?.properties?.localityName, electoralArea: f?.properties?.electoralArea };
  let hits = (await getJson(wfs(intersects(ll), 3, 'MUNICIPALITY,REGIONAL_DISTRICT,PARCEL_CLASS'))).json.features ?? [];
  if (!hits.length) hits = (await getJson(wfs(dwithin(ll, 15), 3, 'MUNICIPALITY,REGIONAL_DISTRICT,PARCEL_CLASS'))).json.features ?? [];
  Object.assign(row, { municipality: hits[0]?.properties?.MUNICIPALITY ?? null, regionalDistrict: hits[0]?.properties?.REGIONAL_DISTRICT ?? null, parcelClass: hits[0]?.properties?.PARCEL_CLASS ?? null });
  municipalities.push(row);
  console.log(`${expected.padEnd(28)} ${String(row.localityName).padEnd(28)} ${String(row.matchPrecision).padEnd(13)} ${row.municipality} | ${row.regionalDistrict}`);
}
save('municipalities.json', municipalities);
