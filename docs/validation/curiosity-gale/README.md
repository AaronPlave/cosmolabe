# Curiosity/Gale migration — issue 247

This migration retains Dingo Gap, the original Curiosity SPICE inputs and three
independent imagery choices, while replacing legacy quantized terrain with a
shared Mars cube build containing a bounded Gale residual. Dingo Gap is fixed
in `IAU_MARS` and explicitly visual-only. Read the
[scientific registration decision](source-registration.md) before interpreting
placement: absolute registration accuracy is unknown and the operational rover
does not coincide with the orbital-localized reconstruction.

## Published products

[mission.lock.json](mission.lock.json) records finite original inputs and
processing, [mission-build.json](mission-build.json) records supported gates,
[publication-receipt.json](publication-receipt.json) records immutable uploads,
and [remote-verification.json](remote-verification.json) independently checks
every public object, headers, CORS, missing 404s and cold LOD samples.

Build: `235f3500dbc5863198d0620001022b4913174029696419ce94b1ed59d6db65a3`.
Public host: `https://data.aaronplave.com`.

| Product | Immutable revision | Objects / bytes |
| --- | --- | --- |
| terrain-207dcdb48c82b74acaad4fcb | 207dcdb48c82b74acaad4fcb22452b06 | 585 / 51,846,127 |
| imagery-df467b18c609f3ac702aaeaf (Gale CTX) | df467b18c609f3ac702aaeaf84eb0668 | 23 / 12,343,371 |
| imagery-65a14eef13d9c08962ea5879 (Curiosity HiRISE) | 65a14eef13d9c08962ea5879f795274b | 28 / 12,678,309 |

Viking reuses the existing immutable global product. The new products total
636 objects / 76,867,807 bytes, excluding publication metadata. No old product
was overwritten. Receipt `catalogPinned:false` describes the publication-time
state; the reviewed catalog and datasets registry now carry the verified pins.
Publishing data does not deploy the viewer application.

The terrain has 290 tiles through L15 (~3.24 m finest lattice), CPU grids and
one revision identity. Seven source controls differ by less than 0.05 m;
120 CPU/float32-triangle picks differ by at most 0.012 m, and 120/120 tested
50 m clearance rays succeed. These are numerical consistency checks.
**Global coarse/mixed-LOD boundary diagnostics outside the fine ROI reach
827 m drawn-versus-CPU disagreement**; rendered clearance at some diagnostic
edges is below the nominal 50 m. The supported local gates do not certify all
global LOD boundaries. Runtime clearance uses the larger physical/drawn radius.

CTX service spacing is 20.35035 m, finest output ~12.955 m; HiRISE service
spacing is 1.271897 m, output ~1.61943 m. Resampling creates no additional
native accuracy. Finite source inventories contain 667 CTX and 822 HiRISE
responses, including 97 and 89 unavailable responses respectively. Those holes
remain transparent. Acquisition and conversion reuse the #249/#251 shared
interfaces; arbitrary global CTX browsing is outside this migration.

## Runtime and evidence

`scripts/test-curiosity-site-mesh.mjs` exercises five named views, four SPICE
epochs/attitudes, cube-owned picking, actual cache eviction, deliberate mesh
503s and explicit retry recovery. `SITE_MESH_SYNTHETIC=1` adds the checked-in
ENU square alongside the NED sample. Placement must remain bit-for-bit fixed.
The retry regression guards an upstream 0.4.27 traversal of unprocessed nodes.

`scripts/test-hosted-curiosity.mjs` checks the normal hosted rewrite, cold browser
requests, immutable product responses, existing imagery stack controls, local
crop/global fallback navigation, catalog reload and Ingenuity/MoonFall smoke
regressions. It serves the real production bundle under `/cosmolabe/`; it does
not intercept catalogs or provide local scientific-data fallback.

The original default epoch remains 2014-02-05T12:00Z, when the site is just
below the solar horizon. The additional explicitly timed `Dingo Gap Daylight`
view uses 20:00Z. Close-up viewpoints use Mars-fixed directions. Cold cuts can
initially encounter a coarse high triangle; a parked surface-locked camera
retains its requested pose and recovers only above both drawn and physical
ground as refinement arrives. Any camera/target/focus input cancels recovery.
Neither rover nor mesh moves to follow terrain.

The retained [browser acceptance](browser/acceptance.json) records the actual
Apple M4 Max / Metal GPU, numerical SPICE checks, cache release from 40,122,508
bytes to zero, forced failure/recovery, independent source responses, five
50 m ground-navigation checks and both mission smoke checks. All tracked
models/textures loaded, with no page exceptions or missing mandatory base
blocks. The hosted run exercised the real CTX checkbox and keyboard-operated
opacity slider. A cancelled CTX request and a reset background `mar099s.bsp`
transfer occurred during catalog changes and remain disclosed in the report.
The final nested-group priority propagation was separately rechecked with both
meshes through the complete development-browser lifecycle; the recorded hosted
bundle preceded that small fix.

Selected unmodified captures: [daylight](browser/dingo-gap-daylight.png),
[rover close-up](browser/curiosity-close-up.png),
[imagery controls](browser/imagery-controls.png),
[compact](browser/compact.png). The rover close-up preserves the legitimate
SPICE/orbital-ground discrepancy; screenshots do not establish absolute accuracy.
Validation also passed 111 focused renderer tests after merging current main,
14 Python fixture tests, the 12 shared executor tests, package build, test/viewer/
Svelte type checks and changed-file lint. No new device testing gate was added.

