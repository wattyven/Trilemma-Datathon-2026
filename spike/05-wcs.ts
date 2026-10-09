// WCS GetCoverage probe, compared against the COG window at the same place.
import { fromArrayBuffer } from 'geotiff';
import { readOut, writeOut, check, corsSummary, ORIGIN, UA } from './lib.ts';
import { openCog, readWindow, toLcc } from './cog-probe.ts';

// The documented https://datacube.services.geo.ca/ows/elevation 308-redirects here, and the redirect
// itself carries no CORS header, so browsers must call the final URL directly.
const DOCUMENTED_WCS = 'https://datacube.services.geo.ca/ows/elevation';
const WCS = 'https://datacube.services.geo.ca/wrapper/ogc/elevation-hrdem-mosaic';

const stac = readOut('stac-results.json');
const p = stac.points.find((x: any) => x.id === 'van');
const [cx, cy] = toLcc(p.lonLat);
// Snap to the 1 m grid so WCS and COG pixels line up: a 64×64 m box.
const x0 = Math.floor(cx) - 32, y0 = Math.floor(cy) - 32, x1 = x0 + 64, y1 = y0 + 64;
const results: Record<string, any> = { box3979: [x0, y0, x1, y1] };

async function get(url: string, redirect: RequestRedirect = 'follow') {
  const t0 = performance.now();
  const res = await fetch(url, { headers: { Origin: ORIGIN, 'User-Agent': UA }, redirect });
  const buf = await res.arrayBuffer();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, ms: Math.round(performance.now() - t0), headers, buf };
}

// Redirect behaviour of the documented URL.
{
  const r = await get(`${DOCUMENTED_WCS}?service=WCS&request=GetCapabilities`, 'manual');
  results.documentedUrlRedirect = { status: r.status, location: r.headers.location, ...corsSummary(r.headers) };
  console.log('Documented URL:', results.documentedUrlRedirect);
}

const variants: Record<string, string> = {
  'WCS 2.0.1 subset': `${WCS}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=dsm&format=image/geotiff&subset=x(${x0},${x1})&subset=y(${y0},${y1})&subsettingCrs=http://www.opengis.net/def/crs/EPSG/0/3979&outputCrs=http://www.opengis.net/def/crs/EPSG/0/3979`,
  'WCS 1.1.1 BoundingBox': `${WCS}?service=WCS&version=1.1.1&request=GetCoverage&identifier=dsm&format=image/geotiff&BoundingBox=${x0},${y0},${x1},${y1},urn:ogc:def:crs:EPSG::3979&GridBaseCRS=urn:ogc:def:crs:EPSG::3979&GridOffsets=1,-1`,
  // WCS 1.1 BoundingBox is in pixel-centre terms: inset by half a pixel to get the native 1 m grid.
  'WCS 1.1.1 BoundingBox (pixel centres)': `${WCS}?service=WCS&version=1.1.1&request=GetCoverage&identifier=dsm&format=image/geotiff&BoundingBox=${x0 + 0.5},${y0 + 0.5},${x1 - 0.5},${y1 - 0.5},urn:ogc:def:crs:EPSG::3979&GridBaseCRS=urn:ogc:def:crs:EPSG::3979&GridOffsets=1,-1`,
  'WCS 1.1.1 lot+buffer 441 m (timing)': `${WCS}?service=WCS&version=1.1.1&request=GetCoverage&identifier=dsm&format=image/geotiff&BoundingBox=${Math.floor(cx) - 220},${Math.floor(cy) - 220},${Math.floor(cx) + 220},${Math.floor(cy) + 220},urn:ogc:def:crs:EPSG::3979&GridBaseCRS=urn:ogc:def:crs:EPSG::3979&GridOffsets=1,-1`,
  'WCS 1.0.0 bbox': `${WCS}?service=WCS&version=1.0.0&request=GetCoverage&coverage=dsm&format=image/geotiff&crs=EPSG:3979&bbox=${x0},${y0},${x1},${y1}&width=64&height=64`,
};

const { image } = await openCog(p.dsm);
const cog = await readWindow(image, [x0 + 32, y1 - 32], 32); // 65×65 window whose top-left pixel is (x0, y1)
const cogAt = (col: number, row: number) => cog.data[row * cog.width + col];

results.variants = {};
for (const [label, url] of Object.entries(variants)) {
  const r = await get(url);
  const ct = r.headers['content-type'] ?? '';
  const row: Record<string, any> = { status: r.status, ms: r.ms, contentType: ct, bytes: r.buf.byteLength, ...corsSummary(r.headers) };
  if (r.status === 200 && /tiff/i.test(ct)) {
    try {
      const tiff = await fromArrayBuffer(r.buf);
      const img = await tiff.getImage();
      const ras = (await img.readRasters({ interleave: true })) as unknown as Float32Array;
      const w = img.getWidth(), h = img.getHeight();
      const [ox, oy] = img.getOrigin();
      // Compare WCS pixel (i, j) with the COG pixel at the same 3979 coordinate.
      let maxDiff = 0, compared = 0;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const col = Math.round(ox - x0) + i, rowIdx = Math.round(y1 - oy) + j;
        if (col < 0 || rowIdx < 0 || col >= cog.width || rowIdx >= cog.height) continue;
        maxDiff = Math.max(maxDiff, Math.abs(ras[j * w + i] - cogAt(col, rowIdx)));
        compared++;
      }
      Object.assign(row, {
        size: `${w}×${h}`, origin: [ox, oy], resolution: img.getResolution(), sampleFormat: img.fileDirectory.getValue('SampleFormat'),
        bitsPerSample: img.fileDirectory.getValue('BitsPerSample'), sample: Array.from(ras.slice(0, 4)).map((v) => +v.toFixed(2)),
        compared, maxDiffVsCog: +maxDiff.toFixed(3),
      });
    } catch (e) {
      row.parseError = String(e).slice(0, 200);
    }
  } else {
    row.body = new TextDecoder().decode(r.buf.slice(0, 400));
  }
  results.variants[label] = row;
  console.log(label, JSON.stringify(row));
}

console.log('\n# Checks');
const ok = Object.values(results.variants).some((v: any) => v.maxDiffVsCog !== undefined && v.maxDiffVsCog < 0.01);
check('Some WCS GetCoverage variant returns Float32 elevations identical to the COG', ok);
check('WCS final URL sends ACAO for the github.io origin', Object.values(results.variants).some((v: any) => v.acao === ORIGIN || v.acao === '*'));
check('Documented WCS URL redirect carries ACAO (needed for browsers to follow it)', !!results.documentedUrlRedirect.acao, `status ${results.documentedUrlRedirect.status}`);
writeOut('wcs-results.json', results);
