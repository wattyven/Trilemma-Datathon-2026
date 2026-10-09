# VanShade developer guide

Static sun and shade mapper for Metro Vancouver yards. Deployed to GitHub Pages at https://wattyven.github.io/VanShade/ with no backend; all compute happens in the browser. The one exception is the optional LidarBC CORS proxy (`proxy/lidarbc/`, a Cloudflare Worker you deploy yourself). Without `VITE_LIDARBC_PROXY` the site is fully static.

Verified endpoints and data quirks are in [`DATA_SOURCES.md`](DATA_SOURCES.md). Read it before touching any data source.

## Commands

```sh
npm run dev         # http://localhost:5173/VanShade/ (note the base path)
npm test            # vitest (node env, fetch stubbed)
npm run test:tz     # the suite under TZ=UTC and TZ=Asia/Tokyo (what CI runs)
npm run typecheck   # tsc --noEmit, strict
npm run build       # → dist/
npm run smoke       # Playwright smoke test (e2e/); BASE_URL=<url> for a deployed site, default http://localhost:5180/VanShade/
node spike/07-deployed-check.ts <url>   # the longer UI check with timings and screenshots (cd spike && npm i first)
node spike/11-screenshots.ts <url>      # README screenshots (docs/screenshots/)
npx vitest run --config spike/vitest.live.config.ts   # live checks against the real data services (spike/*.live.test.ts)
node spike/14-hires-compare.ts <url>    # first vs refined surface, with timings (ELEV=hrdem,copc,lidarbc,auto LOTS=…)
node spike/17-proxy-local.ts            # the LidarBC proxy under Node on :8787; then VITE_LIDARBC_PROXY=http://localhost:8787 npx vite --port 5181
node spike/18-imagery-check.ts          # every municipal aerial-photo service: CORS, size, not blank
node spike/21-elevation-modes.ts <url> [address]   # the three surfaces, the change overlay and switch timings
gh workflow run refresh-index.yml       # rebuild the LiDAR file index now; opens an issue if new surveys appear (also runs monthly)
node spike/23-a11y-audit.ts <url>       # axe (WCAG 2.2 AA), keyboard order, phone tap targets, 200% zoom, the embed: run before shipping UI changes
node spike/24-share-images.ts <url>     # the link-preview card (public/og-image.jpg) and home-screen icon (public/apple-touch-icon.png)
node spike/08-capture-fixtures.ts [--strata]   # recapture tests/fixtures (--strata: only the strata case)
```

`.env` holds local defaults: `VITE_BUILD_SHA=dev` (CI sets the commit) and `VITE_SITE_URL`, the absolute address used in link previews (`og:url`, `og:image`, canonical). CI passes the repository variables `VITE_LIDARBC_PROXY` and `VITE_SITE_URL`; an unset `VITE_SITE_URL` falls back to `.env`. Moving to a custom domain means setting `VITE_SITE_URL` and changing `base` in `vite.config.ts` (and its test).

CI (`.github/workflows/deploy.yml`) runs typecheck, tests (both TZs) and build on every push and PR. Pushes to `main` also deploy to Pages, then the `smoke` job waits for the new build and runs the Playwright smoke test against it. Find the live build in `<meta name="vanshade-build">`; check runs with `gh run list` / `gh run view --log-failed`.

## Layout

| Path | What's there |
|---|---|
| `src/config.ts` | endpoints, layer names, limits |
| `src/copy.ts` | every user-facing string (write for gardeners, not GIS analysts) |
| `src/data/` | network clients and domain rules: `http`, `geocoder`, `scope`, `parcels`, `jsonp`. Pure where possible, and tested. |
| `src/geo/` | polygons, the local metric frame (x = east, y = **true** north), proj4 definitions, the grid → local affine |
| `src/elevation/` | STAC lookup, the pixel window, COG reads (worker side), the LiDAR vintage lookup (`vintage.json` is built by `spike/09-build-vintage.ts`). Sharper surfaces: `hires.ts` chooses one (main thread, with `hires-index.json` from `spike/12-hires-index.ts`), `build.ts` builds it (worker side) from `copc.ts` (point clouds) or LidarBC GeoTIFFs, on HRDEM resampled by `resample.ts`. `rangeFetch.ts` makes every byte-range read. |
| `src/imagery/` | municipal aerial photos: `sources.ts` (one per municipality), `fetch.ts` (export or tiles into a canvas), `georef.ts` (grid → photo and photo → local affines) |
| `proxy/lidarbc/` | the Cloudflare Worker that adds CORS to LidarBC (see its README) |
| `src/engine/` | the shading engine: cells, horizons, sun sampling, outputs (all pure and tested), `lotSummary.ts` (the numbers behind the plain-language headline), plus the worker protocol and main-thread client |
| `src/workers/shade.worker.ts` | elevation fetch, horizon precompute and outputs off the main thread |
| `src/analysis.ts` | wires a selected lot to the engine, the 3D scene / 2D map, the timeline and the inspector |
| `src/scene/` | the three.js view (`view3d.ts`, lazy-loaded) plus pure helpers: `frame.ts` (axes, sun direction) and `terrain.ts` (meshes) |
| `src/ui/` | DOM modules: search, controls, timeline, inspector, the 2D map, design tokens (`tokens.ts` mirrors the CSS variables) |
| `src/embed.ts` | the "Copy embed code" iframe snippet and the embed's link back to the full site |
| `tests/` | Vitest specs. `tests/fixtures/` are real responses captured by `spike/08-capture-fixtures.ts`. |
| `spike/` | Phase 0 probes, with their own `package.json`. Not part of the app build. |

