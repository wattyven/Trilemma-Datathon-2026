# VanShade data sources

Verified **2026-10-07**, from Node 25 and from headless Chromium 153 (Playwright) at `http://localhost:5199`. CORS for `https://wattyven.github.io` was checked with curl. Every number here comes from a script in [`spike/`](../spike). Trimmed raw evidence is in [`docs/samples/`](samples).

```sh
cd spike && npm i
npm run geocoder   # 01: geocoder, autocomplete, locality names     → out/geocode.json, out/geocoder-results.json
npm run parcels    # 02: ParcelMap BC WFS, axis order, edge cases   → out/parcels-results.json
npm run stac       # 03: HRDEM STAC, grids, vintage, convergence    → out/stac-results.json
npm run cog        # 04: geotiff.js COG reads, coverage, vintage    → out/cog-results.json
npm run wcs        # 05: WCS GetCoverage vs COG                     → out/wcs-results.json
npm run cors       # 06: curl CORS headers (GET + preflight)
npm run browser    # Vite + Playwright Chromium: every probe under real CORS → out/browser-results.json
```

## Recommendations

| Decision | Recommendation |
|---|---|
| **Elevation path** | **A: direct COG window reads with geotiff.js ≥ 3** from NRCan's S3 bucket. Works in Chromium with no proxy. A cold DSM + DTM load for a lot plus a 200 m buffer took **1.9–2.3 s and 8.3 MiB** in parallel. B (WCS 1.1.1) also works and stays as a documented fallback. **No preprocessing or proxy is needed.** |
| **Parcel path** | Direct `fetch` to the DataBC WFS. CORS works **only when the browser sends a `Referer`**, which it does by default. Never set `Referrer-Policy: no-referrer`. Fallback: WFS JSONP loaded inside a sandboxed iframe (verified). No proxy. |
| **Scope filter** | Geocoder `bbox`, then a `localityName` allow-list or `electoralArea == "MVRD Electoral Area A"`, then a parcel `REGIONAL_DISTRICT == "Metro Vancouver Regional District"` check. |
| **Vintage** | The newest `hrdem-lidar` project whose **extent GeoJSON** contains the point. Precompute a small Metro-clipped lookup in Phase 2. Most of the region is **2016** LiDAR. |
| **Convergence** | Grid north to true north is **+24.9° to +25.4°** (clockwise) across Metro Vancouver, computed numerically per lot with proj4. |

## Surprises worth knowing

1. **The obvious parcel layer is restricted.** `WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_FA_SVW` is "ParcelMap BC Parcel Fabric – Fully Attributed", licensed *Access Only*. The WFS answers it with `Could not find type`. The public OGL-BC layer is **`WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW`**.
2. **The geocoder rate limit is 3,000/min**, from the `x-ratelimit-limit-minute` header.
3. **`parcelPoint` isn't always available.** For `BLOCK`-precision matches, the geocoder silently returns an `accessPoint` instead, and that point falls in the street. Coquitlam City Hall (3000 Guildford Way) hit **zero parcels** this way. A buffered parcel search handles it.
4. **`localityName` doesn't filter.** `localityName=Burnaby,Surrey` still returned Vancouver and Kamloops matches. Filter on the client.
5. **Locality names aren't the official member names.** Addresses carry "District of North Vancouver" and "Township of Langley". UBC/UEL addresses carry "Vancouver". Electoral Area A shows up in `electoralArea`.
6. **WFS CORS depends on `Referer`, not `Origin`.** With curl, no origin ever gets `Access-Control-Allow-Origin` unless a `Referer` is sent.
7. **The documented WCS URL (`/ows/elevation`) is a 308 redirect with no CORS headers**, so browsers can't follow it. Only **WCS 1.1.1** GetCoverage works on the final URL.
8. **STAC item footprints overstate coverage**, so they can't be used for vintage. The per-project `extent` GeoJSON is accurate.
9. **Strata parcels come back as stacked identical polygons**, one per strata lot. Deduplicate them.
10. **The data is older than you might expect:** 12 of the 14 Metro test points come from 2016 LiDAR.
11. **SunCalc 2 changed the classic SunCalc conventions** (found in Phase 2, released June 2026; we use 2.1.1). Angles are degrees, azimuth is clockwise from true north, and altitude is apparent (refraction-corrected). `getTimes` takes an optional UTC offset for the civil day.
12. **STAC `proj:transform` on the HRDEM items is in GDAL geotransform order**, `[originX, res, 0, originY, 0, −res]`, not the STAC `[a…f]` order. The app reads tile geometry from the COG header instead.
14. **British Columbia dropped clock changes.** IANA tzdb 2026b (April 2026) says BC moved to permanent UTC−7 on 2026-03-09, so Vancouver doesn't fall back on 2026-11-01. DST-aware handling through luxon/Intl still works, but only on runtimes with tz data 2026b or later. Node 25.8.1 (tz 2026a) still models UTC−8 for winter 2026. Sun positions use UTC instants and are unaffected; only how user-entered local times are read and how times are displayed depend on it. Current browsers update their tz data regularly.
13. **The EPSG:3979 scale factor in Metro Vancouver is about 0.999**, so a 1 m grid pixel is about 1.001 m on the ground. The effect on horizon angles (under 0.05°) is ignored.

---

## 1. BC Address Geocoder

**Endpoint:** `https://geocoder.api.gov.bc.ca/addresses.json`. Keyless.

```
# Submit (full address → point inside the lot)
https://geocoder.api.gov.bc.ca/addresses.json?addressString=453%20W%2012th%20Ave%20Vancouver
  &locationDescriptor=parcelPoint&maxResults=1&outputSRS=4326&echo=false

# Autocomplete while typing
https://geocoder.api.gov.bc.ca/addresses.json?addressString=4949%20Cana&autoComplete=true&maxResults=5
  &brief=true&outputSRS=4326&locationDescriptor=parcelPoint&bbox=-123.5,49.0,-122.2,49.6
  &matchPrecisionNot=STREET,BLOCK,INTERSECTION,LOCALITY,PROVINCE
```

