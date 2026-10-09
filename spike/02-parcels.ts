// ParcelMap BC WFS probe.
import proj4 from 'proj4';
import { getJson, politeGet, corsSummary, readOut, writeOut, writeSample, check, pointInGeometry, stats } from './lib.ts';

proj4.defs('EPSG:3005', '+proj=aea +lat_0=45 +lon_0=-126 +lat_1=50 +lat_2=58.5 +x_0=1000000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');

const WFS = 'https://openmaps.gov.bc.ca/geo/pub/wfs';
const LAYER = 'WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW';
const PROPS = 'PARCEL_FABRIC_POLY_ID,PARCEL_NAME,PLAN_NUMBER,PID_FORMATTED,PARCEL_STATUS,PARCEL_CLASS,OWNER_TYPE,MUNICIPALITY,REGIONAL_DISTRICT,FEATURE_AREA_SQM,WHEN_UPDATED,SHAPE';

function wfsUrl(params: Record<string, string | number>, base = WFS) {
  const u = new URL(base);
  const all = { service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: LAYER, outputFormat: 'application/json', ...params };
  for (const [k, v] of Object.entries(all)) u.searchParams.set(k, String(v));
  return u.toString();
}

const pointQuery = (lon: number, lat: number, extra: Record<string, string | number> = {}) =>
  wfsUrl({ srsName: 'EPSG:4326', count: 5, propertyName: PROPS, CQL_FILTER: `INTERSECTS(SHAPE,SRID=4326;POINT(${lon} ${lat}))`, ...extra });

const results: Record<string, any> = {};

// 1. Layer names.
console.log('# 1. Layer names');
results.layers = {};
for (const t of [LAYER, 'WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_FA_SVW']) {
  const r = await politeGet(`${WFS}?service=WFS&version=2.0.0&request=DescribeFeatureType&typeNames=${t}`);
  const ok = r.status === 200 && r.text.includes('complexType');
  results.layers[t] = { status: r.status, ok, geometryColumn: r.text.match(/name="(\w+)"[^>]*type="gml:\w+PropertyType"/)?.[1] ?? null };
  check(`DescribeFeatureType ${t}`, ok, `status ${r.status}`);
}
{
  // Layer-scoped capabilities (small) instead of the multi-MB global document.
  const r = await politeGet(`https://openmaps.gov.bc.ca/geo/pub/${LAYER}/ows?service=WFS&version=2.0.0&request=GetCapabilities`);
  const fmts = [...r.text.matchAll(/<ows:Value>([^<]+)<\/ows:Value>/g)].map((m) => m[1]);
  results.capabilities = {
    status: r.status,
    title: r.text.match(/<Title>([^<]+)<\/Title>/)?.[1],
    defaultCRS: r.text.match(/<DefaultCRS>([^<]+)<\/DefaultCRS>/)?.[1],
    outputFormats: [...new Set(fmts.filter((f) => /json|javascript/i.test(f)))],
    countDefault: r.text.match(/CountDefault[\s\S]*?<ows:DefaultValue>(\d+)/)?.[1],
  };
  console.log('Layer capabilities:', results.capabilities);
}

// 2. Point-in-polygon for every geocoded test address.
console.log('\n# 2. Point queries');
const geocoded: any[] = readOut('geocode.json');
results.points = [];
for (const g of geocoded) {
  const [lon, lat] = g.lonLat;
  const { r, json } = await getJson(pointQuery(lon, lat));
  const feats = json.features ?? [];
  const rows = feats.map((f: any) => ({
    contains: pointInGeometry([lon, lat], f.geometry),
    geomType: f.geometry.type,
    vertices: JSON.stringify(f.geometry.coordinates).split('],[').length,
    ...Object.fromEntries(Object.entries(f.properties).filter(([k]) => k !== 'SHAPE')),
  }));
  results.points.push({ id: g.id, lonLat: g.lonLat, matchPrecision: g.matchPrecision, ms: r.ms, hits: rows.length, rows });
  const first = rows[0];
  console.log(`${g.id.padEnd(7)} hits=${rows.length} ${r.ms}ms contains=${rows.map((x: any) => x.contains).join('/')} ${first ? `${first.PARCEL_CLASS} | ${first.OWNER_TYPE} | ${first.PLAN_NUMBER} | ${first.MUNICIPALITY} | ${first.REGIONAL_DISTRICT} | ${Math.round(first.FEATURE_AREA_SQM)} m²` : ''}`);
  if (g.id === 'van') {
    writeSample('wfs-parcel.json', json);
    results.cors = corsSummary(r.headers);
  }
  if (g.id === 'strata') writeSample('wfs-parcel-strata.json', json);
}

