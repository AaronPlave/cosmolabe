#!/usr/bin/env bash
#
# Reproducible CSPICE-WASM build for cspice-wasm.
#
# Vendors NASA/JPL CSPICE via the arturania/cspice fork (ADR-0004), compiles it
# to a static library with Emscripten, then links the SPICE surface Bessel needs
# -- plus this package's own native/gf-report.c -- into an ES module plus a .wasm
# payload. Kernels are never embedded: they arrive at runtime through the PAL
# KernelSource and are written into the Emscripten FS.
#
# The vendored source lands in vendor/ (gitignored); the two artifacts in wasm/
# are committed, so this only needs running when the export list, the native
# shim, or the CSPICE version changes.
#
# "Reproducible" is meant literally, and is pinned rather than hoped for: both
# inputs that decide the output bytes are fixed here. CSPICE_REV pins the source
# (the fork is dormant -- its HEAD has not moved since 2021 -- but a floating
# HEAD is still a floating input), and EMSDK_VERSION pins the compiler, which
# matters more: Emscripten regenerates the whole JS glue on every release, so a
# different emcc rewrites cspice.mjs wholesale and changes the .wasm. Building
# with another version is possible (ALLOW_EMCC_MISMATCH=1) but it is a toolchain
# upgrade, and belongs in its own commit rather than riding along with a change
# to the export list.
#
# Usage: bash packages/cspice-wasm/scripts/build-cspice.sh
# Requires: emscripten (emcc) on PATH at EMSDK_VERSION; run from the repository root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
VENDOR="$REPO_ROOT/vendor/cspice"
OUT="$REPO_ROOT/packages/cspice-wasm/wasm"
NATIVE="$REPO_ROOT/packages/cspice-wasm/native"
CSPICE_REMOTE="https://github.com/arturania/cspice.git"
# The exact commit the committed artifacts were built from.
CSPICE_REV="53bce326267dd2d6d567de92b15869c9ed7d0629"
# The exact Emscripten the committed artifacts were built with.
EMSDK_VERSION="6.0.9"

mkdir -p "$OUT"

ACTUAL_EMCC="$(emcc --version | head -1 | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
if [ "$ACTUAL_EMCC" != "$EMSDK_VERSION" ]; then
  if [ "${ALLOW_EMCC_MISMATCH:-0}" != "1" ]; then
    echo "emcc is $ACTUAL_EMCC, but the committed artifacts were built with $EMSDK_VERSION." >&2
    echo "A different Emscripten rewrites cspice.mjs wholesale and changes cspice.wasm." >&2
    echo "Install the pinned one (emsdk install $EMSDK_VERSION && emsdk activate $EMSDK_VERSION)," >&2
    echo "or set ALLOW_EMCC_MISMATCH=1 and update EMSDK_VERSION in this script as its own commit." >&2
    exit 1
  fi
  echo "WARNING: building with emcc $ACTUAL_EMCC, not the pinned $EMSDK_VERSION."
fi

# Fetch the pinned commit itself rather than whatever HEAD happens to be: one
# object, no history, and the revision is the one recorded above.
if [ ! -d "$VENDOR/src" ]; then
  echo "Fetching CSPICE $CSPICE_REV into vendor/cspice ..."
  mkdir -p "$VENDOR"
  git -C "$VENDOR" init -q
  git -C "$VENDOR" remote add origin "$CSPICE_REMOTE" 2>/dev/null || true
  git -C "$VENDOR" fetch -q --depth 1 origin "$CSPICE_REV"
  git -C "$VENDOR" checkout -q FETCH_HEAD
fi

VENDOR_REV="$(git -C "$VENDOR" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$VENDOR_REV" != "$CSPICE_REV" ]; then
  echo "vendor/cspice is at $VENDOR_REV, not the pinned $CSPICE_REV." >&2
  echo "Remove vendor/cspice and re-run to fetch the pinned revision." >&2
  exit 1
fi

if [ ! -f "$VENDOR/lib/libcspice_wasm.a" ]; then
  echo "Building libcspice_wasm.a (this compiles ~2000 C files) ..."
  ( cd "$VENDOR/src" && csh ./mk_wasm.csh )
fi