Samples: [`geocoder-address.json`](samples/geocoder-address.json), [`geocoder-autocomplete.json`](samples/geocoder-autocomplete.json).

The response is a GeoJSON FeatureCollection. The feature geometry is `[lon, lat]`. Useful `properties`:
- `fullAddress` (the standardized display string)
- `score` (0–100) and `matchPrecision` (`CIVIC_NUMBER`, `BLOCK`, `STREET`, `LOCALITY`, `INTERSECTION`, …)
- `localityName`, `localityType` and `electoralArea`
- `locationDescriptor` (what was *actually* returned) and `locationPositionalAccuracy`
- `siteID`

The top level also carries `disclaimer`, `privacyStatement` and `copyrightLicense` URLs.

**`locationDescriptor` values** (all return 200; anything else returns 400):

| Value | What it returned |
|---|---|
| `any` | `parcelPoint` here |
| `accessPoint` | its own point |
| `frontDoorPoint` | fell back to `parcelPoint` |
| `parcelPoint` | its own point |
| `rooftopPoint` | fell back to `parcelPoint` |
| `routingPoint` | its own point |

- For `CIVIC_NUMBER` matches, `parcelPoint` was 8–124 m from `accessPoint`.
- For `BLOCK` matches (Coquitlam City Hall, UBC Life Building) the response says `locationDescriptor: "accessPoint"` even though `parcelPoint` was requested. **Always read `properties.locationDescriptor` back.**

**Test addresses.** All are civic buildings except the strata case, a light-industrial strata. All scored 99–100.

| id | Returned | Precision | localityName | parcel↔access |
|---|---|---|---|---|
| van | 453 W 12th Ave, Vancouver | CIVIC_NUMBER | Vancouver | 96 m |
| bby | 4949 Canada Way, Burnaby | CIVIC_NUMBER | Burnaby | 103 m |
| sry | 13450 104 Ave, Surrey | CIVIC_NUMBER | Surrey | 8 m |
| rmd | 6911 No 3 Rd, Richmond | CIVIC_NUMBER | Richmond | 124 m |
| cnv | 141 W 14th St, North Vancouver | CIVIC_NUMBER | North Vancouver | 69 m |
| dnv | 355 W Queens Rd, District of North Vancouver | CIVIC_NUMBER | District of North Vancouver | 47 m |
| wv | 750 17th St, West Vancouver | CIVIC_NUMBER | West Vancouver | 46 m |
| coq | 3000 Guildford Way, Coquitlam | **BLOCK** | Coquitlam | 0 m (accessPoint) |
| cl | 20399 Douglas Cres, Langley | CIVIC_NUMBER | Langley | 71 m |
| tol | 20338 65 Ave, Township of Langley | CIVIC_NUMBER | Township of Langley | 41 m |
| dlt | 4500 Clarence Taylor Cres, Delta | CIVIC_NUMBER | Delta | 81 m |
| mr | 11995 Haney Pl, Maple Ridge | CIVIC_NUMBER | Maple Ridge | 70 m |
| ubc | 6138 Student Union Blvd, Vancouver | **BLOCK** | Vancouver | 0 m (accessPoint) |
| strata | 3871 North Fraser Way, Burnaby | CIVIC_NUMBER | Burnaby | 111 m |
| vic | 1 Centennial Sq, Victoria | CIVIC_NUMBER | Victoria | (out-of-area control) |

**Autocomplete:**
- Latency was 15–135 ms.
- `matchPrecisionNot=STREET,BLOCK,INTERSECTION,LOCALITY,PROVINCE` leaves only civic-number matches. It removes noise such as "453W Twelfth St, New Westminster [BLOCK]" and bare street names. "Main St" then returns nothing, which is correct.
- Trade-off: some real addresses only resolve to `BLOCK`, such as Coquitlam City Hall. Recommendation: filter `BLOCK` out of suggestions, but if a submitted free-text search resolves only to `BLOCK`, accept it, use the buffered parcel search (§3), and tell the user.

**Filters:**
- `bbox=minLon,minLat,maxLon,maxLat` (with `outputSRS=4326`) restricts results. A Victoria address returned only in-region localities.
- `localityName` does **not** filter.

**CORS:**
- `access-control-allow-origin` reflects the request origin, with `allow-credentials: true`.
- The preflight allows GET.
- Verified from Chromium.

**Rate limit and licence:** `x-ratelimit-limit-minute: 3000`. Open Government Licence – British Columbia.

## 2. Metro Vancouver scope

**Rough bbox (lon/lat):** `-123.5, 49.0, -122.2, 49.6`.
- All 14 in-scope test points fall inside and Victoria falls outside.
- The box also catches **Abbotsford, Mission, Gambier Island and Furry Creek** (from a 48-point nearest-site sample), so the allow-list is required.

**`localityName` allow-list** (exact strings returned on address matches):

```
Anmore, Belcarra, Bowen Island, Burnaby, Coquitlam, Delta, Langley, Township of Langley, Lions Bay,
Maple Ridge, New Westminster, North Vancouver, District of North Vancouver, Pitt Meadows,
Port Coquitlam, Port Moody, Richmond, Surrey, Vancouver, West Vancouver, White Rock,
Tsawwassen First Nation, Indian Arm, Barnston Island
```

Notes:
- **"Langley"** is the City of Langley and **"Township of Langley"** is the Township. **"North Vancouver"** is the City and **"District of North Vancouver"** is the District. Seen on real addresses.
- **Electoral Area A:**
  - UBC/UEL addresses come back as `Vancouver`.
  - Indian Arm addresses come back as `localityName: "Indian Arm", electoralArea: "MVRD Electoral Area A"`.
  - Treat `electoralArea === "MVRD Electoral Area A"` as in scope too.
  - "Barnston Island" is listed as a community and hasn't been checked against a real address.
