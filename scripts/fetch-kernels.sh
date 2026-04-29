#!/usr/bin/env bash
# Downloads NAIF generic SPICE kernels for the Cosmolabe viewer.
# Only fetches reasonably-sized kernels suitable for web loading.
# Moon positions use analytical theories (TASS17, L1, Gust86, MarsSat) as fallbacks.
#
# Usage: ./scripts/fetch-kernels.sh
# Output: apps/viewer/public/kernels/

set -euo pipefail

DEST="$(dirname "$0")/../apps/viewer/public/kernels"
mkdir -p "$DEST"

NAIF="https://naif.jpl.nasa.gov/pub/naif/generic_kernels"

# Core kernels (small, always useful)
KERNELS=(
  "lsk/naif0012.tls"          # ~5 KB   - leap seconds
  "pck/pck00011.tpc"          # ~120 KB - body constants (radii, GM, etc.)
  "spk/planets/de440s.bsp"    # ~32 MB  - planets + Moon (1849-2150)
)

# Note: Satellite kernels are too large for web use:
#   sat441.bsp  = 631 MB (Saturn)
#   jup365.bsp  = 1.1 GB (Jupiter)
#   mar099s.bsp = 64 MB  (Mars)
# Instead, Cosmolabe uses analytical theories (TASS17, L1, Gust86, MarsSat)
# for satellite positions when SPICE kernels aren't available.

for kernel in "${KERNELS[@]}"; do
  filename=$(basename "$kernel")
  dest_file="$DEST/$filename"

  if [ -f "$dest_file" ]; then
    echo "  [skip] $filename (already exists)"
    continue
  fi

  echo "  [fetch] $filename ..."
  curl -fSL --progress-bar "$NAIF/$kernel" -o "$dest_file"
done

echo ""
echo "Done! Kernels saved to $DEST"
du -sh "$DEST"
