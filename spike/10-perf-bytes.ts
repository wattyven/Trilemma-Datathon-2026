// Phase 4 performance: bytes and time to read the DSM window, the DTM over the whole window
// (Phase 2/3 behaviour) and the DTM only around the lot (Phase 4), for the test lots.
import proj4 from 'proj4';
import { getJson, writeOut } from './lib.ts';
import { instrumentFetch, net, openCog, readWindow, resetNet } from './cog-probe.ts';

proj4.defs('EPSG:3005', '+proj=aea +lat_0=45 +lon_0=-126 +lat_1=50 +lat_2=58.5 +x_0=1000000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
proj4.defs('EPSG:3979', '+proj=lcc +lat_0=49 +lon_0=-95 +lat_1=49 +lat_2=77 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
instrumentFetch();

const DSM = 'https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-mosaic-1m/2_3-mosaic-1m-dsm.tif';
const DTM = DSM.replace('-dsm.tif', '-dtm.tif');
const lots: Record<string, string> = {
  van: '453 W 12th Ave, Vancouver', cnv: '141 W 14th St, North Vancouver', dnv: '355 W Queens Rd, North Vancouver',
  mr: '11995 Haney Pl, Maple Ridge', cl: '20399 Douglas Cres, Langley', tol: '20338 65 Ave, Langley',
  coq: '3000 Guildford Way, Coquitlam', strata: '3871 North Fraser Way, Burnaby',
};
const geo = (q: string) => `https://geocoder.api.gov.bc.ca/addresses.json?${new URLSearchParams({ addressString: q, maxResults: '1', outputSRS: '4326', locationDescriptor: 'parcelPoint' })}`;
const wfs = (cql: string) => `https://openmaps.gov.bc.ca/geo/pub/wfs?${new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: 'WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW', srsName: 'EPSG:4326', count: '1', outputFormat: 'application/json', CQL_FILTER: cql })}`;

const rows: Record<string, unknown>[] = [];
let totalOld = 0, totalNew = 0;
for (const [id, q] of Object.entries(lots)) {
  const ll = (await getJson(geo(q))).json.features[0].geometry.coordinates as number[];
  let f = (await getJson(wfs(`INTERSECTS(SHAPE,SRID=4326;POINT(${ll[0]} ${ll[1]}))`))).json.features[0];
  if (!f) {
    const [x, y] = proj4('EPSG:4326', 'EPSG:3005', ll) as number[];
    f = (await getJson(wfs(`DWITHIN(SHAPE,POINT(${x!.toFixed(2)} ${y!.toFixed(2)}),15,meters)`))).json.features[0];
  }
  const ring: number[][] = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
  const xy = ring.map((p) => proj4('EPSG:4326', 'EPSG:3979', p) as number[]);
  const xs = xy.map((p) => p[0]!), ys = xy.map((p) => p[1]!);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const half = (m: number) => Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2 + m;

  const measure = async (url: string, halfM: number) => {
    resetNet();
    const t0 = performance.now();
    const { image } = await openCog(url); // fresh instance: no tile cache shared between rows
    await readWindow(image, [cx, cy], halfM);
    return { mib: +(net.bytes / 1048576).toFixed(2), ms: Math.round(performance.now() - t0), requests: net.requests };
  };
  const dsm = await measure(DSM, half(200));
  const dtmFull = await measure(DTM, half(200));
  const dtmNear = await measure(DTM, half(44));
  const oldMib = dsm.mib + dtmFull.mib, newMib = dsm.mib + dtmNear.mib;
  totalOld += oldMib;
  totalNew += newMib;
  rows.push({ id, dsm, dtmFull, dtmNear, savedPct: Math.round((100 * (oldMib - newMib)) / oldMib) });
  console.log(`${id.padEnd(7)} DSM ${dsm.mib} MiB | DTM whole window ${dtmFull.mib} MiB → near lot ${dtmNear.mib} MiB | total ${oldMib.toFixed(1)} → ${newMib.toFixed(1)} MiB (−${Math.round((100 * (oldMib - newMib)) / oldMib)}%)`);
}
console.log(`\nAll lots: ${totalOld.toFixed(1)} → ${totalNew.toFixed(1)} MiB (−${Math.round((100 * (totalOld - totalNew)) / totalOld)}%)`);
writeOut('perf-bytes.json', rows);
