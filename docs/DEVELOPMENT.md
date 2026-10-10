# VanShade developer guide

Static sun and shade mapper for Metro Vancouver yards. Served by GitHub Pages at https://vanshade.ca with no backend; all compute happens in the browser. The exceptions are two optional Cloudflare Workers you deploy yourself: the LidarBC CORS proxy (`proxy/lidarbc/`, `VITE_LIDARBC_PROXY`) and the Analysis chat's Gemini proxy (`proxy/gemini/`, `VITE_GEMINI_PROXY`), which holds the API key. Without them the site is fully static, with no LidarBC and no Analysis.

Verified endpoints and data quirks are in [`DATA_SOURCES.md`](DATA_SOURCES.md). Read it before touching any data source.

## Commands

```sh
npm run dev         # http://localhost:5173/
npm test            # vitest (node env, fetch stubbed)
npm run test:tz     # the suite under TZ=UTC and TZ=Asia/Tokyo (what CI runs)
npm run typecheck   # tsc --noEmit, strict
npm run build       # → dist/
npm run smoke       # Playwright smoke test (e2e/); BASE_URL=<url> for a deployed site, default http://localhost:5180/
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
node spike/25-weather.ts                # rebuild src/weather/sunshine.json (airport sunshine normals + Open-Meteo's local pattern); rate-limited, a few minutes
cd proxy/gemini && npx wrangler deploy  # the Analysis proxy; set its key with `npx wrangler secret put GEMINI_API_KEY`, read its logs with `npx wrangler tail`
node spike/08-capture-fixtures.ts [--strata]   # recapture tests/fixtures (--strata: only the strata case)
```

