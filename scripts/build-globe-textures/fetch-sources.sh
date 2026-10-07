#!/usr/bin/env bash
# Fetch the public-domain USGS Astrogeology mosaics build.py needs into
# data/source/ (gitignored, ~27 MB).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data/source

USGS=https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic
for name in \
  Ceres_Dawn_FC_DLR_global_20ppd_Oct2015; do
  for ext in tif lbl; do
    [ -s "data/source/$name.$ext" ] || curl -fSL --retry 3 -o "data/source/$name.$ext" "$USGS/$name.$ext"
  done
done
