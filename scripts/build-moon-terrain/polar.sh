#!/usr/bin/env bash
#
# Square-tile south-polar cap (issue #144 prototype): the same fused field as
# fused.sh, tiled as a quadtree on the LOLA mosaic's polar stereographic grid
# instead of geographic slivers, written as 3D Tiles 1.1 (.glb per tile).
#
# Prerequisite: ./01-fetch-sources.sh and the fuse step of ./fused.sh
# (data/fused/). ~20 s on 12 cores, 27 k tiles, ~4.2 GB.
#
# Levels: 0 is the whole 200 km mosaic square (3.1 km vertex spacing); each
# level halves it. 0–6 cover the square, 7 (24 m) the disc within 91 km of the
# pole (≈ 87°S, like fused.sh's z11) and 8 (12 m) within 45.5 km (≈ 88.5°S, z12).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
SRC=data/source
OUT=../../apps/viewer/test-catalogs/data/moon-terrain-polar
PY=${PYTHON:-python3}

rm -rf "${OUT}"
mkdir -p "${OUT}"
${PY} ../terrain/dem.py polar-tile \
  --base "${SRC}/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif" \
  --fusion data/fused --out "${OUT}" \
  --max-level 8 --level-radius 7=91000 --level-radius 8=45500 \
  --ellipsoid 1737400 1737400