// 3. Axis order variants.
console.log('\n# 3. Axis order');
results.axisOrder = {};
{
  const g = geocoded.find((x) => x.id === 'van');
  const [lon, lat] = g.lonLat;
  const variants: Record<string, string> = {
    'v2.0.0 srsName=EPSG:4326': pointQuery(lon, lat),
    'v2.0.0 srsName=urn:ogc:def:crs:EPSG::4326': pointQuery(lon, lat, { srsName: 'urn:ogc:def:crs:EPSG::4326' }),
    'v1.1.0 srsName=EPSG:4326': pointQuery(lon, lat, { version: '1.1.0', typeName: LAYER, maxFeatures: 5 }),
    'v2.0.0 CQL POINT(lat lon) [deliberately flipped]': pointQuery(lon, lat, { CQL_FILTER: `INTERSECTS(SHAPE,SRID=4326;POINT(${lat} ${lon}))` }),
  };
  for (const [label, url] of Object.entries(variants)) {
    const r = await politeGet(url);
    let first: number[] | undefined, hits = 0;
    try {
      const j = JSON.parse(r.text);
      hits = j.features?.length ?? 0;
      first = j.features?.[0]?.geometry?.coordinates?.[0]?.[0];
    } catch { /* non-JSON */ }
    const order = first ? (first[0] < -100 ? 'lon,lat' : 'lat,lon') : 'n/a';
    results.axisOrder[label] = { status: r.status, hits, firstVertex: first, order };
    console.log(`${label.padEnd(50)} status=${r.status} hits=${hits} first=${JSON.stringify(first)} → ${order}`);
  }
}

// 4. Native EPSG:3005 query.
console.log('\n# 4. Native BC Albers query');
{
  const g = geocoded.find((x) => x.id === 'van');
  const [x, y] = proj4('EPSG:4326', 'EPSG:3005', g.lonLat);
  const url = wfsUrl({ srsName: 'EPSG:4326', count: 5, propertyName: PROPS, CQL_FILTER: `INTERSECTS(SHAPE,POINT(${x.toFixed(2)} ${y.toFixed(2)}))` });
  const { r, json } = await getJson(url);
  results.nativeAlbers = { x, y, status: r.status, hits: json.features?.length, contains: json.features?.[0] ? pointInGeometry(g.lonLat, json.features[0].geometry) : null };
  check('EPSG:3005 INTERSECTS returns the same parcel', results.nativeAlbers.contains === true, JSON.stringify(results.nativeAlbers));
}

// 5. Zero hits (point in a road) and buffered retry.
console.log('\n# 5. Zero-hit + buffered retry');
{
  // The intersections resource 404s; addresses.json parses "A and B" as an INTERSECTION match.
  const { json: ij } = await getJson('https://geocoder.api.gov.bc.ca/addresses.json?addressString=' + encodeURIComponent('Cambie St and W 12th Ave, Vancouver') + '&maxResults=1&outputSRS=4326');
  const pt = ij.features?.[0]?.geometry?.coordinates as [number, number];
  console.log('Road intersection point:', pt, ij.features?.[0]?.properties?.fullAddress, ij.features?.[0]?.properties?.matchPrecision);
  const { json: zero } = await getJson(pointQuery(pt[0], pt[1]));
  const zeroHits = zero.features?.length ?? 0;
  check('Intersection point hits no parcel', zeroHits === 0, `hits=${zeroHits}`);
  const [x, y] = proj4('EPSG:4326', 'EPSG:3005', pt);
  const buffered: Record<string, any> = {};
  for (const d of [5, 15, 30]) {
    const url = wfsUrl({ srsName: 'EPSG:4326', count: 10, propertyName: PROPS, CQL_FILTER: `DWITHIN(SHAPE,POINT(${x.toFixed(2)} ${y.toFixed(2)}),${d},meters)` });
    const r = await politeGet(url);
    let hits: number | string = 'err';
    try { hits = JSON.parse(r.text).features.length; } catch { hits = r.text.slice(0, 160); }
    buffered[`DWITHIN ${d} m (EPSG:3005)`] = { status: r.status, hits };
    console.log(`DWITHIN ${d} m (EPSG:3005): status=${r.status} hits=${hits}`);
  }
  const coq = geocoded.find((g) => g.id === 'coq');
  const [cx, cy] = proj4('EPSG:4326', 'EPSG:3005', coq.lonLat);
  for (const d of [5, 15, 30]) {
    const url = wfsUrl({ srsName: 'EPSG:4326', count: 10, propertyName: PROPS, CQL_FILTER: `DWITHIN(SHAPE,POINT(${cx.toFixed(2)} ${cy.toFixed(2)}),${d},meters)` });
    const { json } = await getJson(url);
    const names = (json.features ?? []).map((f: any) => `${f.properties.PARCEL_CLASS}/${f.properties.OWNER_TYPE}/${Math.round(f.properties.FEATURE_AREA_SQM)}m²`);
    buffered[`coq BLOCK point, DWITHIN ${d} m`] = { hits: names.length, names };
    console.log(`coq BLOCK point DWITHIN ${d} m: ${names.length} → ${names.join(', ')}`);
  }
  results.zeroHit = { roadPoint: pt, zeroHits, buffered };
}

