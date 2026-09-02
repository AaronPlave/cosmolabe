#!/usr/bin/env bash
#
# Fetch the SPICE kernels Bessel's Phase 0 demo needs from the public NAIF
# archive into kernels/data/ (git-ignored bulk). The small, redistributable
# fixtures the unit and e2e tests load live under kernels/fixtures/ and are
# committed; packages/spice/scripts/make-fixture-spk.mjs derives them from these
# downloads. Kernels are treated as untrusted input (SECURITY.md): we only read
# them through CSPICE, never execute them.
#
# Usage: bash kernels/fetch.sh

set -euo pipefail

DATA="$(cd "$(dirname "$0")" && pwd)/data"
mkdir -p "$DATA"

NAIF="https://naif.jpl.nasa.gov/pub/naif"
GENERIC="$NAIF/generic_kernels"

fetch() {
  local url="$1" dest="$2"
  if [ -f "$DATA/$dest" ]; then
    echo "have $dest"
    return
  fi
  echo "fetching $dest ..."
  curl -fsSL --retry 3 -o "$DATA/$dest" "$url"
}

# Leapseconds (LSK).
fetch "$GENERIC/lsk/naif0012.tls" "naif0012.tls"

# Planetary ephemeris (de440s, bounded 1849..2150). Bulk, ~32 MB.
fetch "$GENERIC/spk/planets/de440s.bsp" "de440s.bsp"

# Planetary constants (radii, orientation) for body shapes and frames.
fetch "$GENERIC/pck/pck00011.tpc" "pck00011.tpc"

# Cassini reconstructed ephemeris covering Saturn orbit insertion (2004-07-01,
# DOY 183). SCPSE bundles the spacecraft (-82) plus the Saturn system.
fetch "$NAIF/CASSINI/kernels/spk/040701AP_SCPSE_04173_04236.bsp" "cassini_scpse_04173_04236.bsp"

# Cassini ISS instrument kernel, for getfov field-of-view geometry (Phase 1).
fetch "$NAIF/CASSINI/kernels/ik/cas_iss_v10.ti" "cas_iss_v10.ti"

# A small type-2 DSK shape model for Phase 3 DSK rendering. The Cassini Saturn-
# system DSKs (Phoebe, Phobos) are tens of MB; the New Horizons MU69 (Arrokoth)
# low-poly model is 84 KB and exercises the same DSK type-2 reader, so it is the
# committed DSK fixture (off the Cassini theme, noted as a deviation).
fetch "$NAIF/pds/data/nh-j_p_ss-spice-6-v1.0/nhsp_1000/data/dsk/mu69_fr2kf_lopoly_spice_v01.bds" "mu69_lopoly.bds"

echo "done. kernels in $DATA:"
ls -la "$DATA"
