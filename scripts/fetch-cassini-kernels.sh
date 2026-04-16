#!/usr/bin/env bash
# Downloads Cassini SPICE kernels for the SpiceCraft viewer demo.
#
# SPK coverage: continuous reconstructed chain from Mar 2001 through Jul 24, 2005.
#   Covers SOI, Titan T-A, Huygens, Enceladus E-2, and everything in between.
#   14 SPK files, ~106 MB total (before gzip).
#
# CK coverage: reconstructed attitude for key event windows (5-day spans).
#
# Kernels downloaded:
#   FK   — Cassini frame definitions (already have cas_v43.tf)
#   SCLK — Spacecraft clock (already have cas00172.tsc)
#   IK   — ISS NAC/WAC (already have), VIMS, UVIS, RADAR, CIRS, CAPS
#   SPK  — Continuous reconstructed trajectory chain (14 files)
#   CK   — Reconstructed attitude for flyby windows
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
  # SPK — Continuous reconstructed chain: Mar 2001 through Jul 24, 2005
  #   Each file covers Cassini + Saturn + major satellite ephemerides.
  #   Files chain end-to-end with no gaps.

  # Cruise + approach + Phoebe flyby + SOI (through Jul 17, 2004)
  "$NAIF/spk/040909R_SCPSE_01066_04199.bsp"        # 36 MB

  # Post-SOI → Sep 3, 2004
  "$NAIF/spk/041219R_SCPSE_04199_04247.bsp"         # 4.5 MB

  # Sep 3 → Dec 1, 2004 (Titan T-A flyby Oct 26)
  "$NAIF/spk/050105RB_SCPSE_04247_04336.bsp"        # 7.8 MB

  # Dec 1, 2004 → Jan 15, 2005 (Huygens release + landing)
  "$NAIF/spk/050214R_SCPSE_04336_05015.bsp"         # 16 MB

  # Jan 15 → Feb 3, 2005
  "$NAIF/spk/050411R_SCPSE_05015_05034.bsp"         # 7.3 MB

  # Feb 3 → Mar 1, 2005
  "$NAIF/spk/050414R_SCPSE_05034_05060.bsp"         # 7.9 MB

  # Mar 1 → Mar 22, 2005
  "$NAIF/spk/050504R_SCPSE_05060_05081.bsp"         # 4.5 MB

  # Mar 22 → Apr 7, 2005
  "$NAIF/spk/050506R_SCPSE_05081_05097.bsp"         # 4.4 MB

  # Apr 7 → Apr 24, 2005
  "$NAIF/spk/050513R_SCPSE_05097_05114.bsp"         # 4.2 MB

  # Apr 24 → May 12, 2005
  "$NAIF/spk/050606R_SCPSE_05114_05132.bsp"         # 3.1 MB

  # May 12 → May 30, 2005
  "$NAIF/spk/050623R_SCPSE_05132_05150.bsp"         # 2.5 MB

  # May 30 → Jun 18, 2005
  "$NAIF/spk/050708R_SCPSE_05150_05169.bsp"         # 2.9 MB

  # Jun 18 → Jul 5, 2005
  "$NAIF/spk/050802R_SCPSE_05169_05186.bsp"         # 2.7 MB

  # Jul 5 → Jul 24, 2005 (Enceladus E-2 plume discovery Jul 14)
  "$NAIF/spk/050825R_SCPSE_05186_05205.bsp"         # 2.5 MB

  # CK — Reconstructed spacecraft attitude (5-day windows around key events)

  # SOI approach (Jun 27 – Jul 1, 2004)
  "$NAIF/ck/04179_04183ra.bc"

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
