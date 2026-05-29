#!/usr/bin/env bash
#
# Composite the two source GeoTIFFs into a single GDAL VRT for tiling.
#
# What USGS already solved for us:
#   The HiRISE→MOLA REGISTRATION. The HiRISE product's `MOLAtopography_DeltaGeoid`
#   provenance encodes that heights have been shifted to MOLA. We don't shift
#   anything ourselves.
#
# What this script does:
#   The COVERAGE composite. HiRISE only covers the ~25 km Jezero TRN footprint;
#   outside that the file is nodata. We list HiRISE first so it wins where it
#   has coverage, MOLA-HRSC fills in everywhere else.
#
# Both sources are already in equirectangular geographic (Eqc latTs0 lon0)
# per their filenames, so no reprojection is needed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${SCRIPT_DIR}/data/source"
OUT_DIR="${SCRIPT_DIR}/data"

MOLA_HRSC_FILE="${SOURCE_DIR}/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif"
HIRISE_FILE="${SOURCE_DIR}/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif"
# Reprojected to a REAL GeoTIFF (not a VRT) — HiRISE is in Equirectangular Mars
# meters, MOLA-HRSC is in geographic Mars degrees. Both Mars 2000 Sphere
# (R=3396190 m) but different coordinate-system types, so they can't be
# composited directly. We materialize to a GeoTIFF because `gdalwarp -of VRT
# -dstnodata N` only updates the *metadata* nodata field — the actual stored
# values still hold the source's nodata sentinel (HiRISE's `-3.4e38` float32
# min). CTB scans real pixel values for per-tile min/max and ignores VRT nodata
# metadata, so the float-min sentinel leaks into tile headers and corrupts the
# height quantization (minHeight=-3.4e38 → all decoded heights ≈ 0m, terrain
# appears ~2.5 km higher than it should be). Writing real GeoTIFF makes
# gdalwarp physically place -32768 in nodata cells.
HIRISE_WARPED_TIF="${OUT_DIR}/hirise_geographic.tif"
# MOLA-HRSC is Int16; warped HiRISE is Float32. gdalbuildvrt refuses mixed types,
# so we re-type MOLA-HRSC to Float32 via another tiny lazy VRT wrapper.
MOLA_FLOAT32_VRT="${OUT_DIR}/mola_hrsc_float32.vrt"
COMPOSITE_VRT="${OUT_DIR}/composite.vrt"
# Bounded composite for the HiRISE-detail tiling pass (Pass B in 03-tile.sh).
# Inside HiRISE coverage → HiRISE values; outside (where HIRISE_WARPED_TIF
# reads as -32768) → fall through to MOLA. Extent = HiRISE bbox + small buffer
# so CTB only generates ~6k tiles in/around Jezero (not billions globally).
# Without this, Pass B tiled from HIRISE_WARPED_TIF directly, which had -32768
# in non-coverage cells → 30 km cliffs at tile edges.
JEZERO_COMPOSITE_VRT="${OUT_DIR}/jezero_composite.vrt"
# Extent must be aligned to the z9 TMS-geodetic tile grid (not z10) so the
# composite covers FULL z9 tiles around Jezero. This lets Pass A (z0-9) tile
# from this composite within Jezero too, overwriting the MOLA-only z9 tiles
# in that region. Result: Pass A and Pass B both derive z0-14 in Jezero from
# the same source → no LOD-pop "curtains" at the z9/z10 transition.
# z9 tile width = 360/1024 = 0.3515625°. Jezero's HiRISE coverage falls in
# z9 tiles X=731..732, Y=307..308 → bbox below is the union of those four
# z9 tiles' geographic bounds.
# Padded outward by one z9 tile on every side beyond the four z9 tiles that
# actually cover Jezero's HiRISE footprint (X=731..732, Y=307..308). Padding
# matters: empirically, CTB's sample kernel reaches slightly past a tile's
# geographic bounds, and samples falling outside the VRT extent return nodata
# (encoded as 0 in the tile's height range, polluting maxH=0 in 3 of 4 Jezero
# z9 tiles and producing 20-28 m mismatches at tile corners). The padded ring
# absorbs that out-of-bounds sampling. Pad bbox = 4×4 z9 tiles around Jezero.
JEZERO_TE="76.6601563 17.6953125 78.0664063 19.1015625"

