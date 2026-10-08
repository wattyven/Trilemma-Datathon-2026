// Probe LidarBC 1 m DSM/DEM GeoTIFFs: layout, CRS and vertical datum GeoKeys, nodata, and how many
// bytes a lot-sized window costs. Plain Node (the bucket has no CORS; Node doesn't care).
//   node spike/16-lidarbc-probe.ts
import { fromUrl } from 'geotiff';

const BASE = 'https://nrs.objectstore.gov.bc.ca/gdwuts/092/092g/';
const TILES: [string, number, string][] = [
  ['092g025_3_2_2', 2025, ''], // Vancouver City Hall
  ['092g016_4_4_3', 2024, ''], // Surrey
];
const index = (await import('../src/elevation/hires-index.json', { with: { type: 'json' } })).default as any;

for (const [id] of TILES) {
  const [year, dates, hasDem] = index.lidarbc.tiles[id][0];
  for (const kind of ['dsm', ...(hasDem ? ['dem'] : [])]) {
    const url = `${BASE}${year}/${kind}/bc_${id}_xli1m_utm10_${dates}${kind === 'dsm' ? '_dsm' : ''}.tif`;
    let bytes = 0, requests = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any) => {
      const r = await origFetch(input, init);
      requests++;
      bytes += Number(r.headers.get('content-length') ?? 0);
      return r;
    };
    const t0 = performance.now();
    const tiff = await fromUrl(url);
    const img = await tiff.getImage();
    const fd = img.fileDirectory as any;
    const geo = img.getGeoKeys();
    console.log(`\n${kind.toUpperCase()} ${year} ${id}\n  ${url}`);
    console.log(`  ${img.getWidth()}×${img.getHeight()}, res ${img.getResolution().slice(0, 2).join(', ')}, origin ${img.getOrigin().slice(0, 2).join(', ')}, bbox ${img.getBoundingBox().map((v) => v.toFixed(1)).join(', ')}`);
    console.log(`  tiled ${img.isTiled}, tile/strip ${img.getTileWidth()}×${img.getTileHeight()}, samples ${img.getSamplesPerPixel()}, bits ${fd.BitsPerSample}, format ${fd.SampleFormat}, compression ${fd.Compression}, predictor ${fd.Predictor ?? '-'}, nodata ${img.getGDALNoData()}`);
    console.log(`  overviews ${await tiff.getImageCount() - 1}; geokeys ${JSON.stringify(geo)}`);
    // A 450 m window (a lot + 200 m buffer) near the tile centre.
    const [w, h] = [img.getWidth(), img.getHeight()];
    const win = [Math.floor(w / 2) - 225, Math.floor(h / 2) - 225, Math.floor(w / 2) + 225, Math.floor(h / 2) + 225];
    const before = bytes;
    const [data] = (await img.readRasters({ window: win })) as unknown as Float32Array[];
    const vals = Array.from(data!).filter((v) => v > -1000);
    vals.sort((a, b) => a - b);
    console.log(`  450 m window: ${((bytes - before) / 1e6).toFixed(2)} MB; z p5 ${vals[Math.floor(vals.length * 0.05)]?.toFixed(2)}, p50 ${vals[Math.floor(vals.length / 2)]?.toFixed(2)}, p95 ${vals[Math.floor(vals.length * 0.95)]?.toFixed(2)}; nodata ${(100 * (1 - vals.length / data!.length)).toFixed(1)}%`);
    console.log(`  total ${requests} requests, ${(bytes / 1e6).toFixed(2)} MB, ${Math.round(performance.now() - t0)} ms`);
    globalThis.fetch = origFetch;
  }
}