// 6. Strata / parcel classes nearby (attributes only, no geometry).
console.log('\n# 6. Parcel classes in two small neighbourhood boxes (attributes only)');
results.classes = {};
for (const [label, [lon, lat]] of Object.entries({ 'downtown Vancouver (Art Gallery)': [-123.1204584, 49.2828744], 'Surrey Fleetwood (a park)': [-122.79497, 49.15362] })) {
  const [x, y] = proj4('EPSG:4326', 'EPSG:3005', [lon, lat]);
  const url = wfsUrl({ count: 300, propertyName: 'PARCEL_CLASS,OWNER_TYPE,PLAN_NUMBER,FEATURE_AREA_SQM', CQL_FILTER: `BBOX(SHAPE,${(x - 150).toFixed(0)},${(y - 150).toFixed(0)},${(x + 150).toFixed(0)},${(y + 150).toFixed(0)})` });
  const { json } = await getJson(url);
  const tally: Record<string, number> = {};
  const planPrefixes: Record<string, number> = {};
  for (const f of json.features ?? []) {
    const p = f.properties;
    tally[`${p.PARCEL_CLASS} / ${p.OWNER_TYPE}`] = (tally[`${p.PARCEL_CLASS} / ${p.OWNER_TYPE}`] ?? 0) + 1;
    const pre = String(p.PLAN_NUMBER ?? '').replace(/\d+$/, '');
    planPrefixes[pre] = (planPrefixes[pre] ?? 0) + 1;
  }
  results.classes[label] = { n: json.features?.length, tally, planPrefixes };
  console.log(label, json.features?.length, tally, planPrefixes);
}

// 7. Alternative endpoints for CORS (only the response headers matter here).
console.log('\n# 7. CORS on alternative DataBC endpoints');
results.altCors = {};
{
  const g = geocoded.find((x) => x.id === 'van');
  const [lon, lat] = g.lonLat;
  const [x, y] = proj4('EPSG:4326', 'EPSG:3005', g.lonLat);
  const alts: Record<string, string> = {
    'pub/wfs (2.0.0)': pointQuery(lon, lat),
    'pub/ows (2.0.0)': pointQuery(lon, lat, {}).replace('/geo/pub/wfs', '/geo/pub/ows'),
    'geo/ows (2.0.0)': pointQuery(lon, lat, {}).replace('/geo/pub/wfs', '/geo/ows'),
    'layer-scoped pub/<layer>/ows': pointQuery(lon, lat, {}).replace('/geo/pub/wfs', `/geo/pub/${LAYER}/ows`),
    'pub/wfs 1.0.0': pointQuery(lon, lat, { version: '1.0.0', typeName: LAYER, maxFeatures: 5 }),
    'JSONP text/javascript': pointQuery(lon, lat, { outputFormat: 'text/javascript', format_options: 'callback:vanshadeCb' }),
    'WMS GetFeatureInfo': `https://openmaps.gov.bc.ca/geo/pub/wms?service=WMS&version=1.3.0&request=GetFeatureInfo&layers=${LAYER}&query_layers=${LAYER}&crs=EPSG:3005&bbox=${x - 10},${y - 10},${x + 10},${y + 10}&width=21&height=21&i=10&j=10&info_format=application/json&feature_count=5`,
  };
  for (const [label, url] of Object.entries(alts)) {
    const r = await politeGet(url);
    const body = r.text.slice(0, 40).replace(/\s+/g, ' ');
    results.altCors[label] = { status: r.status, ...corsSummary(r.headers), contentType: r.headers['content-type'], bodyStart: body };
    console.log(`${label.padEnd(30)} ${r.status} ACAO=${r.headers['access-control-allow-origin'] ?? '—'}  ${r.headers['content-type']}  ${body}`);
  }
}

// 8. Checks.
console.log('\n# 8. Checks');
for (const p of results.points) {
  if (p.id === 'vic') {
    check('vic: parcel outside Metro Vancouver RD', p.rows.every((r: any) => r.REGIONAL_DISTRICT !== 'Metro Vancouver Regional District'), p.rows[0]?.REGIONAL_DISTRICT);
    continue;
  }
  check(`${p.id}: ≥1 parcel contains the geocoded point (lon,lat order)`, p.rows.some((r: any) => r.contains), `hits=${p.hits} precision=${p.matchPrecision}`);
  check(`${p.id}: REGIONAL_DISTRICT is Metro Vancouver`, p.rows.some((r: any) => r.REGIONAL_DISTRICT === 'Metro Vancouver Regional District'), p.rows[0]?.REGIONAL_DISTRICT);
}
results.stats = stats;
writeOut('parcels-results.json', results);
console.log(`\n${stats.requests} requests. CORS (pub/wfs): ${JSON.stringify(results.cors)}`);
