# Reproduce the validated full mission without publishing

The [production release record](production-release/README.md) contains the real
publication receipt, verified dataset pins, hosted acceptance and captured
production rollback baseline. The original pre-publication review steps below
remain useful for reproducing the scientific build.

The historical audit commands in [README](README.md) create a clean fusion,
original DEM overview dependency, and numerical audit. Their legacy-flight
snapshot is deliberate: the old coordinate interpretation must be audited using
the old files. Only the historical comparison reads an old fused product.
New execution uses the independently recomputed, byte-verified fusion.

Reproduce the terrain registration decision independently of flight observations:

```sh
curl -fL 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/CTX/DTM_MOLAtopography_DeltaGeoid_20m_Jezero_F05X_v7pt1_Eqc_latTs0_lon0.tif' -o "$RUN/upstream/ctx-dtm.tif"
python3 scripts/terrain/audit_ingenuity_registration.py \
  --base "$SOURCE_DIR/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif" \
  --detail "$SOURCE_DIR/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif" \
  --reference "$RUN/upstream/ctx-dtm.tif" --fusion "$RUN/clean-fusion" \
  --out "$RUN/terrain-registration.json"
```

The CTX LVS reference is 9,662,387 bytes, SHA-256
`16a1aa66c3f48c1bca252795827db7b417876217aff0f5e1aff18027fab2327b`.
It corroborates the published HiRISE control parent; it is not independent
absolute truth or a reason to fit terrain to the flight reconstruction.

Use the exact source hashes in [source inventory](source-inventory.json),
[mission geometry evidence](mission-geometry-evidence.json), and
[terrain registration evidence](terrain-registration.json). The lock pins
Python/GDAL/NumPy versions. Different source, toolchain or implementation bytes
create a different identity; do not relabel them as this build.

After creating `$RUN/original-dem-inputs`, `$RUN/clean-fusion`, and
`$RUN/scientific-audit.json`, acquire both **original** orthomosaics as shown in
the README. Retain their original bytes at `$RUN/upstream/{hirise-ortho,jezero-ctx}.tif`.
Restore the exact finite original-response inventories:

```sh
python3 scripts/terrain/acquire_cube_xyz.py \
  --replay-bundle docs/validation/ingenuity-jezero/evidence/viking-responses.json.gz \
  --out "$RUN/viking-bundle-1024" --workers 8
python3 scripts/terrain/acquire_cube_xyz.py \
  --replay-bundle docs/validation/ingenuity-jezero/evidence/ctx-responses.json.gz \
  --out "$RUN/ctx-v01-bundle-1024" --workers 8
node scripts/surface-build/ingenuity.mjs \
  "$RUN/original-dem-inputs" "$RUN/clean-fusion" "$AREOID_DIR" \
  "$RUN/scientific-audit.json" "$RUN/mission-inputs" "$RUN"
node scripts/build-surface.mjs "$RUN/mission-inputs/lock.json" \
  --bindings "$RUN/mission-inputs/bindings.json" --cache "$RUN/cache" \
  --execute --workers 4 > "$RUN/mission-build.json"
```

The active CTX manifest uses the official V01 `OnMars/CTX1` service, with
available original low-resolution overviews (`minZoom: 0`). The superseded
beta-service inventory is retained only as
[`ctx-beta-responses.json.gz`](evidence/ctx-beta-responses.json.gz), alongside
[the repeated-pixel diagnostic](ctx-source-diagnostic.json). It contains 36
nonuniform source responses duplicated at different addresses despite different
encoded hashes; the new mission lock rejects that inventory. The two V01
unavailable responses remain transparent, and the decoded-content gate passes
all 3,607 textured V01 responses. This audit covers the acquired inventory;
it does not certify all unrequested remote service tiles or absolute registration.

The response manifests pin all 11,028 Viking and 3,609 V01 global CTX responses,
including two unavailable V01 responses. Replay checks every response hash and
fails if upstream bytes have changed. It never turns a missing/corrupt response
into a resampled parent. An incomplete replay has no `bundle.json` and cannot
be used as a completed source. A complete executor run still checks response
addressing, decoded dimensions, decoded pixel identity across same-level
geographic addresses, original PNG nodata masks, claimed holes, native mask subsets, terrain
controls, source registration, output inventories and checksums. No network is
used by the executor itself.

[mission.lock.json](mission.lock.json) is the reviewed finite selection. The
global service equatorial intervals are 325.605638 m for Viking and 5.087588 m
for CTX; the original mosaics' nominal 232 m / 5 m GSDs remain separately
recorded. The CTX source target is 6 m. Output grid spacing cannot create
missing native detail. Regional CTX and HiRISE source intervals are 6 m and
0.25 m; terrain uses the original 1 m HiRISE DTM within a 200 m global base.
The lock explicitly lists Jezero CTX under `independentImageGrids`: its original
6 m map has a different origin from the DTM. Each source's own affine/native
registration is validated against its output. HiRISE's shared-origin 4:1 grid
relationship to the DTM remains a separate required check.

To regenerate the explicitly estimated flight representation:

