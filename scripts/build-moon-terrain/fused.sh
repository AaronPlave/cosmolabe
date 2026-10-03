#!/usr/bin/env bash
#
# Fused Moon terrain (issue #48): canonical LOLA LDEM 118 m global DEM plus the
# LOLA south-pole 87°S mosaic (10 m) as a residual tapered to zero across a
# 2 km band, tiled as ONE quantized-mesh pyramid by scripts/terrain/dem.py.
#
# Prerequisite: ./01-fetch-sources.sh. Needs GDAL Python bindings + numpy.
# Peak RAM ≈ 7 GB (fuse, ~7 min on 4 cores) / ~4 GB + ~100 MB per worker (tile).
#
# The polar mosaic is polar stereographic: dem.py keeps its residual on that
# grid and, inside its coverage, hands the base over to its detail-grid
# resample, so the surface is single-valued at the pole.
#
# --bias none: the fitted polar − global plane (−0.24 m, <0.002 m/km) is
# disclosed in fusion.json but not removed; it is negligible and both sources
# share the LOLA frame of the authoritative MoonFall waypoints.
#
# Zooms: global to z9 (≈167 m vertex spacing, matching 118 m LOLA). Geographic
# tiles are slivers at the pole and every polar row costs 2^(z+1) tiles, so the
# regional levels narrow with depth: z10 over the whole mosaic, z11 south of
# 87°S, z12 (≈21 m spacing, the 20 m pyramid level) south of 88.5°S, which
# covers every MoonFall waypoint.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
SRC=data/source
OUT=../../apps/viewer/test-catalogs/data/moon-terrain-fused
PY=${PYTHON:-python3}

${PY} ../terrain/dem.py fuse \
  --base "${SRC}/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif" \
  --detail "${SRC}/ldem_87s_10mpp.tif" \
  --out data/fused --blend-m 2000 --bias none \
  --vertical-datum "LOLA heights (m) above the 1737.4 km reference sphere (both sources)"

rm -rf "${OUT}"
${PY} ../terrain/dem.py tile \
  --base "${SRC}/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif" \
  --fusion data/fused --out "${OUT}" \
  --global-zoom 9 --max-zoom 12 \
  --zoom-bounds 11=-180,-90,180,-87 --zoom-bounds 12=-180,-90,180,-88.5 \
  --ellipsoid 1737400 1737400 \
  --name "Moon LOLA 118 m + south-pole LOLA 10 m residual" \
  --attribution "NASA/GSFC LRO LOLA (Barker et al. 2021 south-pole mosaic), USGS Astrogeology"

cp data/fused/fusion.json "${OUT}/fusion.json"
echo "Validate: node ../validate-terrain.mjs --preset moon-shackleton-fused"
