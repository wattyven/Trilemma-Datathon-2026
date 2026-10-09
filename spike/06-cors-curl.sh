#!/usr/bin/env bash
# CORS headers for every endpoint as a *.github.io origin would see them (GET + preflight).
set -u
ORIGIN="${ORIGIN:-https://vanshade.ca}"
COG=https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-mosaic-1m/2_3-mosaic-1m-dsm.tif
PT='-123.1139388%2049.261317'
declare -a NAMES URLS
add() { NAMES+=("$1"); URLS+=("$2"); }
add "geocoder addresses.json" "https://geocoder.api.gov.bc.ca/addresses.json?addressString=453%20W%2012th%20Ave%20Vancouver&maxResults=1&locationDescriptor=parcelPoint&outputSRS=4326"
add "WFS GetFeature json" "https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW&outputFormat=application/json&srsName=EPSG:4326&count=5&CQL_FILTER=INTERSECTS(SHAPE,SRID=4326;POINT($PT))"
add "WFS GetFeature json +Referer (as browsers send)" "https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW&outputFormat=application/json&srsName=EPSG:4326&count=5&CQL_FILTER=INTERSECTS(SHAPE,SRID=4326;POINT($PT))"
add "WFS GetFeature jsonp" "https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW&outputFormat=text/javascript&format_options=callback:cb&srsName=EPSG:4326&count=5&CQL_FILTER=INTERSECTS(SHAPE,SRID=4326;POINT($PT))"
add "STAC search" "https://datacube.services.geo.ca/stac/api/search?collections=hrdem-mosaic-1m&bbox=-123.115,49.26,-123.113,49.262&limit=1"
add "COG (S3) range" "$COG"
add "WCS documented URL (redirects)" "https://datacube.services.geo.ca/ows/elevation?service=WCS&request=GetCapabilities"
add "WCS final URL" "https://datacube.services.geo.ca/wrapper/ogc/elevation-hrdem-mosaic?service=WCS&version=1.1.1&request=GetCapabilities"

for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"; url="${URLS[$i]}"
  echo "=== $name"
  extra=()
  [[ "$name" == COG* ]] && extra=(-H "Range: bytes=0-1023")
  # Browsers send Referer: <origin>/ cross-origin by default; the DataBC gateway needs it for CORS.
  [[ "$name" == *Referer* ]] && extra=(-H "Referer: $ORIGIN/")
  curl -s -m 30 -o /dev/null -D - -H "Origin: $ORIGIN" ${extra[@]+"${extra[@]}"} "$url" \
    | grep -iE '^(HTTP/|access-control-|content-range|accept-ranges|x-ratelimit-limit|ratelimit-limit|location)' | sed 's/^/  GET  /'
  curl -s -m 30 -o /dev/null -D - -X OPTIONS -H "Origin: $ORIGIN" -H "Access-Control-Request-Method: GET" \
    -H "Access-Control-Request-Headers: range" "$url" \
    | grep -iE '^(HTTP/|access-control-)' | sed 's/^/  OPT  /'
  sleep 0.4
done
