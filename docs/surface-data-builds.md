# Finite surface build execution — issue #251

This is the finite CLI executor for #251. [Acceptance matrix and explicit publication/pin/rollback procedure](surface-build-acceptance.md). It consumes #248's validated
lock, emits a build DAG, runs the existing residual fusion and cube builders,
validates controlled fixtures and a bounded real Jezero pilot, and exercises #137's immutable publisher and
HTTP verifier against local storage. It does not authorize a production upload or mission migration. No production catalog is changed.

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
- `parameters.imagery`: 0–4 independently built source IDs with their own global
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

Every source needs SHA-256 and exact asset bytes, coordinates and datum compatible
with its selected operation, declared coverage and native fidelity. Version strings alone are not
content pins. Supplied reuse restrictions or unknown permissions fail. Missing
discovery/illumination evidence is retained as unknown, never invented; this
fixture profile cannot be promoted to production.

The fixture profile limits regional levels to L4 and global overviews to L3,
so even an accidentally global regional cap cannot enumerate an unbounded bake.
It supports spherical, planetocentric, east-positive Mars,
geographic north-up single-band DEM GeoTIFFs and the existing EPSG:4326 XYZ cube
adapter. The explicit `bounded-real-mars` profile also supports the existing
zero-origin spherical equirectangular DEMs, evidenced valid subsets of masked
rasters, a pinned existing fusion, and native byte grayscale raster imagery.
Regional levels may reach L17, while every product is capped at 2,048 candidate
tiles before raster decoding. It never raises the fixture profile's L4 limit. No arbitrary
GDAL commands, shell fragments, custom transform strings, browser processing,
discovery crawler or persistent build service are accepted.

Imagery assets are finite `locked-xyz-bundle` JSON documents (version 1): a shared
XYZ `config` and a `tiles` object mapping `z/x/y` to `{path, sha256}`. Each original
response is separately hashed. The adapter reads only these pinned responses;
missing required tiles, changed bytes, wrong dimensions and corrupt images fail
without falling through to HTTP or mutable URL caches. The existing live XYZ
adapter behavior remains available to its existing callers. Locked XYZ bundles still require opaque responses. Masked raster sources require
independently evidenced `metadata.validData` geometry; unknown nodata remains
rejected. The worker verifies all touched native cells plus a two-cell
interpolation halo rather than treating an envelope as a valid-data footprint.

The worker copies inputs to staging and verifies their hashes before use. It
checks actual raster masks/nodata, dimensions, reference sphere and pixel
registration before fusion. Local paths and timing are excluded from product
content identities; generated imagery and terrain metadata are normalized so a
clean rebuild produces the same product bytes. Matching products in byte-verified completed builds are reused using filesystem clones where supported (safe copies otherwise), then numerical gates run again. Product IDs and published prefixes follow only their transitive source/transform/ROI inputs, so a regional image change preserves shared context and terrain products. Local scratch accounting still includes logical copied/cloned bytes. Source/lock, taper, output choices
or implementation changes produce a new build identity. Implementation hashes
include the shared builders, addressing/CPU primitives and dependency lock.
The rebuild regressions use the same GDAL/Python environment for both the
identity and controlled MEG016-layout ellipsoid fixtures. The latter also
rejects a correctly hashed label that points to an unpinned image. CPU versus
rendered ray comparisons use the existing per-tile float32 rounding bound at
shared edges; the separate skirt/boundary-ray intersection checks retain their
previous tolerance. The real profile requires exact Python, GDAL and NumPy versions in
`parameters.toolchain`; a mismatch fails before staging. The Node dependency
lock and implementation hashes remain separate build inputs. Unknown absolute
source accuracy is not converted into a toolchain or mesh-error guarantee.

## Reports and publication boundary

Report v2 includes standalone planner-feedback v1; [the acceptance matrix](surface-build-acceptance.md) documents its schema, explicit R2 preflight/publication and offline catalog pin/rollback commands. Generated bytes are `outputBytes`, while `publishedBytes` remains null before a verified publication receipt. Source declarations, confirmed native masks, emitted addresses and any continuous requested-ROI proof are separate fields.

`report.json` preserves requested and selected fidelity, native source GSD and
accuracy, actual output spacing by level, exact emitted tile availability, alpha
counts, source/fallback/illumination provenance, output bytes and object counts,
elapsed time and individual process memory high-water marks. Source response
bytes are separate from the bundle manifest bytes. Output counts include product
metadata. A worker sampler records concurrent descendant RSS and logical scratch-file
bytes at one-second intervals. Its maximum RSS may count shared pages repeatedly;
physical peak RAM remains `null`. Peaks are sampled measurements, not certified
bounds. Planner raster estimates remain uncalibrated scenarios. Primary bound
file bytes and nested bundle dependencies are separate inventories; the latter
are verified during binding inspection and included in scratch measurements.

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

Reports always say `productionReady: false`. The real local pilot, native-valid
subset, source-to-output image checks, toolchain pins, resource sampling and
physical-GPU viewer checks are now implemented. Production promotion still needs
a reviewed publication/deployment choice and acceptance for mission consumers.
Source absolute geolocation/accuracy and mosaic illumination remain unknown;
none is fabricated to turn an uncertainty into a passed gate. Existing #246
navigation/clearance migration concerns remain distinct from build completion.

