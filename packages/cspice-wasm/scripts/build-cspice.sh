#!/usr/bin/env bash
#
# Reproducible CSPICE-WASM build for cspice-wasm.
#
# Builds the official NAIF CSPICE sources with Emscripten, then links the
# exported SPICE functions and native/gf-report.c into an ES module and WASM.
# Kernels arrive at runtime through KernelSource and the Emscripten filesystem.
#
# The vendored source lands in vendor/ (gitignored); the two artifacts in wasm/
# are committed, so this only needs running when the export list, the native
# shim, or the CSPICE version changes.
#
# The archive checksum pins the source. The SDK version pins both the compiler
# and the Emscripten runtime that generates cspice.mjs.
#
# Usage: bash packages/cspice-wasm/scripts/build-cspice.sh
# Requires: emscripten (emcc) on PATH at EMSDK_VERSION; run from the repository root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
VENDOR="$REPO_ROOT/vendor"
OUT="$REPO_ROOT/packages/cspice-wasm/wasm"
NATIVE="$REPO_ROOT/packages/cspice-wasm/native"
CSPICE_RELEASE="N0067"
CSPICE_URL="https://naif.jpl.nasa.gov/pub/naif/toolkit/C/PC_Linux_GCC_64bit/packages/cspice.tar.Z"
CSPICE_SHA256="60a95b51a6472f1afe7e40d77ebdee43c12bb5b8823676ccc74692ddfede06ce"
ARCHIVE="$VENDOR/cspice-$CSPICE_RELEASE.tar.Z"
# The exact Emscripten the committed artifacts were built with.
EMSDK_VERSION="6.0.9"

ACTUAL_EMCC="$(emcc --version | sed -nE '1s/.* ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')"
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

mkdir -p "$OUT" "$VENDOR"
BUILD="$(mktemp -d "$VENDOR/cspice-build.XXXXXXXX")"
trap 'rm -rf "$BUILD"' EXIT

verify_archive() {
  if ! printf '%s  %s\n' "$CSPICE_SHA256" "$1" | shasum -a 256 -c; then
    echo "CSPICE $CSPICE_RELEASE archive failed verification. Remove $ARCHIVE if cached and retry." >&2
    return 1
  fi
}

if [ -f "$ARCHIVE" ]; then
  verify_archive "$ARCHIVE"
else
  echo "Downloading official NAIF CSPICE $CSPICE_RELEASE ..."
  curl --fail --location --retry 2 --output "$BUILD/cspice.tar.Z" "$CSPICE_URL"
  verify_archive "$BUILD/cspice.tar.Z"
  mv "$BUILD/cspice.tar.Z" "$ARCHIVE"
fi

# Extract the library sources and public headers only. NAIF also ships native
# libraries and executables in this archive for the host named in the URL.
tar -xf "$ARCHIVE" -C "$BUILD" cspice/src/cspice cspice/include
patch -d "$BUILD" -p1 < "$NATIVE/wasm-abi.patch"
INCLUDE="$BUILD/cspice/include"
LIBRARY="$BUILD/libcspice_wasm.a"
echo "Compiling CSPICE $CSPICE_RELEASE ..."
(
  cd "$BUILD/cspice/src/cspice"
  export LC_ALL=C
  printf '%s\n' *.c | xargs -n 64 -P 8 emcc -c -O2 -I "$INCLUDE" \
    -Wno-parentheses -Wno-dangling-else -Wno-format -Wno-implicit-int
  emar rcs "$LIBRARY" *.o
)

# The SPICE surface the renderer and geometry layers call. Extend deliberately;
# every symbol here is reachable from cspice-wasm's typed API.
#
# Extending it is the cheap part, and it is the right part: an entry point left
# out here is one a caller has to approximate in TypeScript, and the
# approximation is where NAIF's semantics quietly go missing. ckcov_c/ckobj_c
# (issue #39) are the worked example -- a DAF-summary reconstruction of them
# gets segment coverage right and silently loses interval level, the
# CK_<id>_SCLK clock assignment, and CSPICE's own notion of which loaded
# kernels are CKs. Two symbols and ~9 KB of .wasm buy all of that back.
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
  "_ckcov_c","_ckobj_c",
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
echo "Linking cspice.mjs + cspice.wasm ..."
emcc "$NATIVE/gf-report.c" "$LIBRARY" -o "$BUILD/cspice.mjs" \
  -O2 \
  -Wl,--fatal-warnings \
  -I "$INCLUDE" \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=CSpice \
  -s WASM=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=167772160 \
  -s STACK_SIZE=5242880 \
  -s FORCE_FILESYSTEM=1 \
  -s EXPORTED_RUNTIME_METHODS="$RUNTIME_METHODS" \
  -s EXPORTED_FUNCTIONS="$EXPORTS"

# Mark the generated glue as a build artifact, portably across BSD and GNU sed.
{ printf '/* eslint-disable */\n// @ts-nocheck\n'; cat "$BUILD/cspice.mjs"; } > "$BUILD/glue.mjs"
mv "$BUILD/glue.mjs" "$OUT/cspice.mjs"
mv "$BUILD/cspice.wasm" "$OUT/cspice.wasm"

echo "Done. Artifacts in packages/cspice-wasm/wasm:"
ls -la "$OUT"