`.env` holds local defaults: `VITE_BUILD_SHA=dev` (CI sets the commit) and `VITE_SITE_URL`, the absolute address used in link previews (`og:url`, `og:image`, canonical). CI passes the repository variables `VITE_LIDARBC_PROXY`, `VITE_GEMINI_PROXY` and `VITE_SITE_URL`; an unset `VITE_SITE_URL` falls back to `.env`. The site lives at the root of vanshade.ca, so `base` in `vite.config.ts` is `/`; a test keeps it in step with the path of `VITE_SITE_URL`.

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
| `src/weather/` | typical weather: `sunshine.json` (built by `spike/25-weather.ts`) and `sunshine.ts` (each month's share of daylight with sunshine at a place; a day's factor) |
| `proxy/lidarbc/` | the Cloudflare Worker that adds CORS to LidarBC (see its README) |
| `proxy/gemini/` | the Cloudflare Worker for the Analysis chat (see its README): holds the Gemini key, writes the advisor's instructions, fixes the model, caps lengths, rate-limits, and streams the answer back. `tests/geminiProxy.test.ts` tests it with Gemini stubbed. |
| `src/insight.ts`, `src/ui/analysisChat.ts` | the Analysis chat: the lot in plain lines for the advisor (`Analysis.insight()` gathers them), and the panel, which keeps the conversation and sends it with each question |
| `src/engine/` | the shading engine: cells, horizons, sun sampling, outputs (all pure and tested), `lotSummary.ts` (the numbers behind the plain-language headline), `spots.ts` (the sunniest and shadiest patches, for the headline and the pins), plus the worker protocol and main-thread client |
| `src/workers/shade.worker.ts` | elevation fetch, horizon precompute and outputs off the main thread |
| `src/analysis.ts` | wires a selected lot to the engine, the 3D scene / 2D map, the timeline and the inspector |
| `src/scene/` | the three.js view (`view3d.ts`, lazy-loaded) plus pure helpers: `frame.ts` (axes, sun direction) and `terrain.ts` (meshes) |
| `src/ui/` | DOM modules: search, controls, timeline, inspector, the 2D map, the sunniest / shadiest pins (`spotPins.ts`), the welcome and guided steps (`guide.ts`), design tokens (`tokens.ts` mirrors the CSS variables) |
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
- **The 2D map** (`ui/lotCanvas.ts`) zooms and pans over the view that fits the lot (`ui/mapZoom.ts`, pure: 1× to 8×, the ground under the pointer stays put, the view stays inside the fitted one).
  - Wheel or trackpad pinch, two fingers on a touch screen, drag once zoomed in, and + / − with Reset view in the corner. `touch-action` is `pan-y` at 1× (a swipe scrolls the page) and `none` closer in (one finger moves the map). It redraws once a frame, and resizes its canvas only when the size changes.
  - The corner controls (`#hud`) sit beside the 3D host, so they serve both views: in Map view the compass points north, and the map draws its own arrow only before a result.
  - Wherever the 3D view casts shadows at the slider's time (`castsShadows`), the map darkens the cells in shade then (`updateMapShadows`: a `moment` compute, `setShadows`), so Play the day works there too; not in One moment, whose colours are that moment.
  - `data-zoom` and `data-shadows` on the canvas say what it shows; the smoke test reads them.
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
- Aerial photos are always on, in Basic and Advanced, wherever the municipality publishes them: there's no setting, and old links' `img=` is ignored. They're fetched once a lot's first result is up. Results go see-through (`op=`, the Advanced "Colour strength" slider) only while a photo is on screen; over the plain model they stay solid.
- **First-time and non-technical users come first.**
  - The result panel opens with a plain-language headline (`Analysis.headlineText()`, `copy.headline`).
  - Technical facts (lot type, plan, LiDAR rows) live in the "Lot and data details" disclosure (`setFact(..., more = true)`); the surface choice sits under "More options".
  - New user-facing text says "laser scans", not "LiDAR"/"DSM"/"grid", and lives in `copy.ts`.
  - `localStorage` is used only to remember that the "How to read this" card was dismissed (`ui/tips.ts`) and that the welcome was seen (`ui/guide.ts`), both wrapped in try/catch.
  - **Guided start** (`ui/guide.ts`): a plain visit to the start page (nothing after `#`), the first time, opens the welcome `<dialog>`, which asks what the visitor is here to do. A goal (`Goal` in `insight.ts`: garden, patio, home) opens its Basic view in `applyGoal` (`main.ts`): Growing season for a garden, Afternoon shade for a patio, One day for a home buyer. "I'm just browsing", Escape or the backdrop leave the regular page (Basic).
    - The goal's three steps (`copy.guide`, `#guide`) sit under the address bar, the current one highlighted: the address (`lookup` and `goHome` set step 1), the sun map (`showLot`, step 2), the advice (step 3).
    - With a goal, the start page shows the address and the steps, without the overview and preview (`html.guided`), and no tips card appears after the result.
    - Step 3 is Analysis's reading, asked with the goal's question (`GOAL_QUESTIONS`) instead of the usual one. Its "Read it" brings the panel into view and focuses it (`reveal`).
    - "Choose another option" (`#guide-change`) reopens the welcome; there Escape or the backdrop keep the current goal. With a lot open, `applyGoal` switches it to the new goal's view, then Analysis reads it again with the new question.
    - The goal isn't in the URL; a link to a lot, or with any setting, skips the welcome; embeds never show it. "Leave the guide" drops the steps and keeps the settings, and the start page's "Not sure where to start?" reopens the welcome, as does `#welcome` (`openWelcomeFromLink`: for demos; the hash is then removed). The smoke test and the audits mark it seen (`vanshade:welcome-seen-v1`) where they don't test it.
  - **Basic mode is the default** (`html.basic`, `Analysis.setBasic`): the lot's maximum and minimum with where they are, and a full-width view (hours coloured over the lot's own range, `stretchScale`). Basic measures at garden-bed height on the best surface; `setAdvanced(false)` in `main.ts` sets those.
    - It has three views (`#basic-views`, `setBasicView`, `html[data-basic-view]`), each a mode with only the settings it needs: **Growing season** (`season`, the default; From / To, with typical weather), **Afternoon shade** (`shade`, the shade finder; From / To and Between / And, the shadiest spot first) and **One day** (`day`; the timeline under the map, with Play the day). `syncBasic` keeps the controls in step; `renderBasicSummary` writes each view's summary.
    - One day is Basic's only view with cast shadows and the sun's arc (`Analysis.sunMoves`, applied by `applySunStyle` only when they change, since toggling shadows recompiles the terrain shaders); `fitView` leaves room for its timeline. The averages light the 3D view from the middle of their dates (and the shade finder's hours).
    - Switching to Basic keeps the mode if it's one of these three, else Growing season. Basic's shade and day links say `adv=0` (with `m=`): before Basic, those modes meant Advanced, and a link without `adv` still opens them there. A growing-season link carries neither. Its spots are about 2 m × 2 m blocks (`findSpots` with `tight` and `blockCells`), valued at their mean, the pin on the block cell closest to it. Basic has no month chart: clicking the lot, Enter in the 3D view and the pins pick a spot only in Advanced (`pickable` on both views and `SpotPins.setInteractive`, set by `Analysis.setBasic`), and switching to Basic closes an open chart.
  - **Advanced mode** (the header switch, `adv=1`) is the full interface. A link without `adv` opens Basic (Growing season) unless it uses an Advanced-only setting (`wantsAdvanced` in `urlState.ts`), so older links keep working. Advanced's default view is One moment at the current time (midday if it's dark: `Timeline.showingMiddayForNight`).
  - In Advanced, the panel leads with the result and then the "Show" controls; on phones the collapsed sheet is only the address and the result. Basic has no sheet.
  - Basic's layout (desktop): the dates line and "About these numbers" (a `<dialog>`, like About accuracy) sit beside the address; `main.ts` moves the 3D / Map toolbar and the legend inside `.view-stage` (`placeOverlays`) and sizes the map to the window (`fitView`, wider than 720 px); the photo credit is mirrored into a bullet under the lot notices. Advanced keeps the original layout. In both, the lot notices and the accuracy caveats (`#lot-notices`, `#lot-caveats` with About accuracy) are one list in `#lot-notes`: a "Good to know" box in Advanced's panel, plain bullets after the view in Basic (`display: contents`). So Analysis comes straight after the view.
  - **Loading:** the steps ("Finding your address" … "Working out the sun", `ui/status.ts`) are a card on the map (`#status` inside `.view-stage`; near its top on phones). Where the municipality publishes aerial photos, the card lists "Adding aerial photos" from its first moment, and never otherwise: `lookup` builds it once the address says where (`photosAt`; a typed address is looked up before the card appears, or after a second at most), and `showLot` settles it from the lot. `updatePhoto` marks the line as it loads, alongside the sun, and the card stays until `Analysis.whenPhoto()` settles. `lookup` shows the lot's panel and map straight away (`showLoadingLot`, after `Analysis.clear()` empties the last lot), so the card has somewhere to sit; a failure before the lot is found hides them again and shows the message at the top.
  - The search form lives in the header. Once a lookup starts, `html.has-lot` tucks it into one row beside the name (two rows on phones). The VanShade title is a link home: `goHome()` in `main.ts` clears the lot and the hash (a history entry, so Back returns to the lot).
  - Pins mark the sunniest and shadiest spots in One day, Season, Shade finder and Basic (`spots=0` hides them in Advanced). In Advanced `engine/spots.ts` finds patches (bands at the 95th / 5th percentiles, largest connected patch, pin cell farthest from its edge) and the headline's sides come from the same patches. The pins are buttons in `#spot-layer` (a dot on the spot, a stem, a label); in Basic they're markers only (`.marker`: no pointer events, out of the tab order, `aria-hidden`, since the summary says the same); both views expose `projectCell(cell)` and a hook after each render or draw so the pins follow the camera. Pins hold cell indices, so they're cleared in `start()` and `swapIn()`.
  - **Typical weather** is an extra line, never the main number: plant labels count full sun on clear days. Season requests carry `sunshine` (12 monthly shares from `localSunshine(lot)`); the worker weights each sampled day by `dayFactor` and returns `typical` alongside the clear values. One day, One moment and Shade finder stay clear-day.
  - **Analysis chat** (`ui/analysisChat.ts`): a panel under the view, shown from a lot's first result (`onResult` → `show()`), with no button and no way to close it; not created in embeds or when `VITE_GEMINI_PROXY` is unset.
    - It reads each lot by itself, once: `readWhenReady` (`main.ts`) waits for `Analysis.whenRefined()` (the sharper surface's result, or none to load), at most `ANALYSIS_WAIT_MS`, then calls `read()` with `OPENING_QUESTION`, or the guide's goal question. Until then it says "Reading this lot…" with the questions disabled. It doesn't scroll or take focus.
    - Changing the mode or dates doesn't read again, but each question sends the current `Analysis.insight()` (the lot and its result in plain lines, `insight.ts`) and the last four exchanges to `proxy/gemini`; the key, the model and the advisor's instructions live only in the Worker. A new lot or the start page drops the conversation.
    - Every lot costs one Gemini request, so the smoke test, the accessibility audit and the screenshot scripts stub `/chat`: none of them call Gemini.
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
7. The site is served from the root of vanshade.ca (Vite `base: '/'`). Asset and worker URLs still go through Vite (`new URL(..., import.meta.url)`), so a sub-path deployment would only need a new `base`.
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
