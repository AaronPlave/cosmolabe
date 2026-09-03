#!/usr/bin/env bash
#
# Fetch the Cosmographia catalog data two test suites read as third-party
# fixtures: catalog-all-cosmographia.test.ts loads every top-level catalog JSON
# to prove our loader accepts real Cosmographia files, and xyzv-parser.test.ts
# parses a real .xyzv trajectory.
#
# Fetched, never vendored. Cosmographia's repository carries no LICENSE file and
# no license statement in its README, so redistributing its data inside this
# Apache-2.0 repo would be a rights question we have no answer to; downloading
# it at test time is not. It also costs no git-lfs bandwidth, same argument as
# kernels/fetch.sh.
#
# A partial, sparse clone keeps this to ~9 MB of the upstream 322 MB data tree.
#
# Usage: bash scripts/fetch-cosmographia-data.sh
# The suites look here by default; set COSMOGRAPHIA_DATA to point at your own
# Cosmographia checkout instead.

set -euo pipefail

REPO="https://github.com/claurel/cosmographia"
DEST="$(cd "$(dirname "$0")/.." && pwd)/.cosmographia"

if [ -f "$DEST/data/trajectories/voyager1.xyzv" ]; then
  echo "have Cosmographia data in $DEST"
  exit 0
fi

rm -rf "$DEST"
echo "fetching Cosmographia catalog data (sparse) ..."
git clone --depth 1 --filter=blob:none --sparse "$REPO" "$DEST"
git -C "$DEST" sparse-checkout set --no-cone '/data/*.json' '/data/trajectories/**'

if [ ! -f "$DEST/data/trajectories/voyager1.xyzv" ]; then
  echo "error: sparse checkout did not produce data/trajectories/voyager1.xyzv" >&2
  exit 1
fi

echo "done. $(ls "$DEST"/data/*.json | wc -l) catalogs, $(ls "$DEST"/data/trajectories | wc -l) trajectories, $(du -sh "$DEST/data" | cut -f1)"
