# Finite surface build execution — issue #251

This is the first executable, offline slice of #251. It consumes #248's validated
lock, emits a build DAG, runs the existing residual fusion and cube builders,
validates a synthetic Mars fixture and exercises #137's immutable publisher and
HTTP verifier against local storage. It does **not** complete #251's real Mars
pilot or authorize a production upload. No production catalog is changed.

## Reproduce

Install the repository dependencies and build the packages:

```sh
npm ci
npm run build
```

Inspect the checked-in synthetic lock without Python, rasters, credentials,
network access or output writes:

```sh
npm run --silent build:surface -- docs/examples/surface-plans/synthetic-build.lock.json
```

Generate the tiny local assets and a new lock from their actual checksums. Use a
Python with NumPy and GDAL bindings; in the Linux development image that is
`/usr/bin/python3`, which can differ from `python3` on PATH:

```sh
node scripts/surface-build/fixture.mjs /tmp/surface-pilot /usr/bin/python3
node scripts/build-surface.mjs /tmp/surface-pilot/lock.json \
  --bindings /tmp/surface-pilot/bindings.json --cache /tmp/surface-cache
node scripts/build-surface.mjs /tmp/surface-pilot/lock.json \
  --bindings /tmp/surface-pilot/bindings.json --cache /tmp/surface-cache \
  --python /usr/bin/python3 --workers 1 --execute
```

All CLI results are JSON on stdout; execution logs go to stderr. Errors emit
structured `diagnostics` and exit 2. Bindings map source IDs to local files and
resolve relative to the bindings file. They are execution locations, never part
of source or output identity. The dry run hashes bound files and XYZ responses;
it does not decode rasters, create directories or fetch missing sources.

Execution writes under `<cache>/<buildId>.building/`, validates, then atomically
renames the finished directory to `<cache>/<buildId>/`. A completed directory has
`lock.json`, `dag.json`, `source-audit.json`, `report.json`, `complete.json`, the
individual products and numerical diagnostics. The completion receipt inventories
every file except itself with SHA-256. Cached outputs are reused only after
checking that full inventory. Missing/corrupt/changed inputs fail before reuse;
changed outputs fail rather than being silently repaired under the same identity.

An interrupted build retains `.building` for diagnosis and cannot publish. It is
not resumed from arbitrary partial tile files: inspect/remove that scratch
directory or use a fresh cache before retrying. Concurrent writers to the same
build are rejected by exclusive directory creation. Existing completed outputs
are never overwritten.

## Supported execution contract

The existing desired/locked/source schemas remain authoritative. Execution adds
a narrow capability check on `processing`, **not** a second planner state format:

- `generator: {name: "cosmolabe-surface-build", version: "1"}` and
  `fusion: "residual-bias-none"`.
- `output.formatVersion: "cosmolabe-cube-1"`, PNG imagery, `float32` CPU heights,
  tile size up to 1024 and a 1–8 pixel gutter. The shared lock's
  `tiled-raster-pyramid` representation is retained; this format version selects
  the existing cube outputs rather than claiming a new private renderer format.
- `parameters.terrain`: explicit base/detail source IDs, global level, finite
  `NAME@LAT,LON:L=KM,...` regions in the existing builder syntax, taper distance
  and fit stride. Bias is always preserved (`--bias none`). The plane is measured
  and gated; it is never silently removed. All selected elevation resampling
  must be `cubic`, matching the existing fusion sampler.
- `parameters.imagery`: 1–4 independently built source IDs with their own global
  levels/regions, visibility and opacity. Array order is preserved. Selections
  use `bilinear`, matching the shared XYZ adapter. No geometry is built in
  response to imagery LOD. No source composite erases layer controls.
- `parameters.gates`: maximum registration offset and fused boundary step in
  metres, explicit camera clearance and independently stated CPU height controls.
  A measured control failure prevents completion. Clearance defaults remain
  unchanged for existing validator callers; the fixture explicitly requests
  100 m because of its coarse geometry.
