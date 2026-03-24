#!/usr/bin/env bash
# Downloads MSL (Curiosity) SPICE kernels for the Dingo Gap demo.
#
# Kernels cover sols 449–583 (Nov 2013 – Mar 2014), which includes
# the Dingo Gap traverse (sols 528–540, late Jan – mid Feb 2014).
#
# Files:
#   FK   — MSL frame definitions + topocentric frame (~200 KB)
#   SCLK — Spacecraft clock (~7 KB)
#   PCK  — Mars body constants (~123 KB)
#   SPK  — Rover surface position (~466 KB)
#   CK   — Rover attitude (~327 KB)
#   SPK  — Mars satellite ephemeris (~64 MB, provides 499→4 link)
#
# Total: ~65 MB (dominated by Mars satellite ephemeris)
#
# Usage: ./scripts/fetch-msl-kernels.sh
# Output: apps/viewer/test-catalogs/kernels/msl/

set -euo pipefail

DEST="$(dirname "$0")/../apps/viewer/test-catalogs/kernels/msl"
mkdir -p "$DEST"

NAIF_MSL="https://naif.jpl.nasa.gov/pub/naif/MSL/kernels"
NAIF_GENERIC="https://naif.jpl.nasa.gov/pub/naif/generic_kernels"

KERNELS=(
  # Frame definitions (MSL_ROVER, MSL_TOPO, instruments, antennas)
  "$NAIF_MSL/fk/msl.tf"

  # Topocentric frame at landing site (local level)
  "$NAIF_MSL/fk/msl_tp_ops120808_iau2000_v1.tf"

  # Spacecraft clock calibration (2000–2018)
  "$NAIF_MSL/sclk/MSL_76_SCLKSCET.00012.tsc"

  # Mars body constants (IAU 2000 rotation parameters)
  "$NAIF_MSL/pck/pck00008.tpc"

  # Landing site anchor — establishes site body position on Mars (499)
  "$NAIF_MSL/spk/msl_ls_ops120808_iau2000_v1.bsp"

  # Site locations along the traverse, sols 449–583
  # (intermediate chain: numbered sites relative to Mars body)
  "$NAIF_MSL/spk/msl_surf_rover_loc_0000_2003_v1.bsp"

  # Rover surface position, sols 449–583 (~466 KB)
  # (chain: rover -76 → site bodies → Mars 499)
  "$NAIF_MSL/spk/msl_surf_rover_tlm_0449_0583_v1.bsp"

  # Rover attitude, sols 449–583 (~327 KB)
  "$NAIF_MSL/ck/msl_surf_rover_tlm_0449_0583_v1.bc"

  # Mars satellite ephemeris — provides Mars body (499) → barycenter (4) link.
  # de440s.bsp only has Mars barycenter; SPICE needs this to chain MSL → Mars → SSB.
  # mar099s covers 1994–2049 (64 MB). Using generic_kernels version since the MSL
  # directory's mar085s.bsp may not cover Feb 2014.
  "$NAIF_GENERIC/spk/satellites/mar099s.bsp"
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
echo "Done! MSL kernels saved to $DEST"
du -sh "$DEST"