- **Tsawwassen First Nation** addresses come back as `localityName: "Tsawwassen First Nation"`.
- **Communities aren't localities on addresses.** Ladner, Steveston, Cloverdale, Fleetwood, Aldergrove, Walnut Grove, Deep Cove, Horseshoe Bay, Ioco, Whonnock and the like only appear as `LOCALITY` matches formatted "X in \<municipality\>". Addresses carry the municipality name.
- **Second, authoritative check:** the parcel's `REGIONAL_DISTRICT` field. It was `"Metro Vancouver Regional District"` for all 13 in-scope parcels found and `"Capital Regional District"` for Victoria.

## 3. ParcelMap BC

**WFS:** `https://openmaps.gov.bc.ca/geo/pub/wfs` (GeoServer behind a Kong gateway). Layer details:

| Property | Value |
|---|---|
| typeName | **`WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW`** (title "ParcelMap BC Parcel Fabric") |
| Geometry column | `SHAPE` |
| Native CRS | EPSG:3005 |
| Output formats | `application/json`, `text/javascript` |
| CountDefault | 10000 |

```
https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=2.0.0&request=GetFeature
  &typeNames=WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW&outputFormat=application/json
  &srsName=EPSG:4326&count=5
  &propertyName=PARCEL_FABRIC_POLY_ID,PARCEL_NAME,PLAN_NUMBER,PID_FORMATTED,PARCEL_STATUS,PARCEL_CLASS,OWNER_TYPE,MUNICIPALITY,REGIONAL_DISTRICT,FEATURE_AREA_SQM,WHEN_UPDATED,SHAPE
  &CQL_FILTER=INTERSECTS(SHAPE,SRID=4326;POINT(-123.1139388 49.261317))
```

Samples: [`wfs-parcel.json`](samples/wfs-parcel.json), [`wfs-parcel-strata.json`](samples/wfs-parcel-strata.json) (PIDs removed).

**Axis order (docs/DEVELOPMENT.md, gotcha 3):**
- GeoJSON output is **`[lon, lat]`** for `srsName=EPSG:4326`, for `urn:ogc:def:crs:EPSG::4326`, and for WFS 1.1.0.
- The CQL point must be `POINT(lon lat)`. A flipped point returns 0 hits rather than an error.
- The point-in-polygon assert passed for every test address that had a parcel point.
- A native query also works: `INTERSECTS(SHAPE,POINT(x y))` with EPSG:3005 coordinates.

Responses took 30–100 ms.

**Fields:**
- `PARCEL_CLASS`: Subdivision, Building Strata, Interest, Road, Park, …
- `OWNER_TYPE`: Private, Local Government, Unclassified, …
- `PLAN_NUMBER`, `MUNICIPALITY` (e.g. "Vancouver, City of"), `REGIONAL_DISTRICT`, `FEATURE_AREA_SQM`, `WHEN_UPDATED`, `PID_FORMATTED`

**Edge cases:**

| Case | Observed | Handling |
|---|---|---|
| Zero hits | A road intersection gives 0. Retrying with `DWITHIN(SHAPE,POINT(x y),d,meters)` in **EPSG:3005**: 5 m → 0, 15 m → 3, 30 m → 10. The Coquitlam `BLOCK` point: 5 m → 0, **15 m → 1** (the civic parcel), 30 m → 2 (adds a park). | Retry DWITHIN at about 15 m in EPSG:3005, where metres are true metres. If there are several, rank by distance and let the user pick. If none, show "We couldn't find a lot at this address." |
| Multiple hits | Surrey City Hall: an `Interest` polygon plus a `Subdivision` polygon with **identical geometry**. | Deduplicate identical geometries, deprioritise `Interest` and `Road`, and pick the smallest containing polygon. |
| Strata | `PARCEL_CLASS = "Building Strata"`, one identical polygon **per strata lot**. In a 300 m box downtown (around the Art Gallery), 276 of the first 300 parcels were strata. Strata plan prefixes: BCS, LMS, EPS, NWS, VAS. Subdivision plans: BCP, LMP, EPP, NWP, VAP. | Deduplicate and show the strata/complex notice. |
| Very large lots | UBC: one 924,398 m² `Subdivision / Private / NO_PLAN` parcel with `MUNICIPALITY: "Rural"`. | The cell cap and coarsening are essential. |

**CORS (important):**
- The Kong gateway sets `Access-Control-Allow-Origin` to the **origin of the `Referer` header**. It ignores `Origin`.
- With no Referer there is no ACAO header, so browsers block the response.
- Browsers send `Referer: <origin>/` cross-origin by default (`strict-origin-when-cross-origin`), so a plain `fetch()` works. Verified in Chromium.
- A `fetch(..., { referrerPolicy: 'no-referrer' })` **fails**. Verified.
- Rule for the app: never set `<meta name="referrer" content="no-referrer">`, and don't override `referrerPolicy` on WFS calls.
- **Fallback (verified in Chromium):** JSONP via `outputFormat=text/javascript&format_options=callback:<name>`, loaded inside a `<iframe sandbox="allow-scripts">` that `postMessage`s the payload back. The sandbox keeps the remote script out of our origin.

**Rate limit and licence:**
- Gateway headers show `ratelimit-limit: 60000` per second.
- Open Government Licence – British Columbia.
- Not a legal survey boundary.
- The full province is also downloadable as a file geodatabase, which isn't needed here.

## 4. NRCan HRDEM 1 m mosaic

### 4.1 STAC