# Mars 2000 Sphere geographic CRS (lat/lon, planetocentric, R=3396190 m).
# Matches MOLA-HRSC's native CRS; PROJ4 form is portable across PROJ versions.
MARS_GEOG_CRS="+proj=longlat +R=3396190 +no_defs"

# NoData values discovered via gdalinfo on the two sources.
MOLA_NODATA=-32768
HIRISE_NODATA=-3.4028227e+38

require() {
  if [[ ! -f "$1" ]]; then
    echo "  ✗ missing: $1"
    echo "    Run ./01-fetch-sources.sh first."
    exit 1
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "  ✗ missing required tool: $1"
    echo "    On macOS: brew install gdal"
    exit 1
  fi
}

require "${MOLA_HRSC_FILE}"
require "${HIRISE_FILE}"
require_cmd gdalwarp
require_cmd gdal_translate
require_cmd gdalbuildvrt
require_cmd gdaladdo
require_cmd gdalinfo
require_cmd gdallocationinfo

echo "==> Re-typing MOLA-HRSC Int16 → Float32 (lazy VRT wrapper)..."
# gdalbuildvrt refuses mixed band types (HiRISE warps out as Float32, MOLA-HRSC
# is Int16). This produces a tiny VRT XML file that lazily promotes the source
# at read time — no GB of intermediate raster on disk.
gdal_translate \
  -ot Float32 \
  -of VRT \
  "${MOLA_HRSC_FILE}" \
  "${MOLA_FLOAT32_VRT}"

echo ""
echo "==> Warping HiRISE from Equirectangular Mars meters to Geographic Mars 2000 sphere..."
# HiRISE source CRS is Equirectangular Mars 2000 Sphere (projected, meters);
# MOLA-HRSC is in Geographic Mars 2000 Sphere (unprojected lat/lon). gdalbuildvrt
# refuses mixed projected+geographic inputs, so we warp HiRISE to match MOLA-HRSC's
# CRS. Bilinear preserves elevation detail without over-smoothing.
#
# Caveat: gdalwarp's `-dstnodata` only updates *metadata* — destination pixels
# at source-nodata locations still hold the source's float32 sentinel
# (-3.4e38). That sentinel then leaks into CTB's per-tile min/max scan and
# corrupts height quantization. We need a follow-up gdal_calc.py pass to
# physically remap the sentinel to -32768.
HIRISE_WARPED_RAW="${OUT_DIR}/hirise_geographic_raw.tif"
gdalwarp \
  -overwrite \
  -t_srs "${MARS_GEOG_CRS}" \
  -srcnodata "${HIRISE_NODATA}" \
  -dstnodata "${MOLA_NODATA}" \
  -r bilinear \
  -of GTiff \
  -co COMPRESS=DEFLATE \
  -co TILED=YES \
  -co BIGTIFF=IF_SAFER \
  "${HIRISE_FILE}" \
  "${HIRISE_WARPED_RAW}"

echo ""
echo "==> Physically remapping float32-sentinel nodata pixels to ${MOLA_NODATA}..."
# Threshold compare rather than exact float == (compression round-trip jitter,
# bilinear-resample weighted averaging of valid/nodata neighbors, etc. produce
# a tail of bogus values between -1e29 and -3.4e38 — not all at the exact float
# min). Mars's global elevation range is ~[-8200, +21229] m, so anything below
# -50000 m is clearly not a real elevation. We treat all such values as nodata.
gdal_calc.py \
  --overwrite \
  -A "${HIRISE_WARPED_RAW}" \
  --outfile="${HIRISE_WARPED_TIF}" \
  --calc="where(A < -50000, ${MOLA_NODATA}, A)" \
  --NoDataValue="${MOLA_NODATA}" \
  --type=Float32 \
  --co=COMPRESS=DEFLATE \
  --co=TILED=YES \
  --co=BIGTIFF=IF_SAFER
rm -f "${HIRISE_WARPED_RAW}"

