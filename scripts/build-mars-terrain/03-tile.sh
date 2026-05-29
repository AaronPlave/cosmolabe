#!/usr/bin/env bash
#
# Tile the elevation sources into a quantized-mesh pyramid via
# tumgis/ctb-quantized-mesh.
#
# Output: apps/viewer/test-catalogs/data/mars-terrain/
#   layer.json + {z}/{x}/{y}.terrain (TMS geodetic, 2 root tiles).
#
# Strategy — two source-specific passes (NOT one pass on the composite):
#   The composite VRT is at -resolution highest = HiRISE's 1 m/px globally,
#   so a single ctb-tile -s 15 -e 0 on it would generate ~3 billion tiles,
#   most of them upsampled-MOLA junk. Instead, tile each tier from its own
#   bounded source:
#
#     Pass A: MOLA-HRSC float32 VRT, z 0 → 9
#             Global coverage at MOLA's native ~200 m/px. ~700k tiles, ~1 GB.
#
#     Pass B: HiRISE warped VRT, z 10 → 15
#             Only Jezero's ~22 km extent. ~5k tiles. Bounded source extent
#             means CTB only writes tiles where data exists.
#
#     Pass C: 04-write-layer-json.mjs
#             Walks the actual on-disk tile tree and emits layer.json with
#             accurate per-zoom `available` ranges. (ctb-tile -l on a global
#             1 m/px composite VRT hangs trying to enumerate billions of
#             theoretical tile positions — this approach is faster + more
#             accurate.)
#
# CTB encodes vertex z relative to an implicit Earth-WGS84 ellipsoid; we
# compensate via `referenceRadiusOffsetKm` in the catalog (a single global
# constant, calibrated after first run — see README "Calibration").

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

DATA_DIR="${SCRIPT_DIR}/data"
MOLA_VRT="${DATA_DIR}/mola_hrsc_float32.vrt"
# Bounded Jezero composite for the HiRISE-detail pass. Inside HiRISE coverage
# we read HiRISE values; outside, the VRT falls through to MOLA. Without this
# bounded composite, Pass B sees -32768 (HiRISE nodata as actual stored value)
# at coverage edges and renders 30 km cliffs at tile boundaries.
JEZERO_COMPOSITE_VRT="${DATA_DIR}/jezero_composite.vrt"
COMPOSITE_VRT="${DATA_DIR}/composite.vrt"
OUT_DIR="${REPO_ROOT}/apps/viewer/test-catalogs/data/mars-terrain"

for f in "${MOLA_VRT}" "${JEZERO_COMPOSITE_VRT}" "${COMPOSITE_VRT}"; do
  if [[ ! -f "$f" ]]; then
    echo "  ✗ missing: $f"
    echo "    Run ./02-build-elevation-vrt.sh first."
    exit 1
  fi
done

if ! command -v docker >/dev/null 2>&1; then
  echo "  ✗ missing required tool: docker"
  echo "    Install Docker Desktop and rerun."
  exit 1
fi

mkdir -p "${OUT_DIR}"

echo "==> Pulling tumgis/ctb-quantized-mesh..."
docker pull tumgis/ctb-quantized-mesh

ctb_run() {
  # The VRT XML files reference their source GeoTIFFs by absolute host paths
  # (/Users/aplave/...) — those exact paths must also be visible inside the
  # container. Easiest way: bind-mount the host root as itself.
  docker run --rm \
    -v "/:/host_root:ro" \
    -v "${DATA_DIR}:${DATA_DIR}" \
    -v "${OUT_DIR}:/out" \
    tumgis/ctb-quantized-mesh \
    "$@"
}

echo ""
echo "==> Pass A: global MOLA-HRSC, z 0 → 9 (~700k tiles, ~1 GB)..."
# Global MOLA only — the global composite (MOLA + HiRISE inset) would be
# 21M × 21M px at HiRISE's 1 m/px resolution, which overflows GDAL's int32
# block reads. Pass B (HiRISE detail) uses a bounded VRT so its source size
# stays manageable.
ctb_run ctb-tile \
  -f Mesh \
  -C -N \
  -s 9 -e 0 \
  -o /out \
  "${MOLA_VRT}"

echo ""
echo "==> Pass A2: Jezero z 9 from composite (overwrites Pass A1's Jezero MOLA z9 tiles)..."
# Pass A1 wrote MOLA-only z0-9 globally. Pass B writes composite z10-14 inside
# Jezero. At the z9/z10 transition INSIDE Jezero, Pass A1 (z9 = MOLA-averaged)
# and Pass B (z10 = composite-averaged) read MOLA at different effective
# overview levels, producing small height mismatches that render as visible
# half-meter "curtains" at LOD-swap boundaries. Re-tiling Pass A's z9 tiles
# in Jezero from the SAME composite source aligns the encoding across the
# z9/z10 boundary so no LOD-pop is visible.
# Bbox of jezero_composite.vrt is z9-aligned, so the four z9 tiles covering
# Jezero are entirely inside the VRT extent (no "maxH=0" fill-with-zero edge
# bug). We deliberately don't tile z0-z8 from the composite — at those zoom
# levels a single tile covers way more than the bbox and would overwrite
# Pass A1's global tiles with mostly-empty data.
ctb_run ctb-tile \
  -f Mesh \
  -C -N \
  -s 9 -e 9 \
  -o /out \
  "${JEZERO_COMPOSITE_VRT}"

