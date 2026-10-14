#!/usr/bin/env bash
#
# The fuse step shared by every Moon terrain product (issue #48): canonical LOLA
# LDEM 118 m global DEM plus the LOLA south-pole 87°S mosaic (10 m) as a residual
# tapered to zero across a 2 km band, written to data/fused/. fused.sh (geographic
# quantized mesh), polar.sh (#144 polar cap) and cube.sh (#149 cube sphere) all
# tile this one field.
#
# Prerequisite: ./01-fetch-sources.sh. Needs GDAL Python bindings + numpy.
# Peak RAM ≈ 7 GB, ~7 min on 4 cores.
#
# The polar mosaic is polar stereographic: dem.py keeps its residual on that
# grid and, inside its coverage, hands the base over to its detail-grid
# resample, so the surface is single-valued at the pole.
#
# --bias none: the fitted polar − global plane (−0.24 m, <0.002 m/km) is
# disclosed in fusion.json but not removed; it is negligible and both sources
# share the LOLA frame of the authoritative MoonFall waypoints.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
SRC=data/source
PY=${PYTHON:-python3}

${PY} ../terrain/dem.py fuse \
  --base "${SRC}/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif" \
  --detail "${SRC}/ldem_87s_10mpp.tif" \
  --out data/fused --blend-m 2000 --bias none \
  --vertical-datum "LOLA heights (m) above the 1737.4 km reference sphere (both sources)"
