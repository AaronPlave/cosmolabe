#!/usr/bin/env bash
#
# Cube-sphere experiment (issue #149): the same fused field as fused.sh and
# polar.sh, tiled on the gnomonic cube of packages/three/src/surface/CubeSphere.ts
# as 3D Tiles 1.1 (.glb per tile) plus a matching CPU height grid per tile
# (cpu-grids.json + heights/). An experiment, not a production product: it
# exists to be compared with the geographic (fused.sh) and polar-cap (polar.sh)
# baselines, which stay as they are.
#
# Prerequisite: ./01-fetch-sources.sh and ./fuse.sh (data/fused/).
#
# Levels (face-centre vertex spacing 54.3 km / 2^L; tiles are 64 cells across):
#   0–3 on all six faces (6.8 km at L3), 510 tiles;
#   Shackleton (89.67°S 129.78°E): L4 within 600 km … L11 (26.5 m) within 25 km,
#     L12 (13.3 m) within 15 km — the rim, floor and the pole itself — comparable
#     to the polar cap's L7 (24 m) / L8 (12 m);
#   the px/py/nz corner (35.26°S 45°E) and the px/nz edge midpoint (45°S 0°E):
#     L4 within 400 km … L8 (212 m) within 25 km, for seam/corner inspection.
# No skirts: mixed-LOD cracks stay visible and are measured
# (scripts/validate-cube-terrain.mjs). Add --skirt-cells 1 to hide them.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
SRC=data/source
OUT=../../apps/viewer/test-catalogs/data/moon-terrain-cube
PY=${PYTHON:-python3}
[[ -f data/fused/fusion.json ]] || { echo "run ./fuse.sh first" >&2; exit 1; }

rm -rf "${OUT}"
mkdir -p "${OUT}"
${PY} ../terrain/dem.py cube-tile \
  --base "${SRC}/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif" \
  --fusion data/fused --out "${OUT}" \
  --global-level 3 \
  --region 'shackleton@-89.67,129.78:4=600,5=300,6=150,7=80,8=50,9=40,10=30,11=25,12=15' \
  --region 'corner-px-py-nz@-35.26438968,45:4=400,5=200,6=100,7=50,8=25' \
  --region 'edge-px-nz@-45,0:4=400,5=200,6=100,7=50,8=25' \
  --ellipsoid 1737400 1737400 "$@"
cp data/fused/fusion.json "${OUT}/fusion.json"
echo "Validate: node ../validate-cube-terrain.mjs"