echo ""
echo "==> Pass B: Jezero HiRISE detail, z 10 → 15 (~6k tiles in Jezero only)..."
ctb_run ctb-tile \
  -f Mesh \
  -C -N \
  -s 15 -e 10 \
  -o /out \
  "${JEZERO_COMPOSITE_VRT}"

echo ""
echo "==> Pass B2: delete z10-z15 tiles outside HiRISE coverage..."
# Pass B writes z10-z15 across the whole padded bbox (~5x5 z9 tiles around
# Jezero). Inside HiRISE (1 m/px source) CTB encodes adjacent tiles
# consistently to sub-mm. OUTSIDE HiRISE but still inside the bbox the
# composite VRT falls back to MOLA at 200 m/px, and CTB samples MOLA at
# slightly different sub-pixel positions on either side of a shared edge
# — adjacent z15 tiles end up 3-4 m off, propagating to ~9 m by z11. Visible
# as cracks. Deleting these tiles lets the renderer fall back to Pass A1's
# z9 (globally consistent) for the buffer area — no real data loss since
# the deleted z10-z15 only ever had upsampled MOLA, not real high-res data.
node "${SCRIPT_DIR}/07-delete-outside-hirise.mjs"

echo ""
echo "==> Pass C: writing layer.json from on-disk tiles..."
# ctb-tile -l on the global 1 m/px composite hangs. 04-write-layer-json.mjs
# walks the actual tile tree and emits accurate per-zoom `available` ranges.
# Runs AFTER Pass B2 so the availability range reflects the post-deletion
# tile set.
node "${SCRIPT_DIR}/04-write-layer-json.mjs"

echo ""
echo "==> Pass D: cross-LOD parent-edge sync (global)..."
# CTB encodes each tile independently. When the renderer shows a z(N) parent
# next to a z(N+1) child in the same frame (LOD-transition boundary), the
# parent's straight edge segment between sparse vertices disagrees with the
# child's denser polyline by some fraction of the local terrain relief —
# up to tens of meters at the Jezero crater rim. The QM spec doesn't require
# parent-child edges to match (only same-LOD edges), CTB doesn't enforce it,
# and 3d-tiles-renderer's plugin doesn't compensate at render time. Skirts
# can hide it, but only by being big enough to also be visible as walls up
# close. This pass walks the pyramid bottom-up and injects each parent's
# children's edge vertex polylines into the parent mesh, so LOD-transition
# edges trace identical polylines on both sides.
# Only runs over the padded Jezero bbox — tiles outside (MOLA-only Pass A1)
# have no z+1 children and get skipped automatically.
node "${SCRIPT_DIR}/06-sync-parent-edges.mjs"

echo ""
echo "==> Pass E: rewriting tile centerXYZ Mars-correct (CTB default is Earth WGS84)..."
# tumgis/ctb writes header.center using Earth's WGS84 (~6.4M m magnitude) by
# default. The QuantizedMeshLoader subtracts that from each vertex, leaving
# tile-local positions at ~3M m magnitude where float32 precision is ~0.3 m.
# Result: visible inter-tile jitter as the camera moves. Patching center to
# the true Mars-ECEF position drops local vertex magnitudes to tens of meters
# and float32 precision to sub-micron. Must run AFTER 06-sync-parent-edges
# because that pass rewrites tile minH/maxH (and thus the canonical center
# elevation), which the center-XYZ computation depends on.
node "${SCRIPT_DIR}/05-fix-tile-centers.mjs"

echo ""
echo "==> Output summary:"
ls -lh "${OUT_DIR}/layer.json" 2>/dev/null | sed 's/^/  /'
echo "  Total tile tree size: $(du -sh "${OUT_DIR}" | cut -f1)"
echo "  Tile count: $(find "${OUT_DIR}" -name '*.terrain' | wc -l)"

echo ""
echo "Done. Tiles ready at: ${OUT_DIR}"
echo ""
echo "Next steps:"
echo "  1. Update apps/viewer/test-catalogs/ingenuity-jezero.json to use:"
echo "       \"type\": \"quantized-mesh\","
echo "       \"url\": \"/test-catalogs/data/mars-terrain/\","
echo "       \"referenceRadiusOffsetKm\": <calibrate, see README>"
echo "  2. Run \`pnpm dev\` and calibrate referenceRadiusOffsetKm at Wright"
echo "     Brothers Field per the README Calibration section."
