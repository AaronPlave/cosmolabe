#!/usr/bin/env bash
#
# Fused Mars terrain (issue #50): canonical USGS MOLA/HRSC global DEM plus the
# Jezero HiRISE DTM as a residual tapered to zero across a 1 km band, tiled as
# ONE quantized-mesh pyramid by scripts/terrain/dem.py. Replaces passes
# 02/03/05-07 for this product; the old pipeline stays until the catalog swap.
#
# Prerequisite: ./01-fetch-sources.sh. Needs GDAL Python bindings + numpy.
# Peak RAM ≈ 12 GB (fuse) / 11 GB + ~100 MB per worker (tile); ~5 min total.
#
# --bias none: the fitted HiRISE − MOLA/HRSC plane (offset −8.7 m, ~1 m/km) is
# disclosed in fusion.json but NOT removed. Removing it would move the terrain
# 4–14 m off the Ingenuity airfield elevations, which are in the HiRISE frame.
# Pass --bias plane to make the fused surface follow MOLA/HRSC at broad scale.
#
# --publish <build-id>: after tiling, upload the pyramid to the data host and pin
# that build for the deployed catalogs (issue #137; docs/data-hosting.md). Needs
# the R2_* credentials and DATA_BASE_URL in the environment.
#
# --regional-bounds is the JEZ CTX imagery footprint (ingenuity-jezero.json):
# imagery resolution follows terrain tile depth, so z10-15 must reach it.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PUBLISH_BUILD=""
if [[ "${1:-}" == "--publish" ]]; then
  PUBLISH_BUILD="${2:?usage: fused.sh [--publish <build-id>]}"
fi
SRC=data/source
OUT=../../apps/viewer/test-catalogs/data/mars-terrain-fused

python3 ../terrain/dem.py fuse \
  --base "${SRC}/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif" \
  --detail "${SRC}/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif" \
  --out data/fused --blend-m 1000 --bias none \
  --vertical-datum "MOLA areoid heights (m); the renderer places them as IAU-ellipsoid heights"

rm -rf "${OUT}"
python3 ../terrain/dem.py tile \
  --base "${SRC}/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif" \
  --fusion data/fused --out "${OUT}" \
  --global-zoom 9 --max-zoom 15 --ellipsoid 3396190 3376200 \
  --regional-bounds 77.16,18.21,77.70,18.72 \
  --name "Mars MOLA/HRSC + Jezero HiRISE residual" \
  --attribution "NASA/USGS MOLA, MEX HRSC, M2020 TRN HiRISE"

cp data/fused/fusion.json "${OUT}/fusion.json"
echo "Validate: node ../validate-terrain.mjs --preset mars-jezero-fused"

if [[ -n "${PUBLISH_BUILD}" ]]; then
  node ../publish-data.mjs terrain/mars-terrain-fused --build "${PUBLISH_BUILD}"
fi
