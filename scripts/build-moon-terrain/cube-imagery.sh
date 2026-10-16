#!/usr/bin/env bash
#
# Cube-face imagery pyramids for the cube-sphere experiment (issue #149), draped
# on the cube.sh terrain by packages/three/src/CubeImageryLayer.ts at their own
# levels: imagery refines (to 1.7 m texels at the pole) while the terrain keeps
# whatever depth its own error target picks. Independent of cube.sh; needs only
# numpy + GDAL Python bindings (and network access for `nac`).
#
#   ./cube-imagery.sh            # grid + registration fixtures, then the NAC mosaic
#   ./cube-imagery.sh fixtures   # the two synthetic pyramids only (offline)
#   ./cube-imagery.sh nac        # the real-imagery pyramid only
#   ./cube-imagery.sh wac-nac    # global WAC + NAC composite (the production imagery, #149); WORKERS=8 default
#
# Outputs (gitignored, not hosted), each with imagery.json:
#   apps/viewer/test-catalogs/data/moon-imagery-cube-grid/          diagnostic grid + markers.json
#   apps/viewer/test-catalogs/data/moon-imagery-cube-registration/  texel-coordinate encoding
#   apps/viewer/test-catalogs/data/moon-imagery-cube-nac/           LROC NAC south pole, 1 m source
#   apps/viewer/test-catalogs/data/moon-imagery-cube-wac-nac/       LROC WAC global 100 m + NAC south pole
#
# Fixture tiles: all faces to level 3 (1.7 km face-centre texels), then down to
# level 13 (1.66 m) around Shackleton and the exact south pole, level 10
# (13 m) around the antimeridian at 0° and 60°S and around the px/nz edge, and
# level 11 (6.6 m) at the px/py/nz corner.
# NAC tiles: every nz tile reaching the mosaic square to level 6, then 7–13
# around Shackleton and the pole; transparent subtrees are dropped.
# WAC + NAC tiles: every face to level 6 (212 m face-centre texels, 82 m at the
# corners, against WAC's 100 m), NAC composited over WAC on every tile that can
# hold NAC pixels, and the NAC regions deeper: Shackleton as for `nac`, the pole
# to level 10 (13 m) within 45 km and level 11 (6.6 m) within 20 km, which
# holds every MoonFall waypoint. Opaque grey JPEG (quality 90). The WAC mosaic is
# fetched once (6 GB, md5-checked) and converted to a local tiled COG with
# overviews, so each tile reads a small window.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
PY=${PYTHON:-python3}
DATA=../../apps/viewer/test-catalogs/data
what=${1:-all}

DEEP='4=600,5=300,6=150,7=80,8=40,9=20,10=10,11=5,12=2.5,13=1.2'
MID='4=400,5=200,6=100,7=50,8=25,9=12,10=6'
FIXTURE_REGIONS=(
  --region "shackleton@-89.67,129.78:${DEEP}"
  --region "south-pole@-90,0:${DEEP}"
  --region "antimeridian-60s@-60,180:${MID}"
  --region "antimeridian-equator@0,180:${MID}"
  --region "corner-px-py-nz@-35.26438968,45:${MID},11=3"
  --region "edge-px-nz@-45,0:${MID}"
)

if [[ ${what} == all || ${what} == fixtures ]]; then
  for pattern in grid registration; do
    rm -rf "${DATA}/moon-imagery-cube-${pattern}"
    ${PY} ../terrain/cube_imagery.py fixture --pattern "${pattern}" --global-level 3 "${FIXTURE_REGIONS[@]}" \
      --out "${DATA}/moon-imagery-cube-${pattern}"
  done
fi

if [[ ${what} == all || ${what} == nac ]]; then
  NAC=/vsicurl/https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Lunar_safed/LMAP/SouthPolar/LRO_LROC_NAC_SPOLE-90_Mosaic_1m_controlled_cog.tif
  rm -rf "${DATA}/moon-imagery-cube-nac"
  GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR GDAL_HTTP_MAX_RETRY=5 GDAL_HTTP_RETRY_DELAY=2 GDAL_HTTP_TIMEOUT=60 GDAL_HTTP_CONNECTTIMEOUT=30 VSI_CACHE=TRUE VSI_CACHE_SIZE=200000000 \
    ${PY} ../terrain/cube_imagery.py nac --source "${NAC}" --global-level 0 \
      --region 'shackleton@-89.67,129.78:1=900,2=900,3=900,4=900,5=900,6=400,7=150,8=60,9=30,10=15,11=8,12=4,13=2' \
      --region 'south-pole@-90,0:7=150,8=60,9=30,10=15,11=8,12=4,13=2' \
      --out "${DATA}/moon-imagery-cube-nac"
fi
if [[ ${what} == wac-nac ]]; then
  SRC=data/source
  WAC_TIF=Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif
  WAC_URL=https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/${WAC_TIF}
  WAC=${SRC}/wac-global-100m-cog.tif
  if [[ ! -f ${WAC} ]]; then
    mkdir -p "${SRC}"
    if [[ ! -f ${SRC}/${WAC_TIF} ]]; then
      echo "↓ ${WAC_TIF} (6.0 GB)"
      curl -fL --retry 5 -C - -o "${SRC}/${WAC_TIF}.tmp" "${WAC_URL}"
      expected=$(curl -fsS "${WAC_URL}.md5" | cut -d' ' -f1)
      actual=$( (md5sum "${SRC}/${WAC_TIF}.tmp" 2>/dev/null || md5 -r "${SRC}/${WAC_TIF}.tmp") | cut -d' ' -f1)
      [[ "${expected}" == "${actual}" ]] || { echo "md5 mismatch: ${actual} != ${expected}" >&2; exit 1; }
      mv "${SRC}/${WAC_TIF}.tmp" "${SRC}/${WAC_TIF}"
    fi
    echo "· ${WAC_TIF} → tiled COG with overviews"
    gdal_translate -q -of COG -co COMPRESS=DEFLATE -co BLOCKSIZE=512 -co OVERVIEW_RESAMPLING=AVERAGE -co BIGTIFF=YES -co NUM_THREADS=ALL_CPUS \
      "${SRC}/${WAC_TIF}" "${WAC}.tmp.tif"
    mv "${WAC}.tmp.tif" "${WAC}"
  fi
  NAC=/vsicurl/https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Lunar_safed/LMAP/SouthPolar/LRO_LROC_NAC_SPOLE-90_Mosaic_1m_controlled_cog.tif
  rm -rf "${DATA}/moon-imagery-cube-wac-nac"
  # Per worker: a 50 MB HTTP cache (×16 workers at 200 MB was several GB of RAM).
  GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR GDAL_HTTP_MAX_RETRY=5 GDAL_HTTP_RETRY_DELAY=2 GDAL_HTTP_TIMEOUT=60 GDAL_HTTP_CONNECTTIMEOUT=30 VSI_CACHE=TRUE VSI_CACHE_SIZE=50000000 \
    ${PY} ../terrain/cube_imagery.py composite --workers "${WORKERS:-8}" --base "${WAC}" --detail "${NAC}" --global-level 6 \
      --region 'shackleton@-89.67,129.78:7=150,8=60,9=30,10=15,11=8,12=4,13=2' \
      --region 'south-pole@-90,0:7=150,8=60,9=45,10=45,11=20,12=4,13=2' \
      --out "${DATA}/moon-imagery-cube-wac-nac"
fi
echo "Validate: node ../validate-cube-imagery.mjs"
