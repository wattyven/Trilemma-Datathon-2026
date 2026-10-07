// Browser-origin probes. Same questions as the Node scripts, but answered under real CORS rules.
import { fromArrayBuffer } from 'geotiff';
import { probePoint, openCog, readWindow, toLcc, instrumentFetch, net, resetNet } from '../cog-probe.ts';

declare global {
  interface Window { __results: Record<string, unknown>; __done: boolean; [k: string]: unknown }
}

// Vancouver City Hall, from out/geocode.json and out/stac-results.json.
const VAN: [number, number] = [-123.1139388, 49.261317];
const DSM = 'https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-mosaic-1m/2_3-mosaic-1m-dsm.tif';
const DTM = 'https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-mosaic-1m/2_3-mosaic-1m-dtm.tif';
const LAYER = 'WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW';
const wfs = (fmt: string, extra = '') =>
  `https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=${LAYER}` +
  `&outputFormat=${encodeURIComponent(fmt)}&srsName=EPSG:4326&count=5&propertyName=PARCEL_NAME,PARCEL_CLASS,REGIONAL_DISTRICT,SHAPE` +
  `&CQL_FILTER=${encodeURIComponent(`INTERSECTS(SHAPE,SRID=4326;POINT(${VAN[0]} ${VAN[1]}))`)}${extra}`;

const results: Record<string, unknown> = { origin: location.origin, userAgent: navigator.userAgent };
window.__results = results;
const logEl = document.getElementById('log')!;
function log(name: string, ok: boolean, detail: unknown) {
  results[name] = { ok, detail };
  logEl.innerHTML += `<span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span> ${name}: ${JSON.stringify(detail)}\n`;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
}

async function probe(name: string, fn: () => Promise<unknown>) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    log(name, true, { ms: Math.round(performance.now() - t0), ...(detail as object) });
  } catch (e) {
    log(name, false, { ms: Math.round(performance.now() - t0), error: String(e) });
  }
}

function pointInRing([x, y]: number[], ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

let cbSeq = 0;
/** Plain JSONP: a <script> tag in this document. */
function jsonp(urlFor: (cb: string) => string, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const cb = `__vsCb${++cbSeq}`;
    const s = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('JSONP timeout')); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); delete window[cb]; s.remove(); };
    window[cb] = (data: unknown) => { cleanup(); resolve(data); };
    s.onerror = () => { cleanup(); reject(new Error('JSONP script load error')); };
    s.src = urlFor(cb);
    document.head.appendChild(s);
  });
}

/** JSONP isolated in a sandboxed iframe (opaque origin), so remote script can't touch our page. */
function sandboxedJsonp(url: string, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.sandbox.add('allow-scripts');
    iframe.style.display = 'none';
    const timer = setTimeout(() => { cleanup(); reject(new Error('sandboxed JSONP timeout')); }, timeoutMs);
    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== iframe.contentWindow) return;
      cleanup();
      ev.data?.error ? reject(new Error(ev.data.error)) : resolve(ev.data.payload);
    };
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', onMsg); iframe.remove(); };
    window.addEventListener('message', onMsg);
    const src = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    iframe.srcdoc = `<script>window.vsCb=function(d){parent.postMessage({payload:d},'*')}<\/script>` +
      `<script src="${src}" onerror="parent.postMessage({error:'load error'},'*')"><\/script>`;
    document.body.appendChild(iframe);
  });
}

