#!/usr/bin/env bash
# Regional Apollo 17 product over the existing LOLA and south-pole terrain.
set -euo pipefail
if [[ $# != 2 ]]; then
  echo "Usage: $0 NATIVE_DTM.IMG PREPARED_REGIONAL_TIFF" >&2
  exit 2
fi
pilot_dtm="$1"
pilot_regional="$2"
[[ "$pilot_dtm" = /* ]] || pilot_dtm="$PWD/$pilot_dtm"
[[ "$pilot_regional" = /* ]] || pilot_regional="$PWD/$pilot_regional"
cd "$(dirname "${BASH_SOURCE[0]}")"
pilot_out=../../apps/viewer/test-catalogs/data/moon-terrain-cube-apollo17
[[ ! -e "$pilot_out" ]] || { echo "Use a fresh output directory: $pilot_out" >&2; exit 1; }
mkdir -p "$(dirname "$pilot_out")"
pilot_python=${PYTHON:-python3}
"$pilot_python" apollo17-pilot.py terrain "$pilot_dtm" "$pilot_regional"
pilot_stage=$(mktemp -d "${pilot_out}.build.XXXXXX")
trap 'rm -rf -- "$pilot_stage"' EXIT
CUBE_OUT="$pilot_stage" PYTHON="$pilot_python" ./cube.sh \
  --regional-height "$pilot_regional" --workers "${APOLLO17_TERRAIN_WORKERS:-4}" \
  --region 'apollo17@20.190,30.794:4=65,5=33,6=20,7=15,8=11,9=9,10=7,11=5,12=4,13=3,14=2.6,15=2.4'
"$pilot_python" -c 'import os, sys; os.rename(sys.argv[1], sys.argv[2])' "$pilot_stage" "$pilot_out"
