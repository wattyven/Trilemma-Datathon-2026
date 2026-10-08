# VanShade data sources (Phase 0 findings)

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
| **Elevation path** | **A: direct COG window reads with geotiff.js ≥ 3** from NRCan's S3 bucket. Works in Chromium with no proxy. A cold DSM + DTM load for a lot plus a 200 m buffer took **1.9–2.3 s and 8.3 MiB** in parallel. B (WCS 1.1.1) also works and stays as a documented fallback. **C and D are not needed.** |
| **Parcel path** | Direct `fetch` to the DataBC WFS. CORS works **only when the browser sends a `Referer`**, which it does by default. Never set `Referrer-Policy: no-referrer`. Fallback: WFS JSONP loaded inside a sandboxed iframe (verified). No proxy. |
| **Scope filter** | Geocoder `bbox`, then a `localityName` allow-list or `electoralArea == "MVRD Electoral Area A"`, then a parcel `REGIONAL_DISTRICT == "Metro Vancouver Regional District"` check. |
| **Vintage** | The newest `hrdem-lidar` project whose **extent GeoJSON** contains the point. Precompute a small Metro-clipped lookup in Phase 2. Most of the region is **2016** LiDAR. |
| **Convergence** | Grid north to true north is **+24.9° to +25.4°** (clockwise) across Metro Vancouver, computed numerically per lot with proj4 as §5.1 asks. |

## Surprises worth knowing

1. **The parcel layer name in the spec is restricted.** `WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_FA_SVW` is "ParcelMap BC Parcel Fabric – Fully Attributed", licensed *Access Only*. The WFS answers it with `Could not find type`. The public OGL-BC layer is **`WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW`**.
2. **The geocoder rate limit is 3,000/min**, from the `x-ratelimit-limit-minute` header, not about 1,000.
3. **`parcelPoint` isn't always available.** For `BLOCK`-precision matches, the geocoder silently returns an `accessPoint` instead, and that point falls in the street. Coquitlam City Hall (3000 Guildford Way) hit **zero parcels** this way. A buffered parcel search handles it.
4. **`localityName` doesn't filter.** `localityName=Burnaby,Surrey` still returned Vancouver and Kamloops matches. Filter on the client.
5. **Locality names aren't the member names in §8.** Addresses carry "District of North Vancouver" and "Township of Langley". UBC/UEL addresses carry "Vancouver". Electoral Area A shows up in `electoralArea`.
6. **WFS CORS depends on `Referer`, not `Origin`.** With curl, no origin ever gets `Access-Control-Allow-Origin` unless a `Referer` is sent.
7. **The WCS URL in the spec is a 308 redirect with no CORS headers**, so browsers can't follow it. Only **WCS 1.1.1** GetCoverage works on the final URL.
8. **STAC item footprints overstate coverage**, so they can't be used for vintage. The per-project `extent` GeoJSON is accurate.
9. **Strata parcels come back as stacked identical polygons**, one per strata lot. Deduplicate them.
10. **The data is older than you might expect:** 12 of the 14 Metro test points come from 2016 LiDAR.
11. **SunCalc 2 changed every convention §5.4 assumes** (found in Phase 2, released June 2026; we use 2.1.1). Angles are degrees, azimuth is clockwise from true north, and altitude is apparent (refraction-corrected). `getTimes` takes an optional UTC offset for the civil day.
12. **STAC `proj:transform` on the HRDEM items is in GDAL geotransform order**, `[originX, res, 0, originY, 0, −res]`, not the STAC `[a…f]` order. The app reads tile geometry from the COG header instead.
14. **British Columbia dropped clock changes.** IANA tzdb 2026b (April 2026) says BC moved to permanent UTC−7 on 2026-03-09, so Vancouver doesn't fall back on 2026-11-01. DST-aware handling through luxon/Intl still works, but only on runtimes with tz data 2026b or later. Node 25.8.1 (tz 2026a) still models UTC−8 for winter 2026. Sun positions use UTC instants and are unaffected; only how user-entered local times are read and how times are displayed depend on it. Current browsers update their tz data regularly.
13. **The EPSG:3979 scale factor in Metro Vancouver is about 0.999**, so a 1 m grid pixel is about 1.001 m on the ground. The effect on horizon angles (under 0.05°) is ignored.

---

## 1. BC Address Geocoder (§4.1)

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

**Test addresses.** All are civic buildings. All scored 99–100.

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

## 2. Metro Vancouver scope (§8)

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

## 3. ParcelMap BC (§4.2)

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

**Axis order (gotcha #3):**
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
| Strata | `PARCEL_CLASS = "Building Strata"`, one identical polygon **per strata lot**. 297 of 300 parcels in a downtown 300 m box were strata. Strata plan prefixes: BCS, LMS, EPS, NWS, VAS. Subdivision plans: BCP, LMP, EPP, NWP, VAP. | Deduplicate and show the strata/complex notice. |
| Very large lots | UBC: one 924,398 m² `Subdivision / Private / NO_PLAN` parcel with `MUNICIPALITY: "Rural"`. | The §5.1 cell cap and coarsening are essential. |

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

## 4. NRCan HRDEM 1 m mosaic (§4.3)

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

- **DSM and DTM share an identical grid** (same VRT size, GeoTransform and nodata), so gotcha #6 holds.
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

### 4.3 Vintage (§4.3(d))

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

- **The spec URL** `https://datacube.services.geo.ca/ows/elevation` returns **308** to `https://datacube.services.geo.ca/wrapper/ogc/elevation-hrdem-mosaic`. The redirect has **no CORS header**, so Chromium blocks it. **Call the final URL directly.**
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

### 4.5 Grid convergence (§5.1)

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

So the geocoder and a plain WFS `fetch` work from `https://wattyven.github.io`, and the JSONP fallback wasn't needed. COG and STAC reads from that origin get their check in Phase 2, when the app first makes them; both send `Access-Control-Allow-Origin: *`.

| Endpoint | curl ACAO | Chromium | Notes |
|---|---|---|---|
| Geocoder `addresses.json` | reflects origin | ✅ | |
| WFS GetFeature JSON | only with `Referer` | ✅ (default referrer policy) | ❌ with `no-referrer` |
| WFS JSONP (sandboxed iframe) | n/a (script) | ✅ | fallback |
| STAC search | `*` | ✅ | preflight 403, so use simple GETs only |
| S3 COG (Range) | `*`, allows `range` | ✅ | `Content-Range` not exposed (harmless) |
| S3 extent GeoJSON | `*` | ✅ | |
| WCS spec URL `/ows/elevation` | none (308) | ❌ | redirect lacks CORS |
| WCS `/wrapper/ogc/elevation-hrdem-mosaic` | reflects origin | ✅ | WCS 1.1.1 only |

## 6. Rate limits and licences

| Source | Limit observed | Licence / attribution |
|---|---|---|
| BC Address Geocoder | 3,000 req/min, keyless | Open Government Licence – British Columbia |
| ParcelMap BC (DataBC WFS) | gateway 60,000 req/s | Open Government Licence – British Columbia. Not a legal survey. |
| HRDEM mosaic (STAC, S3, WCS) | none published | Open Government Licence – Canada 2.0. Contains information licensed under the OGL-Canada. |

The spike ran requests one at a time with a 350 ms gap and an in-memory cache. Geocoder: about 150 requests. WFS: about 40. Elevation: a few dozen windows. Nothing was bulk-downloaded.
