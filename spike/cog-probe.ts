// Isomorphic COG probe: runs in Node (04-cog-read.ts) and in Chromium (browser/main.ts).
import { fromUrl, type GeoTIFFImage } from 'geotiff';
import proj4 from 'proj4';

export const EPSG3979_DEF =
  '+proj=lcc +lat_0=49 +lon_0=-95 +lat_1=49 +lat_2=77 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
proj4.defs('EPSG:3979', EPSG3979_DEF);

export const toLcc = (lonLat: [number, number]) => proj4('EPSG:4326', 'EPSG:3979', lonLat) as [number, number];

/** Grid convergence: angle (deg, clockwise) from grid north to true north at lon/lat. */
export function convergenceDeg(lon: number, lat: number): number {
  const a = toLcc([lon, lat]);
  const b = toLcc([lon, lat + 1e-4]);
  return (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
}

export interface NetLog { requests: number; bytes: number; ranges: string[] }
export const net: NetLog = { requests: 0, bytes: 0, ranges: [] };
let instrumented = false;

/** Wrap global fetch once so every geotiff range request is counted. */
export function instrumentFetch() {
  if (instrumented) return;
  instrumented = true;
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await orig(input, init);
    const range = new Headers(init?.headers).get('range');
    const len = Number(res.headers.get('content-length') ?? 0);
    net.requests++;
    net.bytes += len;
    if (range) net.ranges.push(`${range} → ${res.status} ${len}B`);
    return res;
  };
}

export function resetNet() {
  net.requests = 0;
  net.bytes = 0;
  net.ranges = [];
}

const t = () => performance.now();

export async function openCog(url: string) {
  const t0 = t();
  const tiff = await fromUrl(url, { cacheSize: 200 });
  const image = await tiff.getImage();
  return { tiff, image, ms: Math.round(t() - t0) };
}

export async function describe(image: GeoTIFFImage, imageCount: number) {
  const fd = image.fileDirectory;
  const get = (tag: string) => (fd.hasTag(tag) ? fd.getValue(tag) : undefined);
  return {
    width: image.getWidth(),
    height: image.getHeight(),
    tileWidth: image.getTileWidth(),
    tileHeight: image.getTileHeight(),
    compression: get('Compression'),
    predictor: get('Predictor'),
    sampleFormat: get('SampleFormat'),
    bitsPerSample: get('BitsPerSample'),
    nodata: image.getGDALNoData(),
    origin: image.getOrigin(),
    resolution: image.getResolution(),
    imageCount,
  };
}

/** Read a square window of half-size `halfM` metres around an EPSG:3979 point. */
export async function readWindow(image: GeoTIFFImage, xy: [number, number], halfM: number) {
  const [x0, y0] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  const col = Math.floor((xy[0] - x0) / rx);
  const row = Math.floor((xy[1] - y0) / ry);
  const h = Math.round(halfM / Math.abs(rx));
  const window: [number, number, number, number] = [col - h, row - h, col + h + 1, row + h + 1];
  const t0 = t();
  const ras = (await image.readRasters({ window, samples: [0], interleave: true })) as unknown as Float32Array;
  return { data: ras, width: 2 * h + 1, height: 2 * h + 1, window, centre: { col, row }, ms: Math.round(t() - t0) };
}

export function stats(data: Float32Array, nodata: number | null) {
  let n = 0, nd = 0, min = Infinity, max = -Infinity, sum = 0;
  for (const v of data) {
    if (v === nodata || Number.isNaN(v) || v < -1000) { nd++; continue; }
    n++; sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { valid: n, nodata: nd, min: +min.toFixed(2), max: +max.toFixed(2), mean: +(sum / Math.max(n, 1)).toFixed(2) };
}

/** What the app will actually do on first load: open DSM + DTM and read the window, in parallel. */
export async function parallelLoad(dsmUrl: string, dtmUrl: string, lonLat: [number, number], halfM = 220) {
  instrumentFetch();
  resetNet();
  const xy = toLcc(lonLat);
  const t0 = t();
  const [dsm, dtm] = await Promise.all([dsmUrl, dtmUrl].map(async (u) => {
    const { image } = await openCog(u);
    return readWindow(image, xy, halfM);
  }));
  return { ms: Math.round(t() - t0), requests: net.requests, mib: +(net.bytes / 1048576).toFixed(2), size: `${dsm.width}×${dsm.height}`, dtmSize: `${dtm.width}×${dtm.height}` };
}

/** Full probe for one point: open DSM+DTM, read a centre 3×3 and a lot+buffer window from each. */
export async function probePoint(dsmUrl: string, dtmUrl: string, lonLat: [number, number], halfM = 220) {
  instrumentFetch();
  const xy = toLcc(lonLat);
  const out: Record<string, unknown> = { lonLat, xy3979: xy.map((v) => +v.toFixed(2)), convergenceDeg: +convergenceDeg(...lonLat).toFixed(3) };
  for (const [kind, url] of [['dsm', dsmUrl], ['dtm', dtmUrl]] as const) {
    resetNet();
    const { tiff, image, ms: openMs } = await openCog(url);
    const openNet = { ...net, ranges: [...net.ranges] };
    const desc = await describe(image, await tiff.getImageCount());
    resetNet();
    const centre = await readWindow(image, xy, 1);
    const centreNet = { requests: net.requests, bytes: net.bytes };
    resetNet();
    const win = await readWindow(image, xy, halfM);
    const winNet = { requests: net.requests, bytes: net.bytes };
    resetNet();
    const win2 = await readWindow(image, xy, halfM); // warm: same window again
    const warmNet = { requests: net.requests, bytes: net.bytes };
    out[kind] = {
      desc,
      open: { ms: openMs, requests: openNet.requests, bytes: openNet.bytes, ranges: openNet.ranges.slice(0, 6) },
      centre3x3: { values: Array.from(centre.data).map((v) => +v.toFixed(2)), ms: centre.ms, ...centreNet },
      window: { size: `${win.width}×${win.height}`, ms: win.ms, ...winNet, stats: stats(win.data, desc.nodata) },
      warm: { ms: win2.ms, ...warmNet },
    };
  }
  const dsmC = (out.dsm as any).centre3x3.values[4];
  const dtmC = (out.dtm as any).centre3x3.values[4];
  out.dsmMinusDtmAtPoint = +(dsmC - dtmC).toFixed(2);
  return out;
}