async function run() {
  instrumentFetch();

  await probe('geocoder fetch (CORS)', async () => {
    const r = await fetch('https://geocoder.api.gov.bc.ca/addresses.json?addressString=453%20W%2012th%20Ave%20Vancouver&maxResults=1&locationDescriptor=parcelPoint&outputSRS=4326');
    const j = await r.json();
    return { status: r.status, fullAddress: j.features[0].properties.fullAddress, coords: j.features[0].geometry.coordinates };
  });

  await probe('geocoder autocomplete fetch', async () => {
    const r = await fetch('https://geocoder.api.gov.bc.ca/addresses.json?addressString=4949%20Cana&autoComplete=true&maxResults=5&brief=true&outputSRS=4326&matchPrecisionNot=STREET,BLOCK,INTERSECTION,LOCALITY,PROVINCE');
    const j = await r.json();
    return { status: r.status, rows: j.features.map((f: any) => f.properties.fullAddress) };
  });

  await probe('WFS fetch application/json (CORS)', async () => {
    const r = await fetch(wfs('application/json'));
    const j = await r.json();
    return { status: r.status, hits: j.features.length };
  });

  // The DataBC gateway derives Access-Control-Allow-Origin from the Referer header, so a
  // no-referrer policy breaks CORS. This probe is expected to FAIL.
  await probe('WFS fetch with referrerPolicy no-referrer (expected to fail)', async () => {
    const r = await fetch(wfs('application/json'), { referrerPolicy: 'no-referrer' });
    const j = await r.json();
    return { status: r.status, hits: j.features.length };
  });

  await probe('WFS JSONP <script>', async () => {
    const j = await jsonp((cb) => wfs('text/javascript', `&format_options=callback:${cb}`));
    const f = j.features[0];
    return { hits: j.features.length, parcel: f.properties.PARCEL_NAME, rd: f.properties.REGIONAL_DISTRICT, contains: pointInRing(VAN, f.geometry.coordinates[0]) };
  });

  await probe('WFS JSONP in sandboxed iframe', async () => {
    const j = await sandboxedJsonp(wfs('text/javascript', '&format_options=callback:vsCb'));
    const f = j.features[0];
    return { hits: j.features.length, parcel: f.properties.PARCEL_NAME, contains: pointInRing(VAN, f.geometry.coordinates[0]) };
  });

  await probe('STAC search fetch', async () => {
    const r = await fetch(`https://datacube.services.geo.ca/stac/api/search?collections=hrdem-mosaic-1m&limit=1&intersects=${encodeURIComponent(JSON.stringify({ type: 'Point', coordinates: VAN }))}`);
    const j = await r.json();
    return { status: r.status, item: j.features[0].id, dsm: j.features[0].assets.dsm.href };
  });

  await probe('HRDEM project extent GeoJSON (S3)', async () => {
    const r = await fetch('https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/BC-Lower_Mainland_2016-1m-extent.geojson');
    const j = await r.json();
    return { status: r.status, type: j.type, geom: j.geometry.type };
  });

  // Realistic first load: DSM + DTM opened and read in parallel, 441×441 m window.
  await probe('COG parallel cold load DSM+DTM 441 m (geotiff.js)', async () => {
    resetNet();
    const xy = toLcc(VAN);
    const [a, b] = await Promise.all([DSM, DTM].map(async (u) => {
      const { image, ms } = await openCog(u);
      const w = await readWindow(image, xy, 220);
      return { openMs: ms, readMs: w.ms, size: `${w.width}×${w.height}`, centre: +w.data[(w.height >> 1) * w.width + (w.width >> 1)].toFixed(2) };
    }));
    return { dsm: a, dtm: b, requests: net.requests, mib: +(net.bytes / 1048576).toFixed(2), dsmMinusDtm: +(a.centre - b.centre).toFixed(2) };
  });

  await probe('COG detailed probe (sequential, cold)', async () => probePoint(DSM, DTM, VAN, 220));

  await probe('WCS final URL GetCoverage 64 m (CORS)', async () => {
    const [cx, cy] = toLcc(VAN);
    const x0 = Math.floor(cx) - 32, y0 = Math.floor(cy) - 32;
    const r = await fetch(`https://datacube.services.geo.ca/wrapper/ogc/elevation-hrdem-mosaic?service=WCS&version=1.1.1&request=GetCoverage&identifier=dsm&format=image/geotiff&BoundingBox=${x0 + 0.5},${y0 + 0.5},${x0 + 63.5},${y0 + 63.5},urn:ogc:def:crs:EPSG::3979&GridBaseCRS=urn:ogc:def:crs:EPSG::3979&GridOffsets=1,-1`);
    const img = await (await fromArrayBuffer(await r.arrayBuffer())).getImage();
    const ras = (await img.readRasters({ interleave: true })) as unknown as Float32Array;
    return { status: r.status, size: `${img.getWidth()}×${img.getHeight()}`, resolution: img.getResolution(), first: +ras[0].toFixed(2) };
  });

  await probe('WCS spec URL (308 redirect) GetCapabilities', async () => {
    const r = await fetch('https://datacube.services.geo.ca/ows/elevation?service=WCS&request=GetCapabilities');
    return { status: r.status, redirected: r.redirected, url: r.url };
  });

  window.__done = true;
}

run();