# The SPICE surface the renderer and geometry layers call. Extend deliberately;
# every symbol here is reachable from cspice-wasm's typed API.
EXPORTS='[
  "_malloc","_free",
  "_tkvrsn_c","_erract_c","_errprt_c","_errdev_c","_failed_c","_getmsg_c","_reset_c",
  "_furnsh_c","_unload_c","_kclear_c","_ktotal_c","_kdata_c",
  "_str2et_c","_et2utc_c","_utc2et_c","_timout_c","_sce2c_c","_sct2e_c","_scs2e_c","_sce2s_c","_deltet_c","_unitim_c",
  "_bodn2c_c","_bodc2n_c","_bods2c_c","_bodvrd_c","_bodvcd_c","_namfrm_c","_frmnam_c",
  "_spkpos_c","_spkezr_c","_spkez_c","_spkgps_c",
  "_pxform_c","_sxform_c",
  "_getfov_c",
  "_sincpt_c","_subpnt_c","_subslr_c","_ilumin_c",
  "_vnorm_c","_vsep_c","_vdist_c","_recrad_c","_reclat_c","_recsph_c","_convrt_c",
  "_dpr_c","_rpd_c","_spd_c","_clight_c","_georec_c","_latrec_c",
  "_dafopr_c","_dafcls_c","_dafbfs_c","_daffna_c","_dafgs_c","_dafgn_c","_dafus_c",
  "_spkopn_c","_spksub_c","_spkcls_c",
  "_ckopn_c","_ckw03_c","_ckcls_c","_ckgp_c","_ckgpav_c",
  "_dasopr_c","_dascls_c","_dlabfs_c","_dlafns_c",
  "_dskobj_c","_dsksrf_c","_dskgd_c","_dskz02_c","_dskv02_c","_dskp02_c","_dskb02_c",
  "_dskw02_c","_dskmi2_c","_dskrb2_c",
  "_prop2b_c","_conics_c","_oscelt_c","_oscltx_c",
  "_spkw09_c","_spkw13_c",
  "_gfdist_c","_gfsep_c","_gfposc_c","_gfoclt_c","_gfrfov_c","_gftfov_c","_occult_c",
  "_gfrpt_dist","_gfrpt_sep","_gfrpt_posc","_gfrpt_oclt",
  "_ssize_c","_scard_c","_wninsd_c","_wncard_c","_wnfetd_c",
  "_wnintd_c","_wnunid_c","_wndifd_c","_wnsumd_c",
  "_recgeo_c","_recpgr_c","_et2lst_c","_georec_c",
  "_twovec_c","_m2q_c","_q2m_c","_raxisa_c","_axisar_c","_eul2m_c","_m2eul_c","_mxv_c","_mtxv_c",
  "_illumf_c","_phaseq_c","_edterm_c","_gfilum_c"
]'

RUNTIME_METHODS='["FS","ccall","cwrap","getValue","setValue","UTF8ToString","stringToUTF8","lengthBytesUTF8","writeArrayToMemory"]'

# native/gf-report.c compiles alongside CSPICE. It is what makes the general GF
# entry points (gfevnt_c, gfocce_c) usable from JavaScript: they take progress
# and bail-out handlers as C function pointers, and compiling those handlers here
# -- each calling out to JS through EM_JS -- avoids addFunction and
# ALLOW_TABLE_GROWTH entirely, keeping the handler signatures in C where CSPICE
# declares them.
# INITIAL_MEMORY is a budget, not a convenience: a SPICE-backed viewer scene
# runs two always-on CSPICE instances (main thread + trajectory-cache worker),
# so whatever is passed here is reserved twice before a single kernel is
# fetched. It is documented, and pinned by a test, in src/wasm-memory.ts --
# keep the two in step. An artifact can also be re-pinned without a rebuild
# (scripts/set-initial-memory.mjs), which is what that one number reaches.
echo "Linking cspice.mjs + cspice.wasm ..."
emcc "$NATIVE/gf-report.c" "$VENDOR/lib/libcspice_wasm.a" -o "$OUT/cspice.mjs" \
  -O2 \
  -I "$VENDOR/include" \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=CSpice \
  -s WASM=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=117440512 \
  -s STACK_SIZE=5242880 \
  -s FORCE_FILESYSTEM=1 \
  -s EXPORTED_RUNTIME_METHODS="$RUNTIME_METHODS" \
  -s EXPORTED_FUNCTIONS="$EXPORTS"

# Mark the generated glue as not lintable; it is a build artifact.
sed -i.bak '1s;^;/* eslint-disable */\n// @ts-nocheck\n;' "$OUT/cspice.mjs"
rm -f "$OUT/cspice.mjs.bak"

echo "Done. Artifacts in packages/cspice-wasm/wasm:"
ls -la "$OUT"