## Handoff: resume the real Mars pilot

Keep #251 open. The shared lock and executor now support the explicit conversion
below. Existing identity locks remain valid. ROI/source longitude and latitude
stay planetocentric on the 3396.19 km map sphere; `outputDatum` declares the
physical ellipsoid and normal-height CPU query contract independently. Imagery
remains on its independent planetocentric cube directions.

Each elevation selection uses one identical object in `transformations`:

```json
{
  "kind": "areoid-radial",
  "areoid": {
    "label": {
      "url": "https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg016/mega90n000eb.lbl",
      "bytes": 3760,
      "checksum": {"algorithm": "sha256", "value": "83b4df3255dade92ab64c7261a3ce54728675e0f1e9c023b56e5facae9ec41ef"}
    },
    "image": {
      "url": "https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg016/mega90n000eb.img",
      "bytes": 33177600,
      "checksum": {"algorithm": "sha256", "value": "e80333b01489e66ebf20ac83ec7e130bd5a03f0c3f98f8f7b8d5c054cd6ad239"}
    }
  },
  "outputDatum": {
    "referenceShape": {"kind": "ellipsoid", "radiiKm": [3396.19, 3396.19, 3376.2]},
    "verticalDatum": "ellipsoid",
    "heightConvention": "geodetic-normal"
  }
}
```

Both selected elevation sources must declare `verticalDatum: "areoid"` and
`heightConvention: "radial"`. These are source heights above the areoid, not
already converted ellipsoid heights. Bind the two datum files with reserved
IDs `datum:areoid-label` and `datum:areoid-image`. The dry run hashes each one;
missing or changed bytes prevent execution and cache reuse. Both are explicit
DAG dependencies and contribute to raw download bytes and build identity.

The worker stages them together as `MEGA90N000EB.LBL` and `MEGA90N000EB.IMG`,
checks the detached image reference and GDAL dependency list, and dispatches
`dem.py cube-tile --source-convention areoid-radial --areoid ...` with the
IAU Mars radii. The existing builder checks the 5760×2880 MEG016 grid,
planetocentric coordinates, 16 pixels/degree and 3,396,000 m offset.
The fitted residual is preserved with `--bias none`.

On 2026-10-22 the official downloads succeeded in the local environment. The
previous environment's proxy failure is no longer the blocker here:

```sh
mkdir -p work/surface-build/mola-meg016
curl -fL https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg016/mega90n000eb.lbl -o work/surface-build/mola-meg016/MEGA90N000EB.LBL
curl -fL https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg016/mega90n000eb.img -o work/surface-build/mola-meg016/MEGA90N000EB.IMG
```

The existing real sources and unchanged #50 fusion are available locally at
`/Users/aplave/code/cosmolabe/scripts/build-mars-terrain/data/{source,fused}`.
The lock executor now builds this real input pair with the source projection,
mask, unchanged residual and independent native imagery preserved. See
[the evidence and limits](benchmarks/surface-build-real-mars.json) and
[physical-GPU captures](validation/surface-build-real-mars/README.md).

Use a fresh acquisition directory; the acquisition command will not overwrite
an existing crop. It retrieves both official source labels and a 2048×2048
native-pixel window from the range-enabled 7.36 GB ortho, without resampling.
The crop checksum, native grid/window, source HTTP identity and label hashes
are retained. Two independent acquisitions produced identical crop bytes.

```sh
PY=/opt/homebrew/bin/python3  # choose the Python with GDAL/NumPy on this host
$PY scripts/surface-build/acquire_mars_ortho.py --out work/surface-build/real-pilot-inputs
$PY -c 'import sys,json,numpy; from osgeo import gdal; print(json.dumps({"python":sys.version.split()[0],"gdal":gdal.VersionInfo("RELEASE_NAME"),"numpy":numpy.__version__}))' > work/surface-build/real-pilot-inputs/toolchain.json
```

