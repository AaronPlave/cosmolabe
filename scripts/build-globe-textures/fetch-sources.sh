#!/usr/bin/env bash
# Fetch the inputs build.py needs into data/source/ (gitignored, ~780 MB):
#   - public-domain USGS Astrogeology global mosaics
#   - NASA Blue Marble Next Generation and Photojournal originals
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
  Titan_ISS_P19658_Mosaic_Global_4km \
  Venus_Magellan_C3-MDIR_Colorized_Global_Mosaic_4641m; do
  for ext in tif lbl; do
    [ -s "data/source/$name.$ext" ] || curl -fSL --retry 3 -o "data/source/$name.$ext" "$USGS/$name.$ext"
  done
done

fetch() { [ -s "data/source/$2" ] || curl -fSL --retry 3 -o "data/source/$2" "$1"; }

# DLR Cassini Mimas basemap (zip, 39 MB) -> data/source/Cassini_DLR/
fetch "$USGS/Mimas/Cassini_DLR_Mimas.zip" Cassini_DLR_Mimas.zip
[ -s data/source/Cassini_DLR/MI_170630_DLR_basemap_degrees.tif ] ||
  unzip -o -q data/source/Cassini_DLR_Mimas.zip 'Cassini_DLR/MI_170630_DLR_basemap_degrees.tif' -d data/source

# Blue Marble NG, July 2004, topography + bathymetry, 21600x10800 (27 MB)
fetch https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/july/world.topo.bathy.200407.3x21600x10800.jpg \
  world.topo.bathy.200407.3x21600x10800.jpg

# Photojournal originals: PIA07782 Cassini Jupiter map (19 MB), PIA11142 ring sweep (52 MB)
PJ=https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia
fetch $PJ/pia07/pia07782/PIA07782.tif PIA07782.tif
fetch $PJ/pia11/pia11142/PIA11142.tif PIA11142.tif

# The Mercury and Mars mosaics (4-13 GB each) are not downloaded: build.py
# streams them through HTTP range requests (usgs_remote) on first use.

# Last commit with the pre-#122 pluto.jpg (a plain blob, not LFS).
git show b593685:apps/viewer/test-catalogs/textures/pluto.jpg > data/source/previous/pluto.jpg
