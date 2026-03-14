#!/usr/bin/env bash
# Downloads LRO SPICE kernels for visual validation in the SpiceCraft viewer.
#
# Kernels:
#   FK  — LRO frame definitions (~45 KB)
#   IK  — LROC instrument FOVs (~72 KB)
#   SPK — LRO trajectory, ~90 days (~7.2 MB)
#
# CK (attitude) files are 140-200 MB each and impractical for web use.
# The viewer uses a computed nadir-pointing model instead, which is accurate
# for LRO's primary nadir-mapping orientation.
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

  # LROC instrument FOVs (NAC Left -85600, NAC Right -85610, WAC -85620)
  "$NAIF_LRO/ik/lro_lroc_v20.ti"

  # LRO trajectory around Moon (Dec 16 2024 – Mar 15 2025, ~7.2 MB)
  "$NAIF_PDS/spk/lrorg_2024350_2025074_v01.bsp"
)

for url in "${KERNELS[@]}"; do
  filename=$(basename "$url")
  dest_file="$DEST/$filename"

  if [ -f "$dest_file" ]; then
    echo "  [skip] $filename (already exists)"
    continue
  fi

  echo "  [fetch] $filename ..."
  curl -fSL --progress-bar "$url" -o "$dest_file"
done

echo ""
echo "Done! LRO kernels saved to $DEST"
du -sh "$DEST"
