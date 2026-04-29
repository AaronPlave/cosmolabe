#!/usr/bin/env bash
# Downloads LRO SPICE kernels for visual validation in the Cosmolabe viewer.
#
# Kernels:
#   FK   — LRO frame definitions + lunar reference frames
#   IK   — All LRO instrument FOVs (LROC, LOLA, Diviner, LAMP, CRaTER, LEND)
#   SCLK — Spacecraft clock (required for CK attitude)
#   SPK  — LRO trajectory, ~90 days (~7.2 MB)
#   PCK  — High-accuracy lunar orientation (binary, 1.7 MB)
#
# Note: the reconstructed spacecraft bus CK (lrosc_*.bc, ~528 MB) is intentionally
# omitted — too large to ship in the deployed viewer. Without it, LRO orbit and
# instrument FOV definitions still load but spacecraft attitude is unavailable.
#
# All kernels are gzipped after download for faster web delivery.
# The viewer decompresses them client-side via DecompressionStream.
#
# Usage: ./scripts/fetch-lro-kernels.sh
# Output: apps/viewer/test-catalogs/kernels/lro/

set -euo pipefail

DEST="$(dirname "$0")/../apps/viewer/test-catalogs/kernels/lro"
mkdir -p "$DEST"

NAIF_LRO="https://naif.jpl.nasa.gov/pub/naif/LRO/kernels"
NAIF_PDS="https://naif.jpl.nasa.gov/pub/naif/pds/data/lro-l-spice-6-v1.0/lrosp_1000/data"

KERNELS=(
  # Frame definitions (LRO_SC_BUS, LROC instrument frames, etc.)
  "$NAIF_LRO/fk/lro_frames_2014049_v01.tf"

  # Lunar reference frames (needed for binary PCK)
  "$NAIF_PDS/fk/moon_080317.tf"
  "$NAIF_PDS/fk/moon_assoc_me.tf"

  # All LRO instrument FOVs
  "$NAIF_LRO/ik/lro_lroc_v20.ti"
  "$NAIF_PDS/ik/lro_lola_v00.ti"
  "$NAIF_PDS/ik/lro_dlre_v05.ti"
  "$NAIF_PDS/ik/lro_lamp_v03.ti"
  "$NAIF_PDS/ik/lro_crater_v03.ti"
  "$NAIF_PDS/ik/lro_lend_v00.ti"

  # Spacecraft clock (required for CK attitude data)
  "$NAIF_PDS/sclk/lro_clkcor_2025351_v00.tsc"

  # LRO trajectory around Moon (Dec 16 2024 – Mar 15 2025, ~7.2 MB)
  "$NAIF_PDS/spk/lrorg_2024350_2025074_v01.bsp"

  # High-accuracy lunar orientation (binary PCK, 1900–2050, 1.7 MB)
  "$NAIF_PDS/pck/moon_pa_de421_1900_2050.bpc"
)

for url in "${KERNELS[@]}"; do
  filename=$(basename "$url")
  gz_file="$DEST/${filename}.gz"
  raw_file="$DEST/$filename"

  # Skip if gzipped version already exists
  if [ -f "$gz_file" ]; then
    echo "  [skip] ${filename}.gz (already exists)"
    continue
  fi

  # Also skip if uncompressed version exists (from previous script version)
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

echo ""
echo "Done! LRO kernels saved to $DEST"
du -sh "$DEST"
echo ""
echo "Files:"
ls -lh "$DEST"