- **API:** `https://datacube.services.geo.ca/stac/api/`
- **Collection:** `hrdem-mosaic-1m`. Also `hrdem-mosaic-2m` and the per-project `hrdem-lidar`.
- **Licence:** `OGL-Canada-2.0` (from the collection's `license` field).

```
https://datacube.services.geo.ca/stac/api/search?collections=hrdem-mosaic-1m&limit=1
  &intersects={"type":"Point","coordinates":[-123.1139388,49.261317]}
```

Sample: [`stac-mosaic-item.json`](samples/stac-mosaic-item.json).

**Tiles:**
- Items are **500 × 500 km tiles** in EPSG:3979.
- All 14 Metro Vancouver test points fall in **`2_3-mosaic-1m`** (x −2,000,000 to −1,500,000; y 0 to 500,000). Victoria falls in `1_3`.
- Every inhabited part of Metro Vancouver is inside `2_3`. The closest to an edge is Lions Bay, 2.9 km from the north edge, then Bowen Island's west shore, 6.7 km from the west edge. A 200 m buffer window won't cross tiles.
- Phase 2 should still query STAC with the *window* bbox and fail clearly if more than one item comes back.

**Asset hrefs:**
- `dsm`: `https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-mosaic-1m/2_3-mosaic-1m-dsm.tif`
- `dtm`: the same with `-dtm.tif`
- Also `dsm-vrt`, `dtm-vrt`, `extent`, `coverage` (gpkg), `thumbnail`, `hillshade-*`

**CORS:**
- `access-control-allow-origin: *`.
- OPTIONS returns 403. That doesn't matter because a plain GET is a simple request with no preflight, so don't add custom headers to STAC calls.

### 4.2 COGs on S3 (path A)

**File properties** (both DSM and DTM):

| Property | Value |
|---|---|
| Size | 500,000 × 500,000 px, about **133 GB** per file |
| Data type | Float32 |
| Tiles | 512 × 512 |
| Compression | **LZW (5), predictor 1** |
| Nodata | −32767 |
| Origin and pixel size | (−2,000,000, 500,000), 1 m |
| IFDs | 11 (overviews 2× to 512×) |

- **DSM and DTM share an identical grid** (same VRT size, GeoTransform and nodata), so docs/DEVELOPMENT.md gotcha 6 holds.
- Heights are CGVD2013.

**S3 CORS:**
- `Access-Control-Allow-Origin: *`, `Allow-Headers: range`, `Allow-Methods: GET, HEAD`.
- Range GET returns `206`.
- `Expose-Headers` lists only `ETag`, so `Content-Range` is hidden from browsers. That's harmless here: geotiff.js 3 with its default `maxRanges: 0` uses `Content-Range` only to learn the total file size.

**geotiff.js 3.0.5:**
- `TileOffsets` and `TileByteCounts` (about 7.6 MB each in this file) are loaded **lazily**. Opening a file costs 2 requests and 5 KiB.
- LZW decodes on the main thread or in a worker. The Phase 2 worker can call it directly.

**Timings** (this connection):

| Measurement | Result |
|---|---|
| Chromium, **parallel** cold DSM + DTM, 441 × 441 m window (lot + 200 m buffer) | **1.9–2.3 s** across two runs, 28 requests, **8.29 MiB** |
| Node, **parallel** cold DSM + DTM, same window | **1.0–1.2 s**, 28 requests, 8.3 MiB (van, dnv) |
| Node, sequential, per raster | open 0.17–0.6 s, window 0.44–0.89 s, about 4.1 MiB (2.0 MiB at Maple Ridge, where the window fit in fewer tiles) |

- Float32 with LZW and no predictor barely compresses, so each 512² tile is about 1 MiB.
- A 441 m window spans at most 2 × 2 tiles, so the worst case is about 4 MiB per raster. Windows wider than 512 m (a buffer over about 230 m on a typical lot) can touch 3 × 3 tiles, about 9 MiB per raster.
- Budget: elevation fits easily in the 10 s target.

**In the app (Phase 2, local Chromium):** search to drawn sun results took **2.0–4.8 s** on 9 lots. That covers the geocoder, WFS, STAC, DSM and DTM windows (about 2 s) and horizons for up to 7,000 cells (about 0.5 s). The season average then takes about 25 ms. City Hall (22,248 m²) and Maple Ridge (28,099 m²) were coarsened to a 2 m grid.

**Live on `wattyven.github.io` (build ce3d225):** 3.0–7.4 s, with all 10 UI cases passing and no console errors. That run confirms the worker URL under `/VanShade/` and STAC/S3 CORS from the real origin.
- **Where the time goes:** the elevation download takes 2.4–5.3 s; horizons take 0.3–1.8 s for 4,800–16,200 cells, and outputs take under 0.1 s.
- **Why big lots are slower:** a window wider than 512 m touches 3 × 3 COG tiles, about 18 MiB for DSM plus DTM.
- **Phase 4 options:**
  - read the outer buffer from an overview
  - switch to WCS, which crops to the window and so downloads about 4× less
  - parallelise the horizon precompute

**Phase 4 changes, measured** (`spike/10-perf-bytes.ts` and the UI check):
- **DTM read only for the lot + 44 m.** Across the 8 test lots this saved 24% of bytes (78.6 → 59.3 MiB), ranging from 0% to 41% depending on how the lot lines up with the 512 m tiles. It's 0% when even the small window touches the same tiles.
- **Prefetch.** STAC and both COG headers now open while the lot is being looked up.
- **Horizons on up to 4 helper threads** for lots over 3,000 cells: 115–647 ms instead of 297–2,060 ms (3–4× faster).
- **What's left.** The DSM download for the 200 m buffer now dominates, at about 2–5 s on a home connection. The next lever would be reading the outer buffer from an overview level.

**Coverage.** Centre pixel at each test point. Δ = DSM − DTM, where positive means a roof or canopy:

| id | DSM | DTM | Δ | Notes |
|---|---|---|---|---|
| van | 38.58 | 38.52 | 0.06 | parcel point on open ground |
| bby | 43.14 | 40.05 | 3.09 | |
| sry | 110.46 | 80.90 | 29.57 | City Hall tower |
| rmd | 4.45 | 2.16 | 2.29 | |
| cnv | 95.30 | 87.85 | 7.45 | |
| dnv | 145.44 | 138.71 | 6.73 | North Shore slope |
| wv | 34.84 | 29.15 | 5.69 | |
| coq | 29.32 | 29.25 | 0.07 | accessPoint, in the street |
| cl | 23.31 | 11.30 | 12.01 | |
| tol | 36.73 | 19.51 | 17.23 | |
| dlt | 12.14 | 1.97 | 10.17 | |
| mr | 39.45 | 39.05 | 0.40 | |
| ubc | 85.77 | 85.32 | 0.44 | |
| strata | 11.09 | 3.46 | 7.63 | light-industrial units (Big Bend) |

No nodata appeared at any of the 14 points, and the three full 441 m windows read (van, dnv, mr) were 100% valid.

### 4.3 Vintage

- The mosaic item's `datetime` (`2023-08-13` for `2_3`) belongs to the newest project in the tile. It isn't a per-pixel date.
- STAC `hrdem-lidar` item geometries **overstate** coverage. `BC-Vancouver_Island_Sunshine_Coast_2018` "contains" every Metro point but is nodata at all of them.
- Each project's **`https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/{id}-extent.geojson`** is an accurate footprint: a GeoJSON Feature in EPSG:4326.
- "Newest project whose extent contains the point" matched the mosaic **pixel for pixel** (max diff 0.000 over a 3 × 3 block) at van, sry and mr. Older projects differed by 0.12–2.4 m, and the over-claiming ones returned nodata.

**Results:**
- 12 of 14 Metro points: **`BC-Lower_Mainland_2016-1m` (2016-09-12)**
- Maple Ridge: **`NRCAN-FHIMP_PICAI_BC_South_West_UTM10_2023-1m` (2023-08-13)**

Sample: [`stac-lidar-projects.json`](samples/stac-lidar-projects.json).

**Cost:**
- The extents are 3–63 KiB each, except Sunshine Coast 2018 at **817 KiB**.
- The `coverage.gpkg` files run from 2 MB to 225 MB and aren't usable in the browser.
- Recommendation for Phase 2: precompute a small, simplified, Metro-clipped vintage GeoJSON (a few KB, committed). Alternatively, fetch extents lazily after the first render.

### 4.4 WCS (path B, fallback)

- **The documented URL** `https://datacube.services.geo.ca/ows/elevation` returns **308** to `https://datacube.services.geo.ca/wrapper/ogc/elevation-hrdem-mosaic`. The redirect has **no CORS header**, so Chromium blocks it. **Call the final URL directly.**
- **Coverages:** `dsm` and `dtm`. Capabilities are WCS 1.1-style (`<Identifier>`). Supported CRSs include EPSG:3979, 4326, 3857, 3978 and 4617.
- **Versions:** only **WCS 1.1.1 GetCoverage** works. 2.0.1 and 1.0.0 return `400 layer does not exist`.

```
https://datacube.services.geo.ca/wrapper/ogc/elevation-hrdem-mosaic?service=WCS&version=1.1.1&request=GetCoverage
  &identifier=dsm&format=image/geotiff
  &BoundingBox=<x0+0.5>,<y0+0.5>,<x1-0.5>,<y1-0.5>,urn:ogc:def:crs:EPSG::3979
  &GridBaseCRS=urn:ogc:def:crs:EPSG::3979&GridOffsets=1,-1
```

- **`BoundingBox` uses pixel centres:** inset it by half a pixel to get the native 1 m grid. Without the inset, pixels come back as 1.0156 m.
- **Accuracy:** Float32 values are **identical to the COG** (max diff 0 over 4,096 px).
- **Speed:** a 440 × 440 m window is 1.0 MB in about 0.7 s, smaller than COG because the server crops.
- **CORS:** reflects the origin. Verified in Chromium.
- **Unknowns:** rate limits and SLA aren't published, which is why A stays primary. S3 is the more durable dependency.

### 4.4b Vintage lookup as built (Phase 2)

`spike/09-build-vintage.ts` clipped the extents of the **11** `hrdem-lidar` projects that touch the Metro bbox to that box, then simplified them to about 10 m. The result is `src/elevation/vintage.json` at 18.5 KiB. At runtime the app picks the newest project containing the point, and also runs a STAC search there so it can notice projects published later. Tests confirm City Hall gives Lower Mainland 2016 and Maple Ridge gives FHIMP 2023, matching the Phase 0 pixel check.

### 4.5 Grid convergence

- The angle from grid north to true north (clockwise), computed with proj4 by projecting the point and a point 1e-4° north of it, is **+24.86° (Maple Ridge) to +25.45° (UBC)**. It's +25.33° at Vancouver City Hall.
- Grid bearing = true bearing + γ.
- proj4 definition used:

```
EPSG:3979  +proj=lcc +lat_0=49 +lon_0=-95 +lat_1=49 +lat_2=77 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs
EPSG:3005  +proj=aea +lat_0=45 +lon_0=-126 +lat_1=50 +lat_2=58.5 +x_0=1000000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs
```

## 5. CORS summary

Curl used `Origin: https://wattyven.github.io`. Chromium ran at `http://localhost:5199`. Full output: [`cors-curl.txt`](samples/cors-curl.txt), [`browser-results.json`](samples/browser-results.json).

**Confirmed from the real origin (2026-10-07, Phase 1).** `node spike/07-deployed-check.ts https://wattyven.github.io/VanShade/` ran headless Chromium against the deployed build `200d4a0`. All 9 UI cases passed with **no console errors and no failed requests**:
- geocoder autocomplete
- geocoder resolve
- WFS point query
- WFS buffer query

**Checked again for `https://vanshade.ca` (2026-10-08), before the move to the custom domain.** With that `Origin`,
the geocoder, the WFS (with a Referer), the WCS and all 11 municipal photo services answer with
`access-control-allow-origin: https://vanshade.ca`; STAC and the S3 elevation files send `*`. Only the LidarBC proxy
needed its allow-list updated (`proxy/lidarbc/wrangler.toml`).

So the geocoder and a plain WFS `fetch` work from `https://wattyven.github.io`, and the JSONP fallback wasn't needed. COG and STAC reads from that origin get their check in Phase 2, when the app first makes them; both send `Access-Control-Allow-Origin: *`.

| Endpoint | curl ACAO | Chromium | Notes |
|---|---|---|---|
| Geocoder `addresses.json` | reflects origin | ✅ | |
| WFS GetFeature JSON | only with `Referer` | ✅ (default referrer policy) | ❌ with `no-referrer` |
| WFS JSONP (sandboxed iframe) | n/a (script) | ✅ | fallback |
| STAC search | `*` | ✅ | preflight 403, so use simple GETs only |
| S3 COG (Range) | `*`, allows `range` | ✅ | `Content-Range` not exposed (harmless) |
| S3 extent GeoJSON | `*` | ✅ | |
| WCS documented URL `/ows/elevation` | none (308) | ❌ | redirect lacks CORS |
| WCS `/wrapper/ogc/elevation-hrdem-mosaic` | reflects origin | ✅ | WCS 1.1.1 only |
| S3 COPC point clouds (Range) | `*` | ✅ | §7.3 |
| LidarBC object store | none, preflight 403 | ❌ | read through `proxy/lidarbc` (§7.1) |
| Municipal orthophoto services (11) | reflects origin (Delta `*`) | ✅ | §7.6 |

## 6. Rate limits and licences

| Source | Limit observed | Licence / attribution |
|---|---|---|
| BC Address Geocoder | 3,000 req/min, keyless | Open Government Licence – British Columbia |
| ParcelMap BC (DataBC WFS) | gateway 60,000 req/s | Open Government Licence – British Columbia. Not a legal survey. |
| HRDEM mosaic (STAC, S3, WCS) | none published | Open Government Licence – Canada 2.0. Contains information licensed under the OGL-Canada. |
| NRCan CanElevation point clouds (S3) | none published | Open Government Licence – Canada 2.0 |
| LidarBC rasters (via our proxy) | none published; Cloudflare free plan allows 100,000 requests/day | Open Government Licence – British Columbia |
| Municipal aerial photos | none published | each municipality's Open Government Licence (§7.6) |

The spike ran requests one at a time with a 350 ms gap and an in-memory cache. Geocoder: about 150 requests. WFS: about 40. Elevation: a few dozen windows. Nothing was bulk-downloaded.

## 7. Sharper and newer elevation, and aerial photos (stretch work, 2026-10-08)

Measured with `spike/12`–`19` (the `*.live.test.ts` ones run with `npx vitest run --config spike/vitest.live.config.ts`).

### 7.1 Server-side piece for data: a LidarBC CORS proxy

VanShade is a static site with two exceptions, both small Cloudflare Workers. The only one that touches data is
([`proxy/lidarbc/`](../proxy/lidarbc)) that adds CORS headers to the LidarBC object store, which has the newest LiDAR and no
CORS. It forwards `GET`/`HEAD` of LidarBC DSM/DEM tiles only, passes `Range` through, and caches at the edge for a day. The
site reads its URL from the build-time variable `VITE_LIDARBC_PROXY` (a GitHub repository variable). **Without it the site is
fully static** and skips LidarBC; everything else in this section works from the browser directly. (The other Worker,
[`proxy/gemini/`](../proxy/gemini), answers the Analysis chat and reads no map data.)

### 7.2 Which surface a lot gets

The first result always comes from HRDEM 1 m (§4). Then, in the background, the worker loads a sharper surface and swaps the
results in place (`elevation/hires.ts` lists the options; `elevation/build.ts` builds them). A lot can have up to three, and
the "Elevation data" setting (URL `elev=`) picks one:

| Choice | When it's offered | Surface |
|---|---|---|
| **Best of both** (default) | both of the others exist | the point cloud at 0.5 m where nothing changed, LidarBC where it did (§7.7) |
| **Newest survey** | LidarBC (through the proxy) is newer than the HRDEM survey and the point cloud | LidarBC, 1 m |
| **Most detailed** | an NRCan point cloud no older than the HRDEM survey | the point cloud, 0.5 m |

With only one of them, that one is used and no choice is shown. If a surface fails to load, the next is tried (best, detailed,
newest). HRDEM stays for lots over 40,000 m², or with `elev=hrdem` (debug).

Both sharper surfaces sit on HRDEM resampled into a UTM 10N grid (EPSG:3157; a 3-point affine, within 2 cm of proj4 over
440 m). HRDEM fills anything they don't cover. File lists come from `src/elevation/hires-index.json` (227 KiB, 30 KiB
gzipped, lazy-loaded), built from S3 listings by `spike/12-hires-index.ts`. A monthly workflow
(`.github/workflows/refresh-index.yml`, about 10 s) rebuilds it and opens an issue when new surveys or tiles appear. Tiles are BCGS 1:2 500 sheets (`elevation/bcgs.ts`)
or 1 km UTM squares.

