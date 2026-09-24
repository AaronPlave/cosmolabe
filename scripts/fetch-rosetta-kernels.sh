#!/usr/bin/env bash
# Downloads and prepares the Rosetta + Philae kernel set (2004-2016) for the
# rosetta.json demo, from the ESA SPICE Service's operational archive.
#
# The archive is the authoritative source and is used as published, except for
# the files that are far denser than a viewer needs. Those are rebuilt from the
# archive here, by scripts that verify their output against the original and
# refuse to write a result outside the stated tolerance:
#
#   Rosetta comet-phase trajectory  RORB_DV_257 (182 MB)  ->  resampled every
#     10 min about 67P, split at its orbit-determination jumps and manoeuvres
#     (scripts/resample-spk.mjs; ~6 MB, checked to about a metre)
#   Structure origin     ROS_COG_V4 (7 MB) -> resampled daily (~cm)
#   Rosetta attitude     ATNR + RATT_DV_145/223/257 (37 MB) -> thinned to 0.1 deg
#   67P rotation         CATT_DV_145/223/257 (12 MB)        -> thinned to 0.05 deg
#   Solar arrays, HGA    ROS_SA_*/ROS_HGA_* (~420 MB)        -> thinned to 0.25 deg
#     (scripts/thin-ck.mjs; the CK frames and clocks are the archive's own)
#
# Everything else — the cruise SPK, 67P / Steins / Lutetia ephemerides, Philae's
# separation, descent, bounce and landing kernels, frames, clocks, and the DSK
# shape models of 67P, the asteroids, the spacecraft and the lander — is the
# archive file, byte for byte (gzipped when large, for web delivery).
#
# Planetary ephemeris comes from the base catalogs (de440s.bsp, scripts/fetch-kernels.sh).
#
# The archive downloads (~700 MB, mostly the attitude files that are thinned)
# go to $ROSETTA_SOURCE_DIR (default: kernels/rosetta/.source, git-ignored) and
# are kept, so a rerun only redoes what is missing. Delete that directory once
# the set is built if you need the space. The packages must be built first
# (npm run build): the rebuild scripts run on cspice-wasm.
#
# Usage: ./scripts/fetch-rosetta-kernels.sh
# Output: apps/viewer/test-catalogs/kernels/rosetta/

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/../apps/viewer/test-catalogs/kernels/rosetta"
SRC="${ROSETTA_SOURCE_DIR:-$DEST/.source}"
mkdir -p "$DEST" "$SRC"

ESA="https://spiftp.esac.esa.int/data/SPICE/ROSETTA/kernels"

# Fetch an archive file into the source cache (path relative to kernels/).
fetch() {
  local rel="$1" out="$SRC/$(basename "$1")"
  if [ ! -f "$out" ]; then
    echo "  [fetch] $rel"
    curl -fSL --retry 3 --progress-bar "$ESA/$rel" -o "$out.part"
    mv "$out.part" "$out"
  fi
}

# Ship an archive file as is; gzip it when it is over 1 MB (the viewer and its
# workers decompress by magic bytes).
ship() {
  local rel="$1" name
  name="$(basename "$rel")"
  if [ -f "$DEST/$name" ] || [ -f "$DEST/$name.gz" ]; then
    echo "  [skip] $name"
    return
  fi
  fetch "$rel"
  if [ "$(wc -c < "$SRC/$name")" -gt 1000000 ]; then
    gzip -9 -c "$SRC/$name" > "$DEST/$name.gz"
  else
    cp "$SRC/$name" "$DEST/$name"
  fi
}

echo "=== Rosetta: frames, clocks, constants ==="
ship fk/ROS_V38.TF
ship fk/ROS_LUTETIA_RSOC_V03.TF
ship sclk/ROS_160929_STEP.TSC
ship sclk/LANDER_170904_STEP.TSC
ship pck/ROS_CGS_RSOC_V03.TPC
ship pck/ROS_STEINS_V05.TPC
ship pck/ROS_LUTETIA_RSOC_V03.TPC

echo "=== Ephemerides (as published) ==="
# 67P: long-arc, then the refined arcs; later files take precedence.
ship spk/former_versions/ORHW_______________00016.BSP
ship spk/ORHW_______________00122.BSP
ship spk/CORB_DV_257_03___T19_00345.BSP
# Steins and Lutetia: long-arc, then the flyby-phase solutions.
ship spk/former_versions/2867_STEINS_2004_2016.BSP
ship spk/ORHO_______________00077.BSP
ship spk/former_versions/21_LUTETIA_2004_2016.BSP
ship spk/ORHS_______________00109.BSP
# Rosetta cruise, launch to comet arrival (2004-03-02 .. 2014-08-04).
ship spk/ORHR___________T19_00122.BSP
# Spacecraft structure offsets (solar-array and HGA gimbals).
ship spk/ROS_STRUCT_V8.BSP
# Philae: stowed on Rosetta, separation and descent, the bounce, the final site.
ship spk/LORB_ROS_SC_PRESEP_V1_0.BSP
ship spk/LORB_SUN_J2000_SDL_V1_1.BSP
ship spk/LORB_C_G_FIXED_RBD_7_V2_0.BSP
ship spk/SPICE_PHILAE_CFF_SONC_V2_0.BSP