## Conventions

- TypeScript is strict with `noUncheckedIndexedAccess`.
- No UI framework.
- Keep dependencies few: the app ships with a handful, all credited in the README and About panel.
- All HTTP goes through `data/http.ts` `getJson` (cache, in-flight dedupe, timeout). Pass `AbortSignal`s all the way down.
- GeoJSON is `[lon, lat]`. Convert to metres with `geo/local.ts`. Don't do maths in degrees.
- **3D scene axes: X = east, Y = up, Z = south (true north is −Z)**, origin at the lot's local frame, 1:1 heights above a base level. Grid pixels reach the scene only through `gridToLocalAffine` and then `localToScene`.
- Design tokens: six colours (`--fog`, `--cedar`, `--moss`, `--sun`, `--shade`, `--mist`). The data ramp stays cividis. The display face is self-hosted Fraunces 600 and the body is system UI. Don't add colours ad hoc; check any new chart hue for contrast and colour-blind separation.
- The 3D view renders on demand: call `invalidate()` after any change, and there's no animation loop.
- Shareable state lives in the URL hash (`src/urlState.ts`, every value validated). A new lot uses `pushState`; any other change uses a throttled `replaceState`. If you add a setting, add it there too.
  - Links always carry the mode (`m=`): links from before One moment became the default left it out for Season, and a link without one still opens in Season (`LINK_DEFAULT_MODE` in `main.ts`).
  - `debug=1` shows the debug details; `embed=1` is the compact layout for iframes (`.embed` on `<html>`, styles in `styles.css`). Both stay in the hash as the user moves around, and neither goes into copied links or embed code.
  - Link previews are static Open Graph tags in `index.html`: crawlers don't run scripts, so every link shares one card.
- The worker reads the DSM for lot + 200 m but the DTM only for lot + 44 m (the DTM is NaN elsewhere). Lots over 3,000 cells compute horizons on helper threads (`workers/horizon.worker.ts`).
- **Progressive refinement:** the first result is HRDEM 1 m (EPSG:3979).
  - `Analysis.refine()` then loads the surface the "Elevation data" setting picks from `refinementOptions()`: `best` (the `merged` spec: point cloud plus LidarBC, `elevation/change.ts`), `newest` (LidarBC 1 m) or `detailed` (point cloud 0.5 m). All three are in EPSG:3157 and in the URL as `elev=` (`hrdem` is debug-only; old `copc`/`lidarbc` links map across). If one fails, the next is tried.
  - It swaps the new surface in with `swapIn()`, which keeps the camera, remaps the inspected cell and retires results computed on the old grid. Anything that depends on the grid (photo UVs, cell indices, the change overlay) must be redone after a swap.
  - Switching surfaces reuses the worker's downloads (`elevation/cache.ts`, an LRU that hands out copies because builders write into their arrays).
  - A grid's metres per pixel is `window.res`. Never assume 1 m (mesh steps, camera distance, cursor, hillshade slopes all scale with it).