### 7.3 NRCan point clouds (COPC)

- `canelevation-lidar-point-clouds.s3.ca-central-1.amazonaws.com`, `pointclouds_nuagespoints/BC/…` and `…/NRCAN/…`. CORS `*`,
  Range, S3 listing. In Metro: Lower Mainland 2016 (BCGS tiles, 13–15 points/m² per the research), Vancouver Island/Sunshine
  Coast 2018 (some coastal BCGS tiles; one measured 9 points/m²), Lower Mainland 2019/2020 and FHIMP 2023 (1 km UTM tiles;
  a FHIMP tile measured 19 points/m²).
- Read with `copc` 0.0.9 and `laz-perf` 0.0.7. laz-perf's web-worker build runs in our module worker; its `.wasm` (214 KiB)
  loads from our assets. `vite.config.ts` points copc's own `laz-perf` import at that build.
- Only octree nodes overlapping the lot + 60 m (the margin shrinks to keep the area under 40,000 m²) are read. Levels are
  chosen by density gained per point read, up to about 8 points/m². Shallow levels have nodes hundreds of metres across, so
  they're mostly skipped. Points are gridded as max z per 0.5 m cell, excluding noise classes 7 and 18, then small holes are
  filled.
- **Cost per lot: 0.5–1.0 M points, 3–8 MB, 2–5 s.** Before level selection it was 1–2.8 M points and up to 33 MB.
- **Vertical datum:** the files don't say. The median of (ground-class points − HRDEM DTM) measured 0.00 m at City Hall,
  the Kitsilano library and Maple Ridge City Hall, so the files match HRDEM's CGVD2013. The offset is still measured and removed for
  every lot, and the load is rejected above 30 m.