## Reproduce without publication

Use the exact source hashes and toolchain versions in the lock. GDAL Python
bindings and NumPy are required. The original 11.4 GB global DEM and MEG016
label/image are external inputs; the original Gale crop, NASA scene/tileset,
root tile and exact PLACES control rows are checked in. Mutable upstream
services may change: original-response replay fails on changed hashes rather
than substituting new bytes into an existing identity.

External originals: [USGS HRSC/MOLA 200 m v2](https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif),
[MEG016 label](https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg016/mega90n000eb.lbl)
and [image](https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg016/mega90n000eb.img).

```sh
npm run build
RUN=work/curiosity-247-replay
mkdir -p "$RUN/inputs"
gzip -dc docs/validation/curiosity-gale/evidence/dingo-scene.json.gz > "$RUN/inputs/dingo-scene.json"
gzip -dc docs/validation/curiosity-gale/evidence/dingo-tileset.json.gz > "$RUN/inputs/dingo-tileset.json"
cp docs/validation/curiosity-gale/evidence/dingo-root.b3dm "$RUN/inputs/"
cp docs/validation/curiosity-gale/evidence/gale-dingo-dem-window.tif "$RUN/inputs/"
# BASE is the original USGS HRSC/MOLA 200m v2 raster; AREOID_DIR contains
# the original MEGA90N000EB.LBL and .IMG (MEG016), all hashed in the report.
node scripts/audit-msl-spice.mjs "$RUN/spice-states.json"
python3 scripts/terrain/audit_curiosity_registration.py \
  --inputs "$RUN/inputs" --base "$BASE" \
  --areoid "$AREOID_DIR/MEGA90N000EB.LBL" --spice "$RUN/spice-states.json" \
  --control-snapshot docs/validation/curiosity-gale/evidence/places-control-snapshot.json \
  --out "$RUN/source-registration.json"
# If BASE has no overview, first reproduce its original overview dependency:
# gdaladdo -ro -r average "$BASE" 2 4 8 16 32 64 128 256
python3 scripts/terrain/dem.py fuse --base "$BASE" \
  --detail "$RUN/inputs/gale-dingo-dem-window.tif" --out "$RUN/fusion" \
  --blend-m 50 --fit-stride 8 --bias none \
  --vertical-datum 'MOLA areoid topography; unchanged source elevations'
python3 scripts/terrain/acquire_cube_xyz.py \
  --replay-bundle docs/validation/curiosity-gale/evidence/gale-ctx-bounded.json.gz \
  --out "$RUN/ctx" --workers 8
python3 scripts/terrain/acquire_cube_xyz.py \
  --replay-bundle docs/validation/curiosity-gale/evidence/curiosity-hirise-bounded.json.gz \
  --out "$RUN/hirise" --workers 8
node scripts/surface-build/curiosity.mjs "$RUN/inputs" "$BASE" "$AREOID_DIR" \
  "$RUN/source-registration.json" "$RUN/mission-inputs" \
  "$RUN/ctx/bundle.json" "$RUN/hirise/bundle.json"
node scripts/build-surface.mjs "$RUN/mission-inputs/lock.json" \
  --bindings "$RUN/mission-inputs/bindings.json" --cache "$RUN/cache" --execute --workers 4
```

The audit using compact controls reproduces the numerical results; its input
inventory intentionally records the compact snapshot rather than pretending
the omitted mission CSV rows were present. Input path changes do not affect
the scientific transform. The preparation script normalizes volatile fusion
metadata before hashing the dependency bundle; original fused samples stay
unchanged. A changed generator/toolchain/source produces a new identity.

For the hosted browser check, use the ordinary deployment rewrite:

```sh
VITE_BASE=/cosmolabe/ BUNDLE_TEST_CATALOGS=1 HOSTED_DATA=1 npm --prefix apps/viewer run build
DATA_BASE_URL=https://data.aaronplave.com node scripts/build-hosted-catalogs.mjs \
  --dist apps/viewer/dist --allow-unpublished terrain/mars-terrain-fused \
  --allow-unpublished kernels/rosetta
npm --prefix apps/viewer run preview -- --host localhost --port 5173 --strictPort --base /cosmolabe/
node scripts/test-hosted-curiosity.mjs http://localhost:5173/cosmolabe/ "$RUN/browser-hosted"
# Separately run the synthetic fixture against a normal development server:
SITE_MESH_SYNTHETIC=1 node scripts/test-curiosity-site-mesh.mjs http://127.0.0.1:5177/ "$RUN/browser-synthetic"
```

The two allowed unpublished datasets are existing unrelated Rosetta/legacy-Mars
catalog dependencies; the Curiosity products must use verified registry pins.

## Rollback

Before application deployment, revert this feature commit and rebuild using the
normal hosted pipeline. [previous-catalog.json](previous-catalog.json) records
the precise pre-migration Curiosity catalog for comparison; restoring only this
catalog into the new renderer is insufficient because the legacy surfaceTiles
contract was replaced. Restore the code/catalog together. Revert the dataset
registry additions with the code; retain all immutable objects and publication
receipts for audit and other consumers. Never overwrite/delete the published
prefixes to implement rollback. No application release has been performed as
part of the data publication.