- Aerial photos are on by default (`img=0` turns them off) and fetched once a lot's first result is up; results go see-through (`op=`) only over the photo.
- **First-time and non-technical users come first.**
  - The result panel opens with a plain-language headline (`Analysis.headlineText()`, `copy.headline`).
  - Technical facts (lot type, plan, LiDAR rows) live in the "Lot and data details" disclosure (`setFact(..., more = true)`); the surface choice sits under "More options".
  - New user-facing text says "laser scans", not "LiDAR"/"DSM"/"grid", and lives in `copy.ts`.
  - `localStorage` is used only to remember that the "How to read this" card was dismissed (`ui/tips.ts`, wrapped in try/catch).
  - Defaults favour new visitors: One moment at the current time (midday if it's dark, with a note in the headline: `Timeline.showingMiddayForNight`), the aerial photo on with the colours at 50%, and full / part sun / shade for One day and Season (`cls=0` / `img=0` in links turn them off).
  - The panel leads with the result and then the "Show" controls; on phones the collapsed sheet is only the address and the result.
  - Test locations are civic, commercial or council sites, never homes (see `spike/addresses.ts`). Check new ones in ParcelMap BC before committing them.
  - New UI must keep `spike/23-a11y-audit.ts` clean: zero axe violations, no phone tap targets under 24 px, no horizontal scroll at 200% zoom.
- The 3D mesh near the lot is `buildTerraced` (true cell footprints, vertical walls between smooth cells more than 2 m apart, rough cells such as tree crowns blended). Overlays use its tops only (`walls: false`). It's rendering only: the engine never sees it.

## Gotchas

1. We use **SunCalc 2**, not SunCalc 1.x: degrees, azimuth **clockwise from true north**, apparent (refraction-corrected) altitude. `engine/sun.ts` is the only place that calls it.
2. EPSG:3979 grid north is about +25° from true north here. Compute γ per lot with `convergenceDeg` (never hard-code it). **Grid azimuth = true azimuth + γ.** Horizons are stored by grid azimuth, and the display goes through `gridToLocalAffine`.
3. WFS axis order: output is lon,lat and CQL needs `POINT(lon lat)`. A flipped point returns 0 hits silently. `findParcels` asserts the point is inside the result.
4. Geocoder: request `parcelPoint`. BLOCK matches silently fall back to `accessPoint` (in the street), which needs the buffered parcel search. `brief=true` drops `localityName`. The `localityName` parameter doesn't filter.
5. Use America/Vancouver time via luxon. Never `new Date(y, m, d)`, and never hard-code offsets. **BC has been on permanent UTC−7 since 2026-03-09** (tzdb 2026b), so there's no fall-back from Nov 2026. Local clock times are only right if the runtime's tz data is 2026b or later; Node 25.8 ships 2026a, CI's Node 24.21 is newer. Tests compare UTC instants.
6. DSM and DTM must come from the same HRDEM mosaic tile and grid. This is verified identical.
7. Pages serves under `/VanShade/`. Asset and worker URLs must respect Vite's `base` (`new URL(..., import.meta.url)`).
8. Never commit elevation data (`*.tif` is gitignored).
9. The DataBC WFS only sends CORS headers when the request has a `Referer`. Never use `no-referrer` (`tests/html.test.ts` guards this). A sandboxed JSONP fallback exists.
10. The parcel layer is `PMBC_PARCEL_FABRIC_POLY_SVW`; the `…_FA_SVW` one is restricted. Strata come back as stacked identical polygons, so deduplicate them.
11. The District of North Vancouver and the City of North Vancouver are distinct, as are the City of Langley and the Township of Langley. Never merge them. A `MUNICIPALITY: "Rural"` parcel is Electoral Area A or Tsawwassen First Nation.
12. Pixel coordinates: `px = X − x0`, `py = y0 − Y`, and pixel (c, r) is centred at (c + 0.5, r + 0.5). Grid north is −py. Bilinear sampling treats NaN (nodata) as "no obstruction".
13. Read tile geometry from the COG header (`tileGrid`), not STAC `proj:transform` (its element order isn't the STAC standard for these items).
14. The WCS fallback must use `…/wrapper/ogc/elevation-hrdem-mosaic` directly. The documented `…/ows/elevation` URL redirects without CORS, and only WCS 1.1.1 works.
15. Chrome's HTTP cache sometimes returns the wrong number of bytes for a byte range it has seen before (3,137 bytes for a 1.1 MB HRDEM tile). Always read ranges through `elevation/rangeFetch.ts` (`openImage` and the COPC getter do), which re-fetches a wrong-sized body with `cache: 'reload'`.
16. LidarBC GeoTIFFs are strip TIFFs with one row per strip. Without geotiff's block cache (`openImage(url, { blockSize })`), one window costs about 1,358 requests instead of 10.
17. COPC: copc.js range getters take an **exclusive** end, and its X/Y/Z come back already scaled to metres. Pass our laz-perf (the worker build) explicitly. Tests and Node scripts call `useLazPerf()` with the Node build.
18. Imagery sources match the display jurisdiction by regex. Keep the District and the City of North Vancouver, and the City and the Township of Langley, apart there too. Only the District and the Township publish photos.
19. UTM windows snap to whole metres (`alignedWindow(..., snapM = 1)` in `build.ts` `utmWindow`), so a lot's 0.5 m and 1 m grids line up cell for 2 × 2 cells. The best-of-both merge depends on it.
20. OrbitControls sets an inline `touch-action: none` on the canvas. On coarse pointers `view3d.ts` overrides it to `pan-y` (so a vertical swipe scrolls the page), which CSS alone can't do.
