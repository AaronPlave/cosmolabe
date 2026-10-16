#!/usr/bin/env bash
# Official textured, articulated Rosetta/Philae models. Coordinates are already
# body-fixed kilometres, as in ESA's spacecraft_ROS_arcs.json; do not rescale.
# Large texture maps are fetched rather than committed. No image conversion.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${ROSETTA_MODELS_DIR:-$HERE/../apps/viewer/test-catalogs/models/rosetta}"
ESA="https://spiftp.esac.esa.int/cosmographia/missions/ROS/models"
mkdir -p "$DEST"
for name in ROS_SC_PHILAE_V00.3ds ROS_SC_BUS_V00.3ds ROS_PHILAE_V00.3ds \
            ROS_SC_SA+Y_V00.3ds ROS_SC_SA-Y_V00.3ds ROS_SC_HGA_V00.3ds \
            ros_alb.png ros_nor.png phi_alb.png phi_nor.png; do
  if [ -s "$DEST/$name" ]; then
    echo "  [skip] $name"
    continue
  fi
  echo "  [fetch] $name"
  curl -fSL --retry 3 "$ESA/$name" -o "$DEST/$name.part"
  mv "$DEST/$name.part" "$DEST/$name"
done

(cd "$DEST" && shasum -a 256 -c "$HERE/rosetta-models.sha256")