- `parameters.caveats`: explicit strings that survive into the report, including
  the fixture's absence of observed HiRISE DTM coverage.

Every source needs SHA-256 and exact asset bytes, identity-compatible coordinates
and datum, declared coverage and native fidelity. Version strings alone are not
content pins. Supplied reuse restrictions or unknown permissions fail. Missing
discovery/illumination evidence is retained as unknown, never invented; this
fixture profile cannot be promoted to production.

The fixture profile limits regional levels to L4 and global overviews to L3,
so even an accidentally global regional cap cannot enumerate an unbounded bake.
It supports spherical, planetocentric, east-positive Mars,
geographic north-up single-band DEM GeoTIFFs and the existing EPSG:4326 XYZ cube
adapter. Real ellipsoidal/areoid inputs are rejected explicitly. No arbitrary
GDAL commands, shell fragments, custom transform strings, browser processing,
discovery crawler or persistent build service are accepted.

Imagery assets are finite `locked-xyz-bundle` JSON documents (version 1): a shared
XYZ `config` and a `tiles` object mapping `z/x/y` to `{path, sha256}`. Each original
response is separately hashed. The adapter reads only these pinned responses;
missing required tiles, changed bytes, wrong dimensions and corrupt images fail
without falling through to HTTP or mutable URL caches. The existing live XYZ
adapter behavior remains available to its existing callers. Current identity
locks require unmasked sources, so transparent source responses fail this profile.

The worker copies inputs to staging and verifies their hashes before use. It
checks actual raster masks/nodata, dimensions, reference sphere and pixel
registration before fusion. Local paths and timing are excluded from product
content identities; generated imagery and terrain metadata are normalized so a
clean rebuild produces the same product bytes. Source/lock, taper, output choices
or implementation changes produce a new build identity. Implementation hashes
include the shared builders, addressing/CPU primitives and dependency lock.
The rebuild regression uses the same GDAL/Python environment. Cross-version
Python/GDAL toolchain pinning is still required before production reproducibility
can be claimed; the Node dependency lock alone does not pin those tools.

## Reports and publication boundary

`report.json` preserves requested and selected fidelity, native source GSD and
accuracy, actual output spacing by level, exact emitted tile availability, alpha
counts, source/fallback/illumination provenance, output bytes and object counts,
elapsed time and individual process memory high-water marks. Source response
bytes are separate from the bundle manifest bytes. Output counts include product
metadata. Working disk at completion is **not** claimed as peak disk. Concurrent
peak RAM and peak disk remain `null`; planner raster estimates are labeled
uncalibrated scenarios, not cube packing guarantees.

An emitted tile is evidence of built availability, not native detail throughout
its footprint. In particular, upsampling a coarse parent cannot satisfy a finer
physical target. Alpha counts are not a verified continuous native-valid footprint.
Sources remain upstream evidence; their descriptors are not rewritten to claim
published coverage.

`--publish-local --local-dir DIR --verify-url URL` publishes an already completed
fixture through #137's existing local backend and HTTP verifier. An HTTP server
must serve that directory with the publisher's stored metadata (CORS, content
types, immutable headers, plain 404). Tests use the existing data-hosting fixture
server and verify all three products. This mode does not start a service, use R2,
pin `datasets.json` or rewrite a mission catalog. Publication validates content
again and rejects a completed prefix with different bytes.

Reports always say `productionReady: false`. Remaining #251 acceptance work:

1. Extend the **shared** lock's identity-only transform contract to explicitly
   represent the adopted areoid/planetocentric → ellipsoid-normal operation, with
   all areoid inputs and checksums. The existing Mars cube builder already has
   that operation; hiding it behind an executor-only flag would violate #248.
2. Lock actual MOLA/HRSC and a controlled HiRISE DTM/ortho region from evidenced
   #249 metadata. The synthetic fixture establishes no real DTM availability.
3. Add source-to-output imagery registration controls, verified native valid
   footprint/level receipts, appropriate real seam/illumination gates, concurrent
   resource measurements and browser/mission acceptance. The existing renderer's
   #272 tests remain separate evidence.
