// VanShade LidarBC proxy: a Cloudflare Worker that adds CORS headers to the BC Government's
// LidarBC object store, which serves its 1 m DSM/DEM GeoTIFFs without them. Read-only, GET/HEAD
// of LidarBC raster tiles only, Range passed through, responses cached at the edge for a day.
// Deploy: see README.md in this folder.

const UPSTREAM = 'https://nrs.objectstore.gov.bc.ca';

// Only LidarBC 1 m DSM and DEM tiles in NTS 092G (Metro Vancouver), e.g.
// /gdwuts/092/092g/2025/dsm/bc_092g025_3_2_2_xli1m_utm10_20250425_20250826_dsm.tif
const ALLOWED_PATH = /^\/gdwuts\/092\/092g\/20\d\d\/(dsm|dem)\/bc_092g\d{3}_[1-4]_[1-4]_[1-4]_xli1m_utm10_\d{8}_\d{8}(_dsm)?\.tif$/;

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
const DAY = 86_400;

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return '*'; // not a browser (curl, tests): nothing to protect with CORS
  const list = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
    'Access-Control-Max-Age': String(DAY),
    Vary: 'Origin',
  };
}

export default {
  async fetch(request, env = {}) {
    const origin = allowedOrigin(request, env);
    if (!origin) return new Response('Origin not allowed', { status: 403 });
    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: cors });

    const url = new URL(request.url);
    if (url.search || !ALLOWED_PATH.test(url.pathname)) return new Response('Not found', { status: 404, headers: cors });

    const headers = {};
    const range = request.headers.get('Range');
    if (range) {
      if (!/^bytes=\d+-\d+$/.test(range)) return new Response('Only single byte ranges', { status: 416, headers: cors });
      headers.Range = range;
    }
    // On Cloudflare, `cf` caches the upstream object at the edge (ranges are served from it).
    const upstream = await fetch(UPSTREAM + url.pathname, { method: request.method, headers, cf: { cacheTtl: DAY, cacheEverything: true } });

    const out = new Headers(cors);
    for (const h of PASS_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    out.set('Cache-Control', `public, max-age=${DAY}`);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
