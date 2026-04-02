#!/usr/bin/env bash
# Downloads Cassini SPICE kernels for the SpiceCraft viewer demo.
#
# Coverage:
#   SOI              2004-07-01  (already had predicted SPK + CK)
#   Titan T-A        2004-10-26  (first Titan flyby)
#   Huygens release  2004-12-25  (probe separation)
#   Huygens landing  2005-01-14  (Titan descent)
#   Enceladus E-2    2005-07-14  (plume discovery flyby)
#
# Kernels downloaded:
#   FK   — Cassini frame definitions (already have cas_v43.tf)
#   SCLK — Spacecraft clock (already have cas00172.tsc)
#   IK   — ISS NAC/WAC (already have), VIMS, UVIS, RADAR, CIRS, CAPS
#   SPK  — Reconstructed trajectory segments covering each event
#   CK   — Reconstructed attitude for each event's flyby window
#
# Large files (SPK, CK) are gzipped for efficient web delivery.
# The viewer decompresses them client-side via DecompressionStream.
#
# Usage: ./scripts/fetch-cassini-kernels.sh
# Output: apps/viewer/test-catalogs/kernels/cassini/

set -euo pipefail

DEST="$(dirname "$0")/../apps/viewer/test-catalogs/kernels/cassini"
mkdir -p "$DEST"

NAIF="https://naif.jpl.nasa.gov/pub/naif/CASSINI/kernels"

# ── Small text kernels (IK) — no gzip needed ─────────────────────────

SMALL_KERNELS=(
  # Instrument kernels — FOV definitions for sensor visualization
  "$NAIF/ik/cas_vims_v06.ti"     # VIMS (Visible + Infrared Mapping Spectrometer)
  "$NAIF/ik/cas_uvis_v07.ti"     # UVIS (Ultraviolet Imaging Spectrograph)
  "$NAIF/ik/cas_radar_v11.ti"    # RADAR (Synthetic Aperture Radar / altimeter)
  "$NAIF/ik/cas_cirs_v10.ti"     # CIRS (Composite Infrared Spectrometer)
  "$NAIF/ik/cas_caps_v03.ti"     # CAPS (Plasma Spectrometer)
)

echo "=== Cassini instrument kernels ==="
for url in "${SMALL_KERNELS[@]}"; do
  filename=$(basename "$url")
  dest_file="$DEST/$filename"

  if [ -f "$dest_file" ]; then
    echo "  [skip] $filename (already exists)"
    continue
  fi

  echo "  [fetch] $filename ..."
  curl -fSL --progress-bar "$url" -o "$dest_file"
done

# ── Large binary kernels (SPK, CK) — gzipped for web delivery ───────

LARGE_KERNELS=(
  # SPK — Reconstructed Cassini + Saturn system trajectories
  #   Each file covers spacecraft, Saturn, and major satellite ephemerides.
  #   Chain: SOI(existing) → post-SOI → Titan T-A → Huygens → [gap] → Enceladus E-2

  # Post-SOI to Sep 3, 2004 (fills gap between SOI and Titan T-A)
  "$NAIF/spk/041219R_SCPSE_04199_04247.bsp"

  # Sep 3 – Dec 1, 2004 (covers Titan T-A flyby, Oct 26)
  "$NAIF/spk/050105RB_SCPSE_04247_04336.bsp"

  # Dec 1, 2004 – Jan 15, 2005 (covers Huygens release Dec 25 + landing Jan 14)
  "$NAIF/spk/050214R_SCPSE_04336_05015.bsp"

  # Jul 5–24, 2005 (covers Enceladus E-2 plume discovery flyby, Jul 14)
  "$NAIF/spk/050825R_SCPSE_05186_05205.bsp"

  # CK — Reconstructed spacecraft attitude (5-day windows around each event)

  # Titan T-A flyby (Oct 22–27, 2004)
  "$NAIF/ck/04296_04301ra.bc"

  # Huygens release (Dec 21–26, 2004)
  "$NAIF/ck/04356_04361ra.bc"

  # Huygens landing (Jan 12–17, 2005)
  "$NAIF/ck/05012_05017ra.bc"

  # Enceladus E-2 plume discovery (Jul 11–16, 2005)
  "$NAIF/ck/05192_05197ra.bc"
)

echo ""
echo "=== Cassini trajectory + attitude kernels (gzipped) ==="
for url in "${LARGE_KERNELS[@]}"; do
  filename=$(basename "$url")
  gz_file="$DEST/${filename}.gz"
  raw_file="$DEST/$filename"

  # Skip if gzipped version already exists
  if [ -f "$gz_file" ]; then
    echo "  [skip] ${filename}.gz (already exists)"
    continue
  fi

  # If uncompressed version exists, just gzip it
  if [ -f "$raw_file" ]; then
    echo "  [gzip] $filename (compressing existing file)"
    gzip -9 "$raw_file"
    continue
  fi

  echo "  [fetch] $filename ..."
  curl -fSL --progress-bar "$url" -o "$raw_file"
  echo "  [gzip] $filename ..."
  gzip -9 "$raw_file"
done

# ── Copy IK files to test-kernels for unit tests ─────────────────────

TEST_DEST="$(dirname "$0")/../packages/spice/test-kernels/cassini"
mkdir -p "$TEST_DEST"

echo ""
echo "=== Copying IK files to test-kernels ==="
for url in "${SMALL_KERNELS[@]}"; do
  filename=$(basename "$url")
  src="$DEST/$filename"
  dest="$TEST_DEST/$filename"
  if [ -f "$src" ] && [ ! -f "$dest" ]; then
    echo "  [copy] $filename → test-kernels/cassini/"
    cp "$src" "$dest"
  fi
done

echo ""
echo "Done! Cassini kernels saved to $DEST"
du -sh "$DEST"
echo ""
echo "Files:"
ls -lh "$DEST"
