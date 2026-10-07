#!/usr/bin/env bash
# Fetch the inputs build.py needs into data/source/ (gitignored, ~420 MB):
#   - public-domain USGS Astrogeology global mosaics
#   - previous/pluto.jpg, the map pluto.jpg replaced, from git history: the
#     pluto recipe takes its MVIC colour (chroma only) from it.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data/source/previous

USGS=https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic
for name in \
  Ceres_Dawn_FC_DLR_global_20ppd_Oct2015 \
  Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit \
  Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit \
  Titan_ISS_P19658_Mosaic_Global_4km; do
  for ext in tif lbl; do
    [ -s "data/source/$name.$ext" ] || curl -fSL --retry 3 -o "data/source/$name.$ext" "$USGS/$name.$ext"
  done
done

# Last commit with the pre-#122 pluto.jpg (a plain blob, not LFS).
git show b593685:apps/viewer/test-catalogs/textures/pluto.jpg > data/source/previous/pluto.jpg