4. Prove regional terrain ownership/transitions atop a shared global baseline,
   then reuse #137's R2/deployment rewrite after review. No composable physical
   terrain patches or production pin are promised by this slice.

## Handoff: resume the real Mars pilot

Keep #251 open. The next implementation step is the shared lock transform,
not raising this fixture profile's L4 limit or changing `productionReady` to true.
Extend `LockedSurfacePlan` and `validateLockedSurfacePlan` in
`packages/core/src/surface-plan/{model,validation}.ts`, with regressions for both
identity locks and explicit areoid conversion. Then extend
`scripts/surface-build/{plan.mjs,worker.py}` to dispatch the already implemented
`dem.py cube-tile --source-convention areoid-radial --areoid ...` operation.
Pin both the detached label and its image; changing either must change the lock
and build identity. Preserve #50's existing residual and `--bias none` behavior.

The canonical areoid source is MOLA MEG016. Download was attempted here but the
environment proxy rejected CONNECT with HTTP 403. Its active allowlist did not
include **`pds-geosciences.wustl.edu`**, including after a restart. Add that exact
hostname to the environment configuration and apply it to the running worker;
allowing `pds.nasa.gov` alone does not cover this separately hosted PDS node.
Do not bypass the proxy or substitute a reference ellipsoid for the areoid.

After access is available:

```sh
mkdir -p /tmp/mola-meg016
curl -fL https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg016/mega90n000eb.lbl -o /tmp/mola-meg016/MEGA90N000EB.LBL
curl -fL https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg016/mega90n000eb.img -o /tmp/mola-meg016/MEGA90N000EB.IMG
sha256sum /tmp/mola-meg016/MEGA90N000EB.LBL /tmp/mola-meg016/MEGA90N000EB.IMG
gdalinfo /tmp/mola-meg016/MEGA90N000EB.LBL
```

Verify the label describes `AREOID_RADIUS`, planetocentric latitude, the
5760×2880 grid at 16 pixels/degree, and the 3,396,000 m offset before pinning it.
Keep the uppercase filenames together because the label references its image.
The existing builder validates these product-specific assumptions.

For the actual baseline/detail source URLs, use
`scripts/build-mars-terrain/01-fetch-sources.sh` (global baseline approximately
11 GB; inspect resources before invoking). The source hosts are
`planetarymaps.usgs.gov`; verify any redirect destinations against the active
network policy. The source-label provenance in `docs/design/mars-cube-foundation.md`
also references `asc-pds-services.s3.us-west-2.amazonaws.com`, whose access may
need separate configuration. Do not claim those other downloads were tested here.

Use the bounded build and independent source-validation commands in
[mars-cube-foundation.md](design/mars-cube-foundation.md#reproduce-the-bounded-build)
as the reference for the real pilot. Reuse the unchanged #50 fused field where
available. If fusion must be generated, invoke `dem.py fuse` explicitly: the
legacy `fused.sh` also builds a large quantized-mesh pyramid and removes its old
output directory, so it is not a safe generic executor entry point.

Before promotion, require the real registration/native-valid-footprint gates,
toolchain pins and resource measurements listed above. Retain per-source Mars
imagery controls and verify native image refinement over independent coarse
geometry. Only after real-data/browser acceptance should #137's R2 publication
and deployment catalog pinning be considered; this draft supplies local fixture
publication only and has not uploaded production products.

## Checks

```sh
npx vitest run scripts/surface-build.test.mjs scripts/surface-plan.test.mjs \
  scripts/data-hosting/__tests__/data-hosting.test.mjs
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 scripts/terrain/test_cube_xyz.py
```

The Node planning checks run without GDAL. The end-to-end test detects GDAL and
explicitly skips when it is absent; with GDAL it builds twice in separate caches,
compares product revisions and every output byte hash, verifies immutable local
publication/republication, and rejects changed caches, source responses,
incomplete builds, failed HTTP verification and bad source registration.
