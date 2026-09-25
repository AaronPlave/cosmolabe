#!/usr/bin/env bash
# Fetch every kernel a fresh clone needs to run the bundled demos.
#
# Why: large SPICE kernels (de440s.bsp, mar099s.bsp, ref_trj_scpse.bsp, etc.)
# live behind fetch scripts instead of in git so the repo stays thin. CI
# should run this before `vite build` for the deployed viewer.
#
# Usage: ./scripts/fetch-all.sh

set -euo pipefail
HERE="$(dirname "$0")"

bash "$HERE/fetch-kernels.sh"
bash "$HERE/fetch-cassini-kernels.sh"
bash "$HERE/fetch-lro-kernels.sh"
bash "$HERE/fetch-msl-kernels.sh"
bash "$HERE/fetch-europa-clipper-kernels.sh"
bash "$HERE/fetch-psyche-kernels.sh"
bash "$HERE/fetch-voyager-kernels.sh"
bash "$HERE/fetch-rosetta-kernels.sh"

echo
echo "All kernel sets fetched. Demos should now load."