echo ""
echo "==> Building composite VRT (HiRISE wins where present, MOLA fallback)..."
# gdalbuildvrt compositing rule: LATER sources cover earlier ones. List MOLA
# first (fallback layer), HiRISE last (priority — wins inside its coverage).
# `-resolution highest` keeps the VRT's reported resolution at HiRISE's
# 1 m/px so CTB can sample full detail in Jezero.
# `-srcnodata` tells gdalbuildvrt the same nodata applies to both inputs now
# (we normalised HiRISE during the warp above).
gdalbuildvrt \
  -resolution highest \
  -srcnodata "${MOLA_NODATA}" \
  -vrtnodata "${MOLA_NODATA}" \
  -overwrite \
  "${COMPOSITE_VRT}" \
  "${MOLA_FLOAT32_VRT}" \
  "${HIRISE_WARPED_TIF}"

echo ""
echo "==> Building bounded Jezero composite for HiRISE-detail tiling pass..."
# Same compositing rule (HiRISE wins, MOLA fallback) but clipped to the
# HiRISE bbox + buffer. CTB tiles only within this extent so we don't end up
# tiling MOLA globally at z15. Without this bounded VRT, Pass B saw -32768
# values from the warped HiRISE TIF outside its coverage and rendered them
# as 30 km cliffs.
# shellcheck disable=SC2086
gdalbuildvrt \
  -resolution highest \
  -srcnodata "${MOLA_NODATA}" \
  -vrtnodata "${MOLA_NODATA}" \
  -te ${JEZERO_TE} \
  -overwrite \
  "${JEZERO_COMPOSITE_VRT}" \
  "${MOLA_FLOAT32_VRT}" \
  "${HIRISE_WARPED_TIF}"

echo ""
echo "==> Building per-source overview sidecars..."
# We can't build overviews on the *composite* VRT because at -resolution highest
# it spans the globe at HiRISE's 1 m/px (~21M × 21M pixels) and the overview
# tile arrays exceed the GeoTIFF 2 GB limit.
#
# Instead, build .ovr sidecars on each source individually. CTB picks them up
# transparently through the composite VRT — MOLA-HRSC gets read from a coarse
# overview for low-zoom global tiles, HiRISE from a coarse overview for zooms
# inside Jezero that don't need 1 m detail.
#
# `-ro` writes external .ovr (so we don't try to mutate the 11 GB strip-organized
# MOLA TIFF in place). BigTIFF on the overview side handles MOLA-HRSC's size.
echo "  · MOLA-HRSC (this is slow — ~11 GB, scanline-organized, no existing overviews)..."
MOLA_OVR="${MOLA_HRSC_FILE}.ovr"
if [[ -f "${MOLA_OVR}" ]]; then
  echo "    ✓ exists: $(du -h "${MOLA_OVR}" | cut -f1)"
else
  GDAL_CACHEMAX=2048 \
  gdaladdo \
    -ro \
    -r average \
    --config BIGTIFF_OVERVIEW YES \
    --config COMPRESS_OVERVIEW DEFLATE \
    "${MOLA_HRSC_FILE}" \
    2 4 8 16 32 64 128 256
fi

echo "  · HiRISE warped VRT..."
HIRISE_OVR="${HIRISE_WARPED_TIF}.ovr"
if [[ -f "${HIRISE_OVR}" ]]; then
  echo "    ✓ exists: $(du -h "${HIRISE_OVR}" | cut -f1)"
else
  gdaladdo \
    -ro \
    -r average \
    --config COMPRESS_OVERVIEW DEFLATE \
    "${HIRISE_WARPED_TIF}" \
    2 4 8 16 32 64 128
fi

echo ""
echo "==> Sanity-checking composite..."
# Composite is in Mars geographic CRS — pass coords in that CRS directly
# (no -wgs84, which would trigger PROJ's Earth-vs-Mars celestial-body refusal).
# `gdallocationinfo` interprets lon/lat in the file's native CRS when no -wgs84.
echo "  Wright Brothers Field (77.4508 E, 18.4447 N) — should hit HiRISE detail:"
gdallocationinfo -geoloc "${COMPOSITE_VRT}" 77.4508 18.4447 | sed 's/^/    /'
echo "  Equator/Prime meridian (0, 0) — should fall back to MOLA-HRSC:"
gdallocationinfo -geoloc "${COMPOSITE_VRT}" 0 0 | sed 's/^/    /'

echo ""
echo "Done. VRT: ${COMPOSITE_VRT}"
echo "Next: ./03-tile.sh"
