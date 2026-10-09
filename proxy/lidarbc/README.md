# LidarBC proxy

The BC Government's LidarBC object store (`nrs.objectstore.gov.bc.ca/gdwuts`) serves the newest
Metro Vancouver LiDAR (2024 and 2025 1 m surface and ground models) without CORS headers, so a
browser app can't read it directly. This Cloudflare Worker adds them. It is the only server-side
piece of VanShade, the one exception to its static-only design (see docs/DATA_SOURCES.md §7.1).

What it does, and nothing more:

- `GET`/`HEAD`/`OPTIONS` only, for LidarBC 1 m DSM/DEM tiles in NTS 092G
  (`/gdwuts/092/092g/<year>/(dsm|dem)/bc_092g…_xli1m_utm10_….tif`); everything else is a 404.
- Passes a single `Range: bytes=a-b` through, so the app reads only the strips it needs
  (about 10 requests and 2–3 MB per tile for a lot).
- Adds `Access-Control-Allow-Origin` for the origins in `ALLOWED_ORIGINS` (wrangler.toml), and a 403 for
  other browser origins. Requests without an `Origin` header (curl) are allowed.
- Caches the upstream files at Cloudflare's edge for a day, so repeat visits don't touch the
  government server.

## Deploy (once, free Cloudflare account)

```sh
cd proxy/lidarbc
npx wrangler login
npx wrangler deploy          # prints https://vanshade-lidarbc.<your-subdomain>.workers.dev
```

Then point the site at it: GitHub → repository Settings → Secrets and variables → Actions →
Variables → New repository variable `VITE_LIDARBC_PROXY` = that URL (no trailing slash), and re-run
the deploy workflow. Until the variable is set, the site skips LidarBC and uses the NRCan point
clouds and HRDEM.

Check it:

```sh
curl -sI -H 'Range: bytes=0-99' \
  https://vanshade-lidarbc.<your-subdomain>.workers.dev/gdwuts/092/092g/2025/dsm/bc_092g025_3_2_2_xli1m_utm10_20250425_20250826_dsm.tif
# HTTP/2 206, content-range: bytes 0-99/6725529, access-control-allow-origin: *
```

The free plan allows 100,000 requests a day; one lot uses roughly 20–40.

## Local testing

`node spike/17-proxy-local.ts` runs this same `worker.js` under Node on port 8787;
`VITE_LIDARBC_PROXY=http://localhost:8787 npx vite --port 5181` then uses it.
