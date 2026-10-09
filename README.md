# VanShade

**Where does the sun fall on your lot?** Type a Metro Vancouver address and VanShade shows your lot in 3D, with its real
neighbours, trees and buildings, and works out how many hours of direct sun each square metre gets over the dates you choose,
on clear days and with typical weather. Gardeners use it to find full-sun spots for vegetables; Advanced mode adds any day,
any moment and a shade finder for a summer patio.

**Live:** https://vanshade.ca

VanShade is our entry for the **Trilemma Datathon 2026**. The original proposal is below, under [Why we built it](#why-we-built-it).

![VanShade in Basic mode at Vancouver City Hall: the maximum and minimum hours of direct sun from April to September, with typical weather, above a full-width 3D view of the lot over its aerial photo](docs/screenshots/desktop.png)

<p>
  <img src="docs/screenshots/inspector.png" alt="The spot inspector: average sun-hours by month and the sun/shade strip for one day" width="480">
  <img src="docs/screenshots/mobile.png" alt="VanShade on a phone: the maximum and minimum hours and the dates above the 3D view" width="220">
</p>

## Why we built it

### The problem

Sunlight plays an important role in how people use their outdoor spaces, but it is often difficult to know how much sunlight
a property actually receives throughout the day. This can be especially important for people who are getting into
gardening, as different plants and crops have different sunlight and shade requirements. The amount of sunlight can also
affect how comfortably people can use their backyard or lawn for activities such as relaxing, dining, or spending time
outdoors.

For people considering a new home, sunlight can also be an important factor in deciding whether a property is right for
them. However, it is difficult to assess how much direct sunlight a yard will receive simply by looking at a property
listing or visiting it at a single time of day. Trees, buildings, surrounding structures, and the changing position of the
sun can create significant differences in sunlight across a property.

Currently, there is no readily accessible tool that allows people to enter a property address and determine how much
sunlight their outdoor space receives over a specific period of time.

### Scope

The tool is limited to the BC Lower Mainland, home to approximately 3.1 million people. It isn't restricted to property
type, so even commercial property managers can use it. There are approximately 1.15 million properties in the area.
VanShade covers Metro Vancouver: its 21 municipalities, Electoral Area A and Tsawwassen First Nation.

### Existing tools and their gaps

ShadeMap is an existing tool that allows users to visualize sunlight and shade patterns for a given location. However, its
level of detail is limited for property-level analysis. Buildings are represented primarily as simplified cubes, without
detailed structural features that may affect shade, and lawn-specific features such as trees, fences, or other obstacles
are not fully accounted for. In addition, the free version focuses on daily sunlight and shade patterns, rather than
providing averaged sunlight estimates over longer periods that account for seasonal variation. There are other similar tools
with the same gaps. These limitations make it difficult for users to accurately determine which specific areas of a
property receive the most or least sunlight over an extended period.

### From proposal to tool

The proposal was to combine LiDAR data, a geocoder and SunCalc into a tool that takes an address and a period of at least a
month, and reports the average range of sunlight hours along with the sunniest and shadiest 1 m² of the property. Here's
how VanShade follows it:

- **Address in, sunlight out:** the BC Address Geocoder finds the address and ParcelMap BC the lot.
- **LiDAR:** instead of the Metro Vancouver portal, VanShade reads NRCan's 1 m elevation model and 0.5 m point clouds, and
  the Province's 2024–2025 LidarBC surveys, straight from the browser, so trees, fences and roof shapes all cast shade.
- **SunCalc:** gives the sun's position for every step of the period.
- **Averages over a period:** Basic mode averages any range of dates (the growing season by default); Advanced mode's *One
  day*, *One moment* and *Shade finder* go beyond the proposal.
- **Minimum and maximum hours, and where:** Basic mode's summary gives both, with the direction of each spot on the lot.
- **Sunniest and shadiest spots:** pins mark them. They're patches about 2 m × 2 m (a small garden bed) rather than a single
  square metre, which is often a sliver against a wall.
- **Weather:** each figure also comes "with typical weather", from Environment Canada's measured sunshine records adjusted for
  local cloud. Clear-day hours stay the main figure, because that's how plant labels count full sun.

## Using it

- **Search** for an address (Metro Vancouver only), or tap **Use my location** to start from where you're standing. VanShade
  finds the lot and loads the LiDAR around it; the address bar then moves up beside the name, and the VanShade title takes
  you back to the start. First-time visitors get a short "How to read this" card, and the About panel explains the terms.
- **Basic mode** (the default) has one setting, the dates (1 April to 30 September unless you change them), and a summary:
  - **Maximum** and **minimum** average hours of direct sun a day, for patches of open ground about 2 m × 2 m, and where they
    are: "Maximum: 11.6 hours, in the east". Click the direction to find its pin.
  - Under each, the hours to expect **with typical weather** (see [How it works](#how-it-works)).
  - The view spans the page, coloured from the lot's own fewest to most hours. **Max** and **Min** pins mark the two spots.
- **Advanced mode** (the switch at the top right) is the full toolkit:
  - *One moment* (now, or a time you pick), *One day*, *Season* and *Shade finder* (how often each spot is shaded in a daily
    time window, say 1–6 pm through summer).
  - **Measure at** garden-bed height (0.3 m), seated (1.2 m) or on a roof or deck surface.
  - **Full / part sun / shade** colours with adjustable thresholds (6 h and 3 h), or exact hours.
  - **Time slider, Now and Play the day**, with sunrise and sunset; real-time 3D shadows.
  - **3D data:** *Best of both* (2016 detail, updated wherever something changed by 2025; the default), *Newest survey*
    (2025, 1 m) or *Most detailed* (2016, 0.5 m); *Show changes since 2016* hatches what changed.
- **Click a pin or any spot**, or focus the view, step with the arrow keys and press Enter, to see that spot's sun month by
  month (with a typical-weather column in the table view) and through the day.
- **Analysis:** a short reading of the lot from Google's Gemini (where the sun and shade fall, what suits each part), then
  your own questions, such as "Where should I plant vegetables?". It answers from the numbers VanShade shows for the lot.
- **Aerial photo:** where the municipality publishes open orthophotos (Vancouver, Burnaby, Surrey, Coquitlam, the District of
  North Vancouver, Delta, Maple Ridge, both Langleys, Port Coquitlam, White Rock), the photo always sits under the results.
- **Copy link:** the address, lot, dates and settings are in the URL (`adv=1` for Advanced mode). Shared links show a
  preview card in chat apps and social media.
- **Copy embed code:** an `<iframe>` for the current lot, for a blog or a garden club page, with a link to the full site.

## Embed it

Put a live VanShade view on your own page, such as a blog post or a garden club site. Open a lot, choose the dates (or a
mode in Advanced), then press **Copy embed code**. You get an iframe like this one:

```html
<iframe src="https://vanshade.ca/#a=453+W+12th+Ave%2C+Vancouver%2C+BC&amp;embed=1" width="100%" height="600" style="border:0" title="VanShade: sun and shade at 453 W 12th Ave, Vancouver, BC"></iframe>
```

The embed keeps the 3D view and the result, credits the data, and links to the full site.

## How it works

```
address ─▶ BC Address Geocoder (parcel point) ─▶ ParcelMap BC WFS (lot polygon)
        ─▶ NRCan HRDEM 1 m LiDAR surface (DSM) for the lot + 200 m, ground (DTM) near the lot
        ─▶ Web Worker: horizon precompute ─▶ SunCalc sun positions ─▶ hours of direct sun per cell
        ─▶ three.js view (true north up)
        ─▶ then, in the background: a sharper or newer surface (NRCan point cloud at 0.5 m, or LidarBC 2024/2025 at 1 m),
           and the results swap over
```

1. **Elevation.** Read straight from NRCan's Cloud-Optimized GeoTIFFs on S3 with geotiff.js range requests. There's no server
   and no API key. The surface model includes roofs, trees and hedges, which is where most yard shade comes from.
2. **Horizons.** For every 1 m cell on the lot and 180 compass directions, a worker marches out across the surface model and
   records the highest angle anything blocks. Big lots split this across helper threads.
3. **Sun.** Each sun position (SunCalc, America/Vancouver time) becomes a table lookup per cell. A whole season is about
   1,500 positions and takes milliseconds.
4. **Sharper, newer LiDAR.** Once the first result is up, VanShade looks for better data for the lot. One source is NRCan's
   cloud-optimized point clouds: it reads only the octree nodes near the lot (3–8 MB, decoded with laz-perf in WebAssembly)
   and grids the highest return per 0.5 m. The other is the Province's 2024/2025 LidarBC surveys at 1 m. By default it
   combines them: the 2016 detail wherever the two surveys agree, and 2025 wherever something changed by more than 2.5 m
   (a new tower, a demolished house, trees removed). The heights are checked against NRCan's ground model before use.
5. **Typical weather.** Each sampled day's clear-day hours are scaled by the share of daylight the sun usually shines that
   time of year: Environment Canada's measured sunshine at Vancouver or Abbotsford airport (about 22% in January, 60% in
   July), adjusted for local cloud with Open-Meteo's weather model (the North Shore and the eastern valley are 4–11% less
   sunny). Long periods weight sunny and cloudy months by their days.
6. **Grid north isn't true north.** The elevation grid (EPSG:3979) is rotated about 25° from true north in Vancouver.
   VanShade computes that per lot and applies it everywhere, from sun directions to drawing.

The engine is covered by tests for:
- solar-noon altitudes
- the shadow length and direction of a 10 m box
- true-north shadows in the real projection
- horizon lookups against brute-force ray marching (≥ 99% agreement)
- identical results in any time zone

## Accuracy, in short

- Lot lines come from ParcelMap BC and are approximate, not a legal survey.
- The LiDAR has a date. Most of Metro Vancouver is 2016 in the first result. Where the newer LidarBC surveys are available
  (2024–2025), they replace it. Anything built or grown since isn't in it.
- Trees count as solid all year. Deciduous trees let more winter sun through.
- The main numbers are potential direct sun on clear days. "With typical weather" is an average from sunshine records, not a
  forecast; fog and mountain cloud vary more than it shows.
- Only things within about 200 m cast shadows, so distant hills aren't included.

The app's **About accuracy** panel has the details.

## Data and licences

| Data | Source | Licence |
|---|---|---|
| Addresses | BC Address Geocoder | Open Government Licence – British Columbia |
| Lot lines | ParcelMap BC (DataBC WFS) | Open Government Licence – British Columbia |
| Elevation | NRCan High Resolution Digital Elevation Model (HRDEM) 1 m mosaic, and CanElevation LiDAR point clouds | Open Government Licence – Canada |
| Newer elevation | LidarBC 1 m surface and ground models (2024, 2025), read through [a small CORS proxy](proxy/lidarbc) | Open Government Licence – British Columbia |
| Aerial photos | Each municipality's orthophoto service (list in the app's About panel) | Each municipality's Open Government Licence |
| Typical weather | Environment and Climate Change Canada climate normals (hours of bright sunshine, Vancouver and Abbotsford airports), adjusted with [Open-Meteo](https://open-meteo.com/) historical weather (ECMWF, Copernicus ERA5) | Open Government Licence – Canada; CC BY 4.0 |

Analysis answers are written by [Google's Gemini](https://ai.google.dev/gemini-api), called through
[a small proxy](proxy/gemini) that keeps the API key off the site; only a written summary of the lot and the questions are sent.

Built with [three.js](https://threejs.org/), [SunCalc](https://github.com/mourner/suncalc),
[geotiff.js](https://geotiffjs.github.io/), [proj4js](https://github.com/proj4js/proj4js),
[Luxon](https://moment.github.io/luxon/), [copc.js](https://github.com/connormanning/copc.js) and
[laz-perf](https://github.com/hobuinc/laz-perf). Headings use [Fraunces](https://github.com/undercasetype/Fraunces) (SIL OFL).

Endpoint details, quirks and measurements are in [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md).

## Licence

The code is under the [MIT licence](LICENSE). The data VanShade reads stays under each provider's licence, listed in the
table above (the app shows the attribution each requires). The Fraunces typeface is under the SIL Open Font Licence
([`src/assets/fonts/OFL.txt`](src/assets/fonts/OFL.txt)), and the libraries keep their own licences.

## Development

```sh
npm ci
npm run dev          # http://localhost:5173/
npm test             # Vitest
npm run test:tz      # the suite under TZ=UTC and TZ=Asia/Tokyo (as CI runs it)
npm run typecheck
npm run build
npm run smoke        # Playwright smoke test (BASE_URL=… to point at a deployed site)
```

A monthly workflow (`.github/workflows/refresh-index.yml`) rebuilds the high-resolution LiDAR file index and opens an
issue when new surveys appear.

The app is a static Vite + TypeScript site with no backend, apart from two optional Cloudflare Workers, each deployed once
with `npx wrangler deploy` and switched on with a repository variable:
- [`proxy/lidarbc/`](proxy/lidarbc) (`VITE_LIDARBC_PROXY`) adds CORS headers to LidarBC. Without it, the site skips LidarBC.
- [`proxy/gemini/`](proxy/gemini) (`VITE_GEMINI_PROXY`) holds the Gemini API key for the Analysis chat. Without it, there's
  no Analysis button.

Every push to `main` runs CI:
1. typecheck, both time-zone test runs, and build
2. deploy to GitHub Pages
3. the Playwright smoke test against the live site

| Path | What's there |
|---|---|
| `src/data/` | geocoder, ParcelMap BC, scope rules (Metro Vancouver jurisdictions) |
| `src/elevation/` | STAC lookup, pixel windows, COG reads, LiDAR vintage, point clouds and LidarBC (the sharper surfaces) |
| `src/imagery/` | municipal aerial photos: sources, fetching, placement |
| `src/weather/` | typical weather: airport sunshine normals and the local cloud pattern |
| `proxy/lidarbc/` | the Cloudflare Worker that adds CORS headers to LidarBC |
| `proxy/gemini/` | the Cloudflare Worker that answers the Analysis chat with Gemini (it holds the API key) |
| `src/engine/` | cells, horizons, sun sampling, outputs; the worker protocol and client |
| `src/workers/` | the shade worker and its horizon helper threads |
| `src/scene/` | the three.js view (lazy-loaded) and its pure geometry helpers |
| `src/ui/` | search, controls, timeline, inspector, 2D map, design tokens |
| `tests/`, `e2e/` | Vitest unit tests (with captured API fixtures), the Playwright smoke test |
| `spike/` | the Phase 0 data probes and measurement scripts |
| `docs/` | the developer guide, data-source findings, screenshots |

Contributor notes and gotchas are in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).