### 7.4 LidarBC rasters

- `nrs.objectstore.gov.bc.ca/gdwuts/092/092g/<year>/(dsm|dem)/bc_<bcgs>_xli1m_utm10_<start>_<end>[_dsm].tif`.
  **No CORS** (the preflight gets a 403). Range and S3 listing work.
- Coverage: 2025 covers Vancouver, Burnaby, the Tri-Cities, the North Shore and Maple Ridge. 2024 covers Richmond, Delta,
  Surrey and Langley. 2023 tiles are also present. 1,060 tiles in Metro.
- 1 m, GeoKeys `ProjectedCSTypeGeoKey 3157` + `VerticalCSTypeGeoKey 6647` ("NAD83(CSRS) / UTM zone 10N + CGVD2013(CGG2013)
  height"), nodata −32767, about 1,850 × 1,422 px, 0.5–34 MB per file. The origins are whole metres, so they match our
  aligned UTM grid pixel for pixel.
- **Strip TIFFs with one row per strip.** geotiff.js 3 without a block cache read each strip offset with its own 4-byte
  request: **1,358 requests** for one 450 m window. With `blockSize: 262144` it takes **10 requests** (2.5 MB, 0.2 s).
  `elevation/cog.ts` `openImage(url, { blockSize })` does this.
- Measured datum offsets against HRDEM ground: −0.06 m (City Hall), −0.04 m (Kitsilano library), +0.09 m (Surrey), −0.03 m (Maple Ridge),
  consistent with real ground change since 2016. Near the lot the newer DEM replaces HRDEM's ground model.
- Cost per lot through the proxy: 1–4 tiles, about 20–40 requests and 3–6 MB. Elevation took 0.8–1.8 s.

### 7.5 A browser cache bug in byte-range reads

Chrome's HTTP cache sometimes answers a byte range it has seen before with the wrong body. One example: **3,137 bytes for a
1,103,537-byte HRDEM tile**. geotiff then decoded a short tile and threw "Offset is outside the bounds of the DataView". It
happened when a refinement re-read tiles the first result had fetched, and on shared links to a lot already viewed. The bug
predates the refinement work, which only made it common. Every range read now goes through `elevation/rangeFetch.ts`: if
the body isn't the requested size, it's fetched again with `cache: 'reload'`.

### 7.6 Aerial photos

Always on where a municipality publishes them (there's no setting). They come from the municipalities' own orthophoto services. All 11 are keyless, send
CORS headers (they echo the origin; Delta sends `*`) and answer Web Mercator requests. `spike/18-imagery-check.ts` re-checks
them all.

| Municipality | Service | Year, pixel | Licence |
|---|---|---|---|
| City of Vancouver (also UBC/UEL) | `tiles.arcgis.com/…/Orthophotos_2025/MapServer` tiles, z19 | 2025, 7.5 cm | Made from Metro Vancouver's 2025 imagery: OGL – Metro Vancouver. The tile item itself has no licence text. |
| Burnaby | `gis.burnaby.ca/…/Burnaby_Ortho_2025/MapServer/export` | 2025, 7.5 cm | OGL – Burnaby (stated for its 2020 ortho; the 2025 service has no text) |
| Surrey | `gisservices.surrey.ca/…/AerialImages_Web_Mercator/MapServer/export`, layer 0 | 2025 | OGL – Surrey |
| Coquitlam | `geodata.coquitlam.ca/…/Imagery_2025/MapServer` tiles, z19 | 2025, 7.5 cm | OGL – Coquitlam |
| District of North Vancouver | `geoweb.dnv.org/…/Basemap_Ortho2024/MapServer/export` | 2024, 6.6 cm | OGL – North Vancouver |
| Delta | `maps.delta.ca/…/Orthophotography/2022/ImageServer/exportImage` | 2022, 10 cm | OGL – Delta |
| Maple Ridge | `geoservices.mapleridge.ca/…/2025_7_5cm/ImageServer/exportImage` | 2025, 7.5 cm | OGL – Maple Ridge |
| Township of Langley | `mapsvr.tol.ca/…/Ortho_2025/MapServer/export` | 2025, 6.6 cm | OGL – Township of Langley |
| City of Langley | `maps.langleycity.ca/…/Imagery2025/MapServer/export` | 2025 | OGL – City of Langley |
| Port Coquitlam | `maps.portcoquitlam.ca/…/Basemap_Ortho2025_Legal/MapServer/export`, layer 20 | 2025 | OGL – Port Coquitlam |
| White Rock | `maps.whiterockcity.ca/…/opendata/Ortho2025/ImageServer/exportImage` | 2025, 7.5 cm | The City's Open Data Policy 801 releases its open data under its Open Government Licence. The service sits in its `opendata` folder but has no licence text of its own. |

- **Gaps:** Richmond, the City of North Vancouver, New Westminster, West Vancouver, Port Moody, Pitt Meadows, Bowen Island and
  the villages. These say "No aerial photo is published for …; showing the 3D model."
- **Excluded:**
  - Esri World Imagery: proprietary licence, and it needs a token for basemap use.
  - BC ImageX: Access Only, `ACAO: (null)`, and the imagery is from 1999–2009.
  - `maps.vancouver.ca`: CORS is limited to vanmap.
  - Metro Vancouver's regional 7.5 cm mosaic: MrSID downloads only.
- **Request:** the lot box + 48 m, either as one export at about 0.15 m per pixel (capped at 2,048 px) or as 16–25 z19
  tiles, once per lot after the first result.
- **Placement:** in 3D the photo drapes over the high-detail terrain around the lot through a second set of texture
  coordinates, a grid → photo affine within 2 cm of proj4. On the map, it replaces the shaded relief.
- **Lean:** these are orthophotos, not true orthos, so tall buildings lean a little in them.

### 7.7 Best of both: 2016 detail, 2025 currency

**The ideal source, and why it isn't used.** LidarBC also publishes the 2024/2025 point clouds:
- `…/<year>/pointcloud/bc_<bcgs>_xyes_8_utm10_<dates>.laz`, about 31 points/m².
- They're plain LAZ 1.4 (point format 6), not COPC. The City Hall tile holds 78 million points in 458 MB, in 50,000-point
  chunks with a compressed chunk table at the end of the file, and has no spatial index.
- So reading one lot means downloading the whole file, and converting the region's roughly 1,000 tiles to COPC would mean
  hosting about 0.5 TB.

If NRCan republishes them as COPC (as it did for 2016–2023), re-running `spike/12-hires-index.ts` gives VanShade 0.5 m
detail from the newest survey with no code change.

**The merge** (`elevation/change.ts`, `build.ts` `buildMerged`). The two surveys are compared on the 1 m grid (0.5 m windows
start on whole metres, so each 1 m cell is exactly 2 × 2 cells):
1. The 2016 value per metre is the highest of its four 0.5 m cells.
2. A cell counts as changed only if 2025 is more than 2.5 m above or below every 2016 value in its 3 × 3 neighbourhood.
   This slack absorbs the surveys' horizontal offset of a few tens of centimetres.
3. A 3 × 3 opening drops slivers, and areas under 20 m² are ignored.
4. The rest grows by 2 m, so the seam between surveys lies on unchanged ground.

Changed areas take 2025 copied to 2 × 2 cells (nearest, not interpolated, so walls stay walls). Elsewhere the 2016 point cloud
is used, and LidarBC covers the window beyond the point cloud's area. Each survey's datum is checked against HRDEM ground. The
DTM near the lot comes from the 2025 DEM.

| Measured (160 × 160 m around the lot) | 410 W Georgia | Kitsilano library, among houses |
|---|---|---|
| Cells differing by more than 2.5 m, naive | 29% | 11% |
| With the ±1 cell slack | 14% | 1.7% |
| After the opening and the 20 m² minimum | 8.5% | 0% |
| Changed share as built (with the 2 m growth) | 12.8% | 0% |
| Largest change | the Deloitte Summit (finished 2023): 2,225 m², 1.8 m from the address, on average 52 m higher than 2016 | none |

Building Best of both takes about 3.5 s in Node for the downtown lot (the point cloud is about 10 MB there). In the browser,
switching between the three choices afterwards takes 0.3–1.9 s, because the worker keeps each lot's downloads
(`elevation/cache.ts`).

**Spikes.** Point-cloud and LidarBC surfaces drop cells at least 2.5 m above three-quarters of their neighbours that have
data (wires, poles, birds), replacing them with the neighbours' median. Roof edges and 2 × 2 chimneys stay.

**Vertical walls** are a rendering change only (`scene/terrain.ts` `buildTerraced`); see [`DEVELOPMENT.md`](DEVELOPMENT.md).

## 8. Typical weather (2026-10-09)

**Measured sunshine: Environment Canada's climate normals.**
- `api.weather.gc.ca/collections/climate-normals/items` (OGC API, `Access-Control-Allow-Origin: *`, Open Government Licence – Canada).
- The element is named `Total hours bright sunshine`; `MONTH` 1–12, plus 13 for the year.
- Within the region only two stations have it:

| Station | Climate ID | Record | Annual hours |
|---|---|---|---|
| Vancouver Int'l A | 1108447 | 1981–2000 (recorder retired) | 1,938 |
| Abbotsford A | 1100030 | 1981–2001 | 1,887 |

- Haney UBC RF Admin (1103332) has 1981–89 only (1,332 h a year), and isn't used.
- As a share of sunrise-to-sunset hours, Vancouver's is about 22% in January and 60% in July (April–September about 53%).

**Other sources checked:**

| Source | What it gives | Verdict |
|---|---|---|
| Open-Meteo historical weather (`archive-api.open-meteo.com`, CORS `*`, CC BY 4.0) | Daily modelled `sunshine_duration` at roughly 9–25 km | Its levels run high (January 43% at the airport vs about 22% measured), so it supplies only the **ratio** between a place and its nearer airport. The North Shore is about 3–4 points below the airport, the eastern valley 4–11%. 4-year daily requests hit 429 without a pause; 1.2 s between requests is fine. |
| Iowa Environmental Mesonet METAR archive | Hourly cloud reports | Only CYVR and CYXX (the same two airports); Pitt Meadows, Boundary Bay, Langley and Vancouver Harbour aren't archived. |
| NASA POWER climatology (CORS `*`) | Cloud amount and clearness index | One cell of about 0.5° × 0.625° covers the whole region: no local detail. |
| WeatherCAN | Environment Canada's app | No public feed of its own; this API is the open source of the same data. |

**As built.** `spike/25-weather.ts` writes `src/weather/sunshine.json` (about 6 KB): both stations' monthly hours and a 9 × 6
grid (0.15° × 0.1°) of Open-Meteo ratios for 2021–2024, each relative to its nearer airport. At run time:
- A lot's monthly share is blended from its four surrounding grid points.
- Each sampled day's factor interpolates between mid-month shares.
- Typical hours are the average of clear-day hours × factor.

