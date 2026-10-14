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
#
# Outputs (gitignored, not hosted), each with imagery.json:
#   apps/viewer/test-catalogs/data/moon-imagery-cube-grid/          diagnostic grid + markers.json
#   apps/viewer/test-catalogs/data/moon-imagery-cube-registration/  texel-coordinate encoding
#   apps/viewer/test-catalogs/data/moon-imagery-cube-nac/           LROC NAC south pole, 1 m source
#
# Fixture tiles: all faces to level 3 (1.7 km face-centre texels), then down to
# level 13 (1.66 m) around Shackleton and the exact south pole, level 10
# (13 m) around the antimeridian at 0° and 60°S and around the px/nz edge, and
# level 11 (6.6 m) at the px/py/nz corner.
# NAC tiles: every nz tile reaching the mosaic square to level 6, then 7–13
# around Shackleton and the pole; transparent subtrees are dropped.

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
  GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR GDAL_HTTP_MAX_RETRY=5 GDAL_HTTP_RETRY_DELAY=2 VSI_CACHE=TRUE VSI_CACHE_SIZE=200000000 \
    ${PY} ../terrain/cube_imagery.py nac --source "${NAC}" --global-level 0 \
      --region 'shackleton@-89.67,129.78:1=900,2=900,3=900,4=900,5=900,6=400,7=150,8=60,9=30,10=15,11=8,12=4,13=2' \
      --region 'south-pole@-90,0:7=150,8=60,9=30,10=15,11=8,12=4,13=2' \
      --out "${DATA}/moon-imagery-cube-nac"
fi
echo "Validate: node ../validate-cube-imagery.mjs"
