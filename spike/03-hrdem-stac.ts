// NRCan HRDEM STAC probe: mosaic items per address, DSM/DTM hrefs and grids, vintage.
import { getJson, politeGet, corsSummary, readOut, writeOut, writeSample, check, pointInGeometry, stats } from './lib.ts';
import { convergenceDeg, toLcc } from './cog-probe.ts';

const STAC = 'https://datacube.services.geo.ca/stac/api';
const geocoded: any[] = readOut('geocode.json');
const results: Record<string, any> = { points: [] };

const search = (collection: string, lonLat: number[], limit = 10) =>
  `${STAC}/search?collections=${collection}&limit=${limit}&intersects=${encodeURIComponent(JSON.stringify({ type: 'Point', coordinates: lonLat }))}`;

const vrtInfo = (xml: string) => ({
  size: xml.match(/rasterXSize="(\d+)" rasterYSize="(\d+)"/)?.slice(1).map(Number),
  geoTransform: xml.match(/<GeoTransform>([^<]+)<\/GeoTransform>/)?.[1].split(',').map((s) => Number(s.trim())),
  nodata: xml.match(/<NoDataValue>([^<]+)<\/NoDataValue>/)?.[1],
  dataType: xml.match(/dataType="(\w+)"/)?.[1],
  epsg: xml.match(/AUTHORITY\["EPSG","(\d+)"\]\]$/m)?.[1] ?? xml.match(/AUTHORITY\["EPSG","(\d+)"\]\]<\/SRS>/)?.[1],
});

const vrtCache = new Map<string, ReturnType<typeof vrtInfo>>();
async function getVrt(url: string) {
  if (!vrtCache.has(url)) vrtCache.set(url, vrtInfo((await politeGet(url)).text));
  return vrtCache.get(url)!;
}

for (const g of geocoded) {
  const lonLat = g.lonLat as [number, number];
  const { r, json } = await getJson(search('hrdem-mosaic-1m', lonLat));
  if (g.id === 'van') {
    results.cors = corsSummary(r.headers);
    writeSample('stac-mosaic-item.json', { ...json, features: json.features.map((f: any) => ({ ...f, links: f.links?.slice(0, 2) })) });
  }
  const items = (json.features ?? []).map((f: any) => ({
    id: f.id,
    datetime: f.properties.datetime,
    epsg: f.properties['proj:epsg'],
    shape: f.properties['proj:shape'],
    transform: f.properties['proj:transform'],
    dsm: f.assets.dsm?.href,
    dtm: f.assets.dtm?.href,
    dsmVrt: f.assets['dsm-vrt']?.href,
    dtmVrt: f.assets['dtm-vrt']?.href,
  }));
  const item = items[0];
  let sameGrid: boolean | null = null, dsmVrt, dtmVrt;
  if (item?.dsmVrt && item?.dtmVrt) {
    dsmVrt = await getVrt(item.dsmVrt);
    dtmVrt = await getVrt(item.dtmVrt);
    sameGrid = JSON.stringify([dsmVrt.size, dsmVrt.geoTransform, dsmVrt.nodata]) === JSON.stringify([dtmVrt.size, dtmVrt.geoTransform, dtmVrt.nodata]);
  }

  // Vintage: acquisition projects whose footprint contains the point, newest first.
  const { json: lj } = await getJson(search('hrdem-lidar', lonLat, 20));
  const projects = (lj.features ?? [])
    .map((f: any) => ({
      id: f.id,
      datetime: f.properties.datetime,
      containsPoint: pointInGeometry(lonLat, f.geometry),
      dsm: f.assets.dsm?.href,
      dtm: f.assets.dtm?.href,
    }))
    .sort((a: any, b: any) => b.datetime.localeCompare(a.datetime));
  // STAC item geometry over-claims coverage; the per-project extent GeoJSON is the real footprint.
  for (const pr of projects) {
    const url = `https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/${pr.id}-extent.geojson`;
    const { r: er, json: ej } = await getJson(url);
    pr.extentKiB = Math.round(er.text.length / 1024);
    pr.extentContains = pointInGeometry(lonLat, ej.geometry ?? ej.features?.[0]?.geometry);
  }
  if (g.id === 'van') writeSample('stac-lidar-projects.json', { numberMatched: lj.numberMatched, features: lj.features.map((f: any) => ({ id: f.id, properties: f.properties, assets: Object.keys(f.assets) })) });

  const row = {
    id: g.id,
    lonLat,
    xy3979: toLcc(lonLat).map((v) => +v.toFixed(1)),
    convergenceDeg: +convergenceDeg(...lonLat).toFixed(3),
    mosaicItems: items.map((i: any) => i.id),
    mosaicDatetime: item?.datetime,
    dsm: item?.dsm,
    dtm: item?.dtm,
    sameGrid,
    dsmVrt,
    projects,
    newestContainingProject: projects.find((p: any) => p.containsPoint)?.id ?? null,
    vintageProject: projects.find((p: any) => p.extentContains)?.id ?? null,
    vintageDate: projects.find((p: any) => p.extentContains)?.datetime?.slice(0, 10) ?? null,
  };
  results.points.push(row);
  console.log(`${g.id.padEnd(7)} mosaic=${row.mosaicItems.join(',') || '—'} sameGrid=${sameGrid} γ=${row.convergenceDeg}° vintage=${row.vintageProject} (${row.vintageDate}) [${projects.map((p: any) => `${p.id.replace(/-1m$/, '')} ${p.datetime.slice(0, 10)} stac=${p.containsPoint} extent=${p.extentContains}`).join('; ')}]`);
}

console.log('\n# Checks');
for (const p of results.points) {
  if (p.id === 'vic') continue;
  check(`${p.id}: mosaic item found`, p.mosaicItems.length > 0);
  check(`${p.id}: DSM and DTM VRTs share size, transform, nodata`, p.sameGrid === true);
  check(`${p.id}: EPSG 3979`, String(p.dsmVrt?.epsg) === '3979', String(p.dsmVrt?.epsg));
}
const conv = results.points.map((p: any) => p.convergenceDeg);
console.log(`Convergence range across test points: ${Math.min(...conv)}° … ${Math.max(...conv)}°`);
results.tiles = [...new Set(results.points.flatMap((p: any) => p.mosaicItems))];
results.stats = stats;
writeOut('stac-results.json', results);
console.log(`Mosaic tiles touched: ${results.tiles.join(', ')}; ${stats.requests} requests. CORS: ${JSON.stringify(results.cors)}`);