First run the existing bounded terrain/source-validation commands in
[mars-cube-foundation.md](design/mars-cube-foundation.md#reproduce-the-bounded-build),
writing the independent source report to
`work/surface-build/real-mars-source-validation.json`. The preparation command
uses its source control and converts its Cartesian point to public geodetic
normal height; it does not reuse a rendered/CPU height as ground truth.

```sh
node scripts/surface-build/real-pilot.mjs \
  /Users/aplave/code/cosmolabe/scripts/build-mars-terrain \
  work/surface-build/real-pilot-inputs work/surface-build/mola-meg016 \
  work/surface-build/real-pilot-inputs/toolchain.json
node scripts/build-surface.mjs work/surface-build/real-pilot-inputs/lock.json \
  --bindings work/surface-build/real-pilot-inputs/bindings.json \
  --cache work/surface-build/real-executor-cache --python "$PY" --workers 4 --execute \
  > work/surface-build/real-pilot-report.json
```

The real profile pins `terrain.fusionAsset` (a `locked-fusion-bundle` JSON with
base/detail hashes and all five existing fusion files) and, when present,
`terrain.baseOverviewAsset`. Reserved bindings are `terrain:fusion` and
`terrain:base-overview`. The worker verifies and stages every dependency,
requires the original `removed: false`, taper and fit stride, and keeps the
original fusion metadata bytes. It does not refit or normalize the real field.
Staged overview bytes are pinned because they influence coarse geometry.
The global baseline contains native edge nodata. The native-valid subset proof
and every emitted lattice/normal probe are checked separately: all actual
Catmull-Rom support cells must be valid at the builder's selected pinned pyramid
level. Invalid used kernels fail completion. Native voids are retained and
reported; valid coarse overview samples never establish native-resolution
coverage outside the declared pilot.
The exact real lock is checked in as
[jezero-build.lock.json](examples/surface-plans/jezero-build.lock.json).

The pilot builds a coarser context product and an optional native-detail product
from the same observed crop. They share upstream product identity and retain
independent output settings; the mandatory viewer base remains visible while
the optional native layer can be hidden, faded and restored.

Native raster imagery uses `projection: "Mars-EQC-0-0"` and the shared raster
window sampler, with source masks and independent layer controls. The worker
checks DTM/ortho grid ratio and phase, every declared native-valid cell/kernel
halo, and independent affine inversion at emitted pixel centres and gutters.
A conservative trigonometric interval enclosure proves the complete requested
ROI has finest-level image tiles. This bounded proof requires a single-face ROI;
a region crossing cube faces is rejected explicitly. Native variation is
measured so a constant-color image cannot pass detail acceptance. Native
acquisition fidelity and the actual raster interval both constrain a strict
request; the worker checks the declared interval against the raster header. Absolute
geolocation is still unknown, even when preservation of source registration
passes. No imaginary illumination or datum correction is applied to imagery.

GDAL mask bands and nodata both contribute to emitted alpha. External `.msk`
dependencies are rejected before staging; use a pinned TIFF with an internal
mask. The executor derives deterministic power-of-two area-average overviews
of **premultiplied native DN and validity coverage**, then reconstructs each
cube texel with 4×4 footprint samples. Averaging both channels preserves masked
fallback without bleeding invalid DN into valid pixels. Each imagery manifest
records the derived pyramid hash, GDAL version, overview factors and filter.
An independent native-raster reference checks filtered DN and alpha; checkerboard
regressions compare coarse output against dense native sampling and adjacent LODs.

Standalone product manifests carry their transitive product identity (the complete build receipt separately pins the lock identity), upstream product IDs,
source asset hashes, attribution/licenses, native GSD, accuracy, coordinate
conventions, valid-data evidence and caveats. These records travel with immutable
local publication; the separate build report is not needed to identify a product.

For browser acceptance, start the isolated viewer and use the completed report:

```sh
node scripts/surface-build/serve-pilot.mjs
CL_VIEWER_URL=http://127.0.0.1:5187/ node scripts/test-surface-build-pilot.mjs \
  work/surface-build/real-pilot-report.json work/surface-build/real-pilot-browser
```

Open `http://127.0.0.1:5187/?catalog=test-catalogs/experiments/mars-surface-build-pilot`
for ordinary browser inspection. The server reads `work/surface-build/real-pilot-report.json`
(or a report path passed as its first argument), serves the completed products,
and opens the native patch 50 m above the shared source control. Both HiRISE
layers are available in the imagery controls. File watching is disabled for this
static artifact inspection server; restart it after source edits.

The browser script supports both local file routing and hosted HTTP URLs without interception (`SURFACE_HOSTED=1`); it never edits
a production catalog. It records GPU identity, near/far/refinement, CPU picks,
layer opacity/visibility and restoration. The local publisher can publish these
completed products through the same `--publish-local` path as fixtures; remote
R2 upload and deployment catalog pinning remain an explicit separate action.

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

The real registration/native-valid-footprint, toolchain/resource and desktop GPU
checks above are now exercised. Retain their limits when reviewing #137 remote
publication or mission catalog pinning; no production products were uploaded.

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

Follow-up validation on 2026-10-22: package build, test typecheck and changed
core-file ESLint passed; 108 focused Vitest tests passed across the core planner,
executor, plan/discovery CLIs and data hosting. Both GDAL end-to-end cases ran
without skips. Six XYZ Python regressions passed. The real 78-tile build passed
source-conversion and numerical terrain checks; its evidence is separate from
the controlled lock-executor regressions. Full repository checks run in CI.

The complete follow-up passed 109 focused Vitest tests, including three GDAL
end-to-end cases without skips and two clean projected/masked rebuilds with
identical product bytes. Package build, test typecheck, changed core ESLint,
six XYZ regressions, imagery selftest and the baseline-kernel nodata regression
passed. The real build checked 1,647,750 vertex/normal sample positions,
9,224 native image pixels including 640 gutter pixels, and continuous requested
coverage. Cache reuse plus local publication/republication of all three products
passed HTTP verification. The physical M4 Max viewer changed native L16 to
context L13 when hidden and restored L16 without changing terrain mesh IDs.