echo "=== Philae attitude (as published) ==="
ship ck/LATT_ROS2LDR_PRESEP_V1_0.BC
ship ck/LATT_EME2LDR_SDL_V1_0.BC
ship ck/LATT_ROS2LDR_SDL_ROMAP_V1_0.BC
ship ck/LATT_CFF2LDR_FSS_V2_0.BC

echo "=== Shape models (DSK, as published) ==="
ship dsk/ROS_CG_K200_OSPGDLR_N_V1.BDS   # 67P, 200k plates (DLR, OSIRIS SPG)
ship dsk/ROS_LU_K048_OSPCLAM_N_V1.BDS   # Lutetia, 48k plates
ship dsk/ROS_ST_K020_OSPCLAM_N_V1.BDS   # Steins, 20k plates
ship dsk/ROS_SC_BUS_LR_V02.BDS          # Rosetta bus with Philae stowed
ship dsk/ROS_SC_BUS_V01.BDS             # Rosetta bus after separation
ship dsk/ROS_SC_SAPY_V02.BDS            # +Y solar array
ship dsk/ROS_SC_SAMY_V02.BDS            # -Y solar array
ship dsk/ROS_SC_HGA_V02.BDS             # high-gain antenna
ship dsk/ROS_LR_D_V03.BDS               # Philae, legs and structures deployed

# ── Rebuilt from the archive ────────────────────────────────────────────────

# rebuild OUT "SOURCES" SCRIPT ARGS... — build OUT from archive files SOURCES
# (space-separated, relative to kernels/) with SCRIPT, unless it is already
# built. The sources are only downloaded when there is something to build, so
# a rerun over a finished set costs no archive traffic.
rebuild() {
  local out="$1" sources="$2"; shift 2
  if [ -f "$DEST/$out" ] || [ -f "$DEST/$out.gz" ]; then
    echo "  [skip] $out"
    return
  fi
  local rel
  for rel in lsk/NAIF0011.TLS sclk/ROS_160929_STEP.TSC fk/ROS_V38.TF $sources; do fetch "$rel"; done
  echo "  [build] $out"
  node "$@" --out "$SRC/$out.tmp"
  if [ "$(wc -c < "$SRC/$out.tmp")" -gt 1000000 ]; then
    gzip -9 -c "$SRC/$out.tmp" > "$DEST/$out.gz"
  else
    cp "$SRC/$out.tmp" "$DEST/$out"
  fi
  rm -f "$SRC/$out.tmp"
}
# The archive paths as a comma list of local files, for the scripts' --kernels.
local_list() { local r l=""; for r in "$@"; do l="$l,$SRC/$(basename "$r")"; done; echo "${l#,}"; }
# Leapseconds, clock and frames every rebuild needs (NAIF0011 is the archive's
# own LSK; the scene furnishes the generic naif0012 alongside).
BASE="$SRC/NAIF0011.TLS,$SRC/ROS_160929_STEP.TSC,$SRC/ROS_V38.TF"

echo "=== Rosetta comet-phase trajectory (resampled) ==="
rebuild ROS_RORB_DV_257_RESAMPLED.BSP "spk/RORB_DV_257_03___T19_00345.BSP spk/CORB_DV_257_03___T19_00345.BSP" \
  "$HERE/resample-spk.mjs" \
  --source "$SRC/RORB_DV_257_03___T19_00345.BSP" \
  --kernels "$SRC/NAIF0011.TLS,$SRC/CORB_DV_257_03___T19_00345.BSP" \
  --target=-226 --center=1000012 --frame J2000 --step 600 \
  --start 2014-08-01T00:00:00 --stop 2016-09-30T11:00:00 --max-error-m 5

echo "=== Rosetta structure origin (resampled) ==="
# ROS_COG_V4 places the structure origin (ROS_SPACECRAFT, -226000), to which
# the solar-array and HGA gimbals of ROS_STRUCT are attached, relative to the
# spacecraft's centre of gravity (-226). The offset drifts by millimetres as
# propellant is used; daily samples reproduce it to a few centimetres on a
# 32 m spacecraft, at 0.3 MB instead of 7.
rebuild ROS_COG_V4_RESAMPLED.BSP "spk/ROS_COG_V4.BSP" \
  "$HERE/resample-spk.mjs" \
  --source "$SRC/ROS_COG_V4.BSP" --kernels "$BASE" \
  --target=-226000 --center=-226 --frame ROS_SPACECRAFT --step 86400 --degree 3 \
  --stop 2016-09-30T11:00:00 --max-error-m 0.1

echo "=== Rosetta attitude (thinned) ==="
ROS_ATT="ck/ATNR_P040302093352_T6_00127.BC ck/former_versions/RATT_DV_145_01_01_T6_00216.BC
         ck/former_versions/RATT_DV_223_01_01_T6_00302.BC ck/RATT_DV_257_02_01_T6_00344.BC"