```sh
node scripts/build-ingenuity-flights.mjs --fusion "$RUN/clean-fusion" \
  --areoid "$AREOID_DIR/MEGA90N000EB.LBL"
python3 scripts/terrain/validate_ingenuity_flights.py \
  --fusion "$RUN/clean-fusion" --areoid "$AREOID_DIR/MEGA90N000EB.LBL" \
  --out "$RUN/flight-validation.json"
```

The checked-in official flight-log JSON is a hash-pinned import of NASA's final
PDF. `import_ingenuity_log.py --help` documents importing that same edition.
The original path/landing observations are retained; reconstructed altitude,
interior timing, source conflicts and frame/clock uncertainty are explicit in
`data/ingenuity/reconstruction.json` and the selected object's inspector.

To run the actual mission acceptance, link only completed product directories
from the report into `apps/viewer/test-catalogs/data/ingenuity-cube/<productId>`
and use the matching IDs in the candidate mission catalog. Start the viewer with
local data, then run the GPU test:

```sh
DEV_DATA_MODE=local npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5198
node scripts/test-ingenuity-jezero.mjs http://127.0.0.1:5198/ "$RUN/browser"
```

The macOS script selects Google Chrome's Metal backend and rejects a software
renderer. It uses the real catalog and scientific products. Deliberately injected
404/transparent responses are confined to its outage assertions and restored
before normal acceptance. A successful script is required; merely creating the
script is not acceptance evidence.

The only publication command allowed before authorization is the read-only
preflight:

```sh
node scripts/build-surface.mjs "$RUN/mission-inputs/lock.json" \
  --cache "$RUN/cache" --publication-plan > "$RUN/publication-plan.json"
```

Do not use `--publish-r2` or apply a deployed catalog change without the user's
explicit authorization. Pending dataset registrations retain `build: null`.
Retain the baseline commit `70899b98e7bfe218c81e0c73ef7494924ebf9152` and its
mission catalog, flight files and dataset pins for rollback. After authorization,
the shared publisher requires the exact preflight identity, verifies immutable
objects over HTTP, and creates the receipt used to prepare hosted pins and an
offline rollback candidate. Neither a preflight nor a local GPU pass asserts
independent absolute source accuracy or exact flight telemetry.


## Completed review identity and publication boundary

The completed local build is
`56588b0ff3d445016722c38497d5b59e0d4e9f15e2a9e1dcb4dd72ba2905e10e`.
[Build/coverage/native-grid evidence](mission-build.json) and
[physical GPU acceptance](mission-runtime.json) refer to those exact five
products. [Publication preflight](mission-publication-plan.json) contains their
immutable prefixes, object counts and inventory hashes. The confirmation identity
is `63894ab8a6241fc78b254a3972cf386231fd75642998539f06c0946931d1e4d1`.
It must be regenerated and matched before any authorized remote publication.

The [offline catalog plan](publication-catalog-plan.json) prepares all six URL
replacements, five post-verification dataset pins and local rollback operations.
It does not claim a remote receipt or capture of the live deployment. After
explicit authorization, publication verifies every object/hash/type/cache policy,
missing-object HTTP 404 and the selected deployment/localhost CORS origins before
pinning. Capture the exact live deployment/catalog backup before switching it;
rollback restores that backup and leaves immutable scientific data intact.
The upload would create 5,103 product objects plus ten publication metadata
objects. Product bytes total 1,243,309,388; published bytes remain null.

Final local acceptance commands:

```sh
node scripts/test-ingenuity-jezero.mjs http://localhost:5173/ "$RUN/browser"
node scripts/test-ingenuity-jezero.mjs http://localhost:5173/ "$RUN/clearance-frames" --clearance-frames-only
node scripts/test-near-surface-performance.mjs http://localhost:5173/ "$RUN/navigation"
CUBE_STYLE_URL=http://localhost:5173 CUBE_STYLE_OUT="$RUN/moonfall" \
  CUBE_STYLE_CATALOGS=test-catalogs/moonfall-shackleton \
  node scripts/test-cube-surface-appearance.mjs
```

The mission uses a 960 MiB residency target with protected display references
and a four-page transition reservation. The first command checks 49 viewport
samples in two-layer/full-stack configurations before and after a live target
reduction to 128 MiB. The protected fine cover survives that reduction, and actual
allocation/overage is reported. A separate cold 48 MiB application verifies bounded
allocation, complete real base coverage and deferred refinement.

Independent imagery motion and constrained instrument acceptance:

```sh
node scripts/test-imagery-refinement.mjs http://localhost:5173/ "$RUN/imagery-motion"
node scripts/test-imagery-instrument.mjs http://localhost:5173/ "$RUN/instrument"
```

The instrument script adds an explicitly synthetic nadir sensor to the page's
catalog copy and checks full-screen feed switches; it does not alter the mission.
The motion script enforces a physical GPU and visible imagery, tests delayed and
out-of-order tiles, transient errors, absent intermediate parents, accelerated
playback, reversals, cube seams, allocation failure and context restoration.
See [architecture and matched baseline reproduction](../imagery-refinement-257/architecture.md).
Neither these commands nor the publication preflight upload or deploy anything.
