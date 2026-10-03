#!/usr/bin/env bash
#
# Fetch the public sources for the fused Moon terrain (issue #48) into
# data/source/. USGS Astrogeology mirrors both LOLA products on S3; NASA PGDA
# (the south-pole mosaic's original host) is not needed.
#
#   1. Canonical global: LRO LOLA LDEM 118 m (Mar 2014), 8.5 GB, Int16 half-metres
#      above the 1737.4 km sphere. The same file build-moonfall-flights.mjs samples
#      for the authoritative MoonFall waypoint elevations.
#   2. South-pole control surface: LOLA 87°S mosaic (Barker et al. 2021, PGDA
#      product 81), polar stereographic, 5 m/px COG. Only its 10 m overview is
#      fetched (~690 MB): the pyramid's deepest polar level samples 20 m.
#
# Requires curl and GDAL (gdal_translate reads the COG over HTTP ranges).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
SRC=data/source
mkdir -p "${SRC}"
S3=https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic

GLOBAL=Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif
if [[ ! -f "${SRC}/${GLOBAL}" ]]; then
  echo "↓ ${GLOBAL} (8.5 GB)"
  curl -fL --retry 5 -C - -o "${SRC}/${GLOBAL}.tmp" "${S3}/${GLOBAL}"
  mv "${SRC}/${GLOBAL}.tmp" "${SRC}/${GLOBAL}"
fi
echo "· verifying ${GLOBAL}"
expected=$(curl -fsS "${S3}/${GLOBAL}.md5" | cut -d' ' -f1)
actual=$( (md5sum "${SRC}/${GLOBAL}" 2>/dev/null || md5 -r "${SRC}/${GLOBAL}") | cut -d' ' -f1)
[[ "${expected}" == "${actual}" ]] || { echo "md5 mismatch: ${actual} != ${expected}" >&2; exit 1; }

# The COG stores metres (its NetCDF actual_range metadata says km; it is stale).
POLAR=ldem_87s_10mpp.tif
if [[ ! -f "${SRC}/${POLAR}" ]]; then
  echo "↓ ${POLAR} (10 m overview of ldem_87s_5mpp_cog.tif, ~690 MB)"
  GDAL_HTTP_MAX_RETRY=5 GDAL_HTTP_RETRY_DELAY=2 gdal_translate -q -oo OVERVIEW_LEVEL=0 \
    -co TILED=YES -co COMPRESS=DEFLATE -co PREDICTOR=3 -co BIGTIFF=YES \
    "/vsicurl/${S3}/Lunar_safed/LMAP/SouthPolar/ldem_87s_5mpp_cog.tif" "${SRC}/${POLAR}.tmp.tif"
  mv "${SRC}/${POLAR}.tmp.tif" "${SRC}/${POLAR}"
fi
gdalinfo "${SRC}/${POLAR}" | grep -E "^(Size|Pixel Size|Origin)"
echo "Done. Next: ./fused.sh"