# shellcheck disable=SC2086
rebuild ROS_ATT_THINNED.BC "$ROS_ATT" "$HERE/thin-ck.mjs" --kernels "$BASE,$(local_list $ROS_ATT)" \
  --inst=-226000 --frame ROS_SPACECRAFT --ref J2000 --step 60 --tol-deg 0.1 \
  --stop 2016-09-30T10:40:00

echo "=== 67P rotation (thinned) ==="
CG_ATT="ck/former_versions/CATT_DV_145_02_______00216.BC ck/former_versions/CATT_DV_223_02_______00302.BC
        ck/CATT_DV_257_03_______00344.BC"
# shellcheck disable=SC2086
rebuild CG_ATT_THINNED.BC "$CG_ATT" "$HERE/thin-ck.mjs" --kernels "$BASE,$(local_list $CG_ATT)" \
  --inst=-1000012000 --frame 67P/C-G_CK --ref J2000 --step 120 --tol-deg 0.05 \
  --stop 2016-10-01T00:00:00

echo "=== Solar arrays and HGA (thinned) ==="
SA="" HGA=""
for y in 2004_V0002 2005_V0002 2006_V0002 2007_V0002 2008_V0039 2009_V0055 2010_V0053 \
         2011_V0021 2014_V0048 2015_V0043 2016_V0042; do SA="$SA ck/ROS_SA_$y.BC"; done
for y in 2004_V0002 2005_V0002 2006_V0002 2007_V0002 2008_V0020 2009_V0053 2010_V0047 \
         2011_V0019 2014_V0045 2015_V0054 2016_V0043; do HGA="$HGA ck/ROS_HGA_$y.BC"; done
STOP=--stop=2016-09-30T10:40:00
# shellcheck disable=SC2086
{
rebuild ROS_SAPY_THINNED.BC "$SA" "$HERE/thin-ck.mjs" --kernels "$BASE,$(local_list $SA)" \
  --inst=-226015 --frame ROS_SA+Y --ref ROS_SA+Y_ZERO --step 60 --tol-deg 0.25 $STOP
rebuild ROS_SAMY_THINNED.BC "$SA" "$HERE/thin-ck.mjs" --kernels "$BASE,$(local_list $SA)" \
  --inst=-226025 --frame ROS_SA-Y --ref ROS_SA-Y_ZERO --step 60 --tol-deg 0.25 $STOP
rebuild ROS_HGA_EL_THINNED.BC "$HGA" "$HERE/thin-ck.mjs" --kernels "$BASE,$(local_list $HGA)" \
  --inst=-226071 --frame ROS_HGA_EL --ref ROS_SPACECRAFT --step 60 --tol-deg 0.25 $STOP
rebuild ROS_HGA_AZ_THINNED.BC "$HGA" "$HERE/thin-ck.mjs" --kernels "$BASE,$(local_list $HGA)" \
  --inst=-226072 --frame ROS_HGA_AZ --ref ROS_HGA_EL --step 60 --tol-deg 0.25 $STOP
}

echo "=== HGA rest frame ==="
# The array CKs have a fixed zero-gimbal frame to fall back to where they have
# no data (the 2011-2014 hibernation); the HGA's gimbal chain does not, so its
# zero pose is written out here: both gimbal frames coincide with the
# spacecraft frame at zero angles, leaving ROS_HGA's own fixed turn from
# ROS_HGA_AZ (ROS_V38.TF, FRAME -226075). -226079 is unused in ROS_V38.TF.
if [ ! -f "$DEST/ROS_HGA_ZERO.TF" ]; then
  cat > "$DEST/ROS_HGA_ZERO.TF" <<'FK'
KPL/FK

   ROS_HGA_ZERO: the Rosetta high-gain antenna frame at zero elevation and
   azimuth, for drawing the antenna where its gimbal CKs have no data. Written
   by cosmolabe's scripts/fetch-rosetta-kernels.sh from ROS_V38.TF.

\begindata

   FRAME_ROS_HGA_ZERO          = -226079
   FRAME_-226079_NAME          = 'ROS_HGA_ZERO'
   FRAME_-226079_CLASS         = 4
   FRAME_-226079_CLASS_ID      = -226079
   FRAME_-226079_CENTER        = -226070
   TKFRAME_-226079_RELATIVE    = 'ROS_SPACECRAFT'
   TKFRAME_-226079_SPEC        = 'ANGLES'
   TKFRAME_-226079_UNITS       = 'DEGREES'
   TKFRAME_-226079_ANGLES      = ( 0.000, -90.000, 0.000 )
   TKFRAME_-226079_AXES        = ( 1,       2,      3     )

\begintext
FK
  echo "  [write] ROS_HGA_ZERO.TF"
fi

echo ""
echo "Done! Rosetta kernels in $DEST"
du -sh --exclude=.source "$DEST" 2>/dev/null || du -sh "$DEST"
