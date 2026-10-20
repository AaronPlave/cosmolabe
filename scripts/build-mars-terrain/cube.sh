#!/usr/bin/env bash
# Bounded issue #245 foundation product. Reuse the #50 fusion; never refit it.
# MARS_TERRAIN_ROOT may point at another checkout's scripts/build-mars-terrain.
# Fetch MEGA90N000EB.LBL + MEGA90N000EB.IMG from the official MOLA MEG016
# directory first (docs/design/mars-cube-foundation.md). No publishing here.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
TERRAIN_ROOT=${MARS_TERRAIN_ROOT:-.}
OUT=${CUBE_OUT:-../../apps/viewer/test-catalogs/data/mars-terrain-cube-jezero}
PY=${PYTHON:-python3}
AREOID=${MARS_AREOID:-${TERRAIN_ROOT}/data/source/MEGA90N000EB.LBL}
[[ -f "${TERRAIN_ROOT}/data/fused/fusion.json" ]] || { echo 'Missing #50 fusion: set MARS_TERRAIN_ROOT to its existing build directory.' >&2; exit 1; }
[[ -f "${AREOID}" ]] || { echo 'Missing areoid radius raster: set MARS_AREOID (see docs/design/mars-cube-foundation.md).' >&2; exit 1; }
[[ ! -e "${OUT}" ]] || { echo "Output already exists: choose a fresh CUBE_OUT (${OUT})." >&2; exit 1; }
${PY} ../terrain/dem.py cube-tile \
  --base "${TERRAIN_ROOT}/data/source/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif" \
  --fusion "${TERRAIN_ROOT}/data/fused" --out "${OUT}" \
  --ellipsoid 3396190 3376200 --body Mars --frame IAU_MARS \
  --source-convention areoid-radial --areoid "${AREOID}" \
  --global-level 0 \
  --region 'jezero@18.45,77.4:1=80,2=60,3=50,4=35,5=25,6=18,7=12,8=8,9=6,10=4,11=2' "$@"
cp "${TERRAIN_ROOT}/data/fused/fusion.json" "${OUT}/fusion.json"
${PY} ../terrain/dem.py cube-error "${OUT}"
echo "Validate: node scripts/validate-cube-terrain.mjs --dir ${OUT} --site 18.65,77.4"
