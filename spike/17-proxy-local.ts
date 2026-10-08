// Runs proxy/lidarbc/worker.js under Node (no Cloudflare account needed) so the app's LidarBC path
// can be tested locally:
//   node spike/17-proxy-local.ts            # proxy on http://localhost:8787
//   VITE_LIDARBC_PROXY=http://localhost:8787 npx vite --port 5181
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import worker from '../proxy/lidarbc/worker.js';

const PORT = Number(process.env.PORT ?? 8787);
const env = { ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? '' }; // empty: any origin

createServer(async (req, res) => {
  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers });
    const response: Response = await worker.fetch(request, env);
    const out: Record<string, string> = {};
    response.headers.forEach((v, k) => (out[k] = v));
    res.writeHead(response.status, out);
    if (response.body && req.method !== 'HEAD') Readable.fromWeb(response.body as any).pipe(res);
    else res.end();
    console.log(response.status, req.method, req.headers.range ?? '', req.url);
  } catch (e) {
    console.error(e);
    res.writeHead(502).end(String(e));
  }
}).listen(PORT, () => console.log(`LidarBC proxy (local) on http://localhost:${PORT}`));
