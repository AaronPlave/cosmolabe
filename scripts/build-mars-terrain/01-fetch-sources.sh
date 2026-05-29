#!/usr/bin/env bash
#
# Download MOLA-aligned Mars terrain source GeoTIFFs.
#
# Global tier (~11 GB):
#   Mars MGS MOLA - MEX HRSC Blended DEM Global 200m
#   https://astrogeology.usgs.gov/search/map/mars_mgs_mola_mex_hrsc_blended_dem_global_200m
#
# Jezero detail tier (~few hundred MB):
#   Mars 2020 Terrain Relative Navigation HiRISE DTM Mosaic, 1 m/px,
#   MOLA-aligned via DeltaGeoid correction.
#   https://astrogeology.usgs.gov/search/map/mars_2020_terrain_relative_navigation_hirise_dtm_mosaic
#
# Both products are public domain (NASA / USGS).
#
# Idempotent: skips files that already exist on disk.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${SCRIPT_DIR}/data/source"
mkdir -p "${SOURCE_DIR}"

MOLA_HRSC_URL="https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif"
MOLA_HRSC_FILE="${SOURCE_DIR}/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif"

HIRISE_URL="https://planetarymaps.usgs.gov/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif"
HIRISE_FILE="${SOURCE_DIR}/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif"

fetch() {
  local url="$1"
  local out="$2"
  if [[ -f "${out}" ]]; then
    echo "  ✓ exists: $(basename "${out}") ($(du -h "${out}" | cut -f1))"
    return 0
  fi
  echo "  ↓ fetching: $(basename "${out}")"
  echo "    from: ${url}"
  curl -fL --progress-bar -o "${out}.tmp" "${url}"
  mv "${out}.tmp" "${out}"
}

verify_with_gdalinfo() {
  local file="$1"
  if ! command -v gdalinfo >/dev/null 2>&1; then
    echo "  ⚠ gdalinfo not installed; skipping verification of $(basename "${file}")."
    return 0
  fi
  echo "  · $(basename "${file}"):"
  gdalinfo "${file}" | grep -E "^(Driver|Size|Coordinate System|Pixel Size|NoData|Origin|Upper|Lower|Center)" | sed 's/^/    /'
}

echo "==> 1/2 Fetching global MOLA-HRSC blended DEM (~11 GB)..."
fetch "${MOLA_HRSC_URL}" "${MOLA_HRSC_FILE}"

echo "==> 2/2 Fetching Jezero HiRISE 1 m DTM..."
fetch "${HIRISE_URL}" "${HIRISE_FILE}"

echo ""
echo "==> Verifying sources with gdalinfo..."
verify_with_gdalinfo "${MOLA_HRSC_FILE}"
verify_with_gdalinfo "${HIRISE_FILE}"

echo ""
echo "Done. Next: ./02-build-elevation-vrt.sh"
