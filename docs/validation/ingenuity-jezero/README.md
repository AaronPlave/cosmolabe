# Ingenuity/Jezero #246 migration

**All #246 implementation and local acceptance remain in PR #292. Production
R2 upload and deployment require explicit authorization and have not occurred.**

The completed [V12 build](mission-build.json) passes the supported source,
datum, native-grid, coverage and fidelity gates. Its five immutable products
contain **5,103 data objects / 1,243,309,388 bytes**: authoritative terrain/CPU
lattice plus independent Viking, global CTX, Jezero CTX and HiRISE imagery.
The local mission catalog and unpublished dataset registrations match those
exact products. All 72 estimated flights, original horizontal observations,
landing sites, epochs, model, viewpoints and controls remain integrated.

[Mission hardware acceptance](mission-runtime.json) passes on Chrome / physical
Apple M4 Max Metal. It includes three sites / 75 operational pick rays,
measurements and Fly to, fifteen estimated flight phases with real inspector
readouts, visibility/opacity/order controls, eviction and independent optional
and mandatory-base outage recovery. Fifteen cold/refining corridor positions
along flights 1/12/72 plus a return visit use a 64 MiB geometry cache. Loading
samples retain conservative clearance; settled CPU/selected-GLB agreement is
required within 0.5 m. [MoonFall](moonfall-regression.json) also passes after the
shared renderer changes.

The repeated-crater screenshot was traced to **the original beta CTX service
responses**: different PNG hashes contained identical decoded pixels at different
geographic addresses. [The source audit](ctx-source-diagnostic.json) records four
duplicate groups across 36 responses. The replacement uses the officially
published V01 `OnMars/CTX1` service: all 3,607 acquired decodable textured responses
have distinct decoded pixels; two truncated original responses stay transparent.
This finite acquired inventory does not certify every unrequested remote tile.
A lock-controlled decoded identity gate now rejects such source repetition.
Compare the [old repetition](captures/superseded-ctx-beta-repetition.png) with the
[current native orbit](captures/mission-native-mars-orbit.png), plus
[nadir](captures/mission-ctx-nadir.png) and [tilted](captures/mission-ctx-tilted.png)
views. Twelve angle cases and four native mouse orbit steps pass. Conservative
patch visibility preserves valid nadir and tilted imagery. The independent
renderer and its revised residency policy are documented below. All **4,084 terrain payloads remain byte-identical**
to V11 ([comparison](terrain-rebuild-comparison.json)); flight estimates are unchanged.

An earlier every-rendered-frame audit caught a first-frame loading defect missed
by timed probes: a newly selected coarse GLB initially stood 286.975 m above the
CPU surface. The camera now clamps again after streaming selection, before view
transport and labels. The current frozen renderer run checks **1,303 rendered
frames across fifteen corridors**, with minimum clearance 49.1798 m and maximum
loading discrepancy 0.820151 m. All settle within the unchanged 0.5 m agreement
gate; transient agreement is not claimed to be sub-metre everywhere.

The [replacement architecture](../imagery-refinement-257/architecture.md)
removes `fitView()` resolution caps and independently clipped imagery meshes.
Persistent source/face trees select imagery independently of physical terrain.
A shared GPU texture array and integer page table select the committed source
pixels on original meshes. Parent fallback persists until a complete visible
refinement frontier is usable; faster neighbors cannot run several levels ahead.
No imagery geometry, material clones, extra draws, or physical LOD changes are
introduced. Decoded alpha, nodata, bounds, opacity and source order remain explicit.

The [loading regression](imagery-loading.json) checks **196 viewport points** in
two-layer/full-stack configurations and sixteen actual Surface Explorer mouse
movements. Foreground HiRISE stays level 14 in the viewport cases. The mission's
residency **target is 960 MiB**, with a four-page transition reservation and
protected displayed references. A live target reduction to 128 MiB deliberately
retains that existing detail and reports the overage; it is not a 128 MiB hard-cap
claim. A separate cold **48 MiB** run defers refinement, reports pressure, and
retains real coarse mandatory-base coverage without eviction cycling.
[Default stack](captures/mission-imagery-motion-960.png) and
[live reduced target](captures/mission-imagery-motion-128.png) are recorded.

[Before/after GPU evidence](../imagery-refinement-257/gpu-comparison.json) uses the
published PR renderer and the actual Ingenuity and MoonFall products. It includes
native camera movement, one-day-per-second playback, delayed/out-of-order requests,
transient failures, missing intermediate parents, rapid reversals, seams, GPU
allocation failure, and context restoration. The comparison reports the added CPU
and first-detail latency as well as removing all imagery geometry/draw overhead.
Hardware measurements and the deliberate coherence/latency tradeoff are disclosed.

Actual [Jezero overhead](captures/mission-jezero-overhead.png),
[distant Mars](captures/mission-distant-mars.png), and a
[pinned original CTX missing-response location](captures/mission-ctx-hole.png)
are recorded with alpha read from the exact bitmap used by the centre shader.
The distant view uses real V01 CTX global overviews. The pinned unavailable
V01 response at latitude -2.8125°, longitude 2.8125° remains transparent over
real Viking. No holes are replaced with invented native pixels.
The mandatory-base outage independently proves the static surface stays visible
when transparent optional imagery is resident.

[Navigation profiling](navigation-performance.json) covers stationary ground,
moving ground, flight follow and orbit-to-surface transitions on Mars and
MoonFall, 360 physical GPU frames each. The pre-optimization Mars navigation p99
was 7.3–7.6 ms. Final navigation p99, summed across both clamps per rendered
frame, is 1.1–1.5 ms on Mars and 0.6–1.1 ms on MoonFall, below the 4 ms budget.
Strict interior radial queries intersect the two original lattice triangles;
cell/tile/face edges retain the general closed-boundary ownership rule. Radial
coverage requests include all incident footprints without marching repeated
coordinates. Selected GLB intersections retain original triangle math and mesh
bounds. Full frame timings and occasional unrelated long frames are disclosed.
There is no stale scalar-height cache or change to physical geometry.

The independently phased 6 m CTX affine grid is explicitly retained in the
[lock](mission.lock.json); its finest-grid phase residual against the 1 m DTM is
0.250853 m. Its original-native-to-output registration proof remains required.
The coincident HiRISE 0.25 m / DTM 1 m gate remains strict. Neither source is moved
to manufacture coincidence. Native source/service intervals remain separate
from generated output spacing and unknown absolute accuracy remains unknown.

The completed receipt includes 19,772 entries. Its 32 MiB reader bound and
entry-wise canonical inventory comparison preserve ordinary 2 MiB JSON limits
and reject changed, missing or reordered entries. The clean V12 run and its
[read-only publication preflight](mission-publication-plan.json) verify the full
inventory. [Publication/candidate/rollback plan](publication-catalog-plan.json)
contains the six URL replacements and five post-verification dataset pins.
No production write, catalog pin or deployment has been made. Remote HTTP/CORS
verification and capture of the exact live rollback baseline occur only after
authorization, before the catalog switch.

Validation: 899 renderer-package tests (including 108 focused imagery/terrain
checks) and 89 catalog/Places tests, full TypeScript/Svelte checks,
changed-source lint and script syntax checks. The full-suite local run exposed an
unchanged GF reporting timing failure; sandbox socket failures passed in an
unsandboxed targeted rerun. Exact-head CI remains the delivery check.
The exact pushed-head CI is reported on PR #292. [Reproduction](reproduce-mission.md)
and [catalog preservation](catalog-contract.json) remain part of the evidence.
The [390 px inspector](captures/mission-compact.png) qualifies the estimates.
The [coarse](captures/mission-imagery-coarse.png) and
[fine](captures/mission-imagery-fine.png) paired captures retain identical CPU
hits, selected geometry and position/normal/index buffers.

Current scientific evidence:

- [Terrain registration comparison](terrain-registration.json): 4,634 original
  source samples, with no Ingenuity observations. HiRISE-minus-CTX mean -0.387 m,
  RMS 3.739 m; subtracting the old global-base plane gives mean +7.506 m,
  RMS 10.617 m. The published TRN control chain and this comparison support
  keeping authored HiRISE heights; no terrain adjustment is made to fit flights.
- [NASA final flight log](../../../apps/viewer/test-catalogs/data/ingenuity/official-flight-log.json)
  and [explicit reconstruction model/conflicts](../../../apps/viewer/test-catalogs/data/ingenuity/reconstruction.json).
  Original horizontal observations, landing locations, and mission event epochs
  remain unchanged. Interior times and radial AGL are estimates, not telemetry.
- [PDS frame evidence](mission-geometry-evidence.json) and
  [archived image geometry replay](pds-geometry-check.json): documented HELI_M to
  HELI_G to SITE(3) chain, orbital map standard parallel 18.4663 degrees,
  planetocentric latitude and positive-down Site Z. The sparse Flight 12 event
  gives 10.280 m clearance against the unchanged terrain. Its nominal SCLK/UTC
  difference is 276.143 s; do not infer a whole-mission clock correction.
- [Serialized flight validation](flight-validation.json): 72 flights, 73 landing
  sites, 266,200 knots/quarter-interval Hermite samples. Maximum horizontal landing
  change 0.000388 m; minimum estimated clearance -0.000000557 m (roundoff).
  This sampled representation check is not an absolute accuracy certification.
  Against linearly interpolated legacy files at matching epochs, maximum
  displacement is 12,060.271 m, combining the coordinate correction and
  explicitly estimated profile/timing changes. Every baseline file is hash-pinned.

The unchanged original worst-boundary fixture still reproduces 291.042 m.
The new product's independently selected static worst boundaries remain
280.094 m maximum / 182.272 m p95, with 48.496 m minimum rendered clearance at
nominal 50 m CPU clearance. Those far-field diagnostics are retained separately
from the runtime operational gate: all fifteen corridor samples settle within
0.5 m, and loading keeps the camera above both physical and selected surfaces.
No global edge-stitching or absolute terrain accuracy claim is made.

## Historical source preflight

The report below records the first source audit. Its trajectory hold and
prerequisite status describe that earlier checkpoint, before the PDS evidence,
explicit estimated-flight decision and current implementation above. Historical
numerical evidence is retained rather than silently overwritten.

### Sources and access

[Source inventory](source-inventory.json) pins the original input bytes and GDAL
grids. [Access receipts](source-access.json) and [original labels/configuration](evidence/)
record current upstream evidence. Committed bindings are repository-relative; source
snapshots are public NASA/USGS responses. Full machine-specific receipts remain
in the ignored local build directory.

| Input | Local original or acquisition | SHA-256 |
| --- | --- | --- |
| USGS MOLA/HRSC 200 m v2 | `scripts/build-mars-terrain/data/source/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif` (11,384,463,908 bytes) | `e8bfe4c3b9dee9d5fdb8c4d49798869654e552e7b154712c9e12d6d117464419` |
| Jezero TRN soc_006 DeltaGeoid/blend40 DTM, 1 m | Same source directory; original projected TIFF (1,839,545,409 bytes) | `44c3819caa33922b06f7a8228534d1e32ab4087aca85144136d825c371c747d8` |
| MEG016 label/image | `../cosmolabe-dupe-1/work/surface-build/mola-meg016/MEGA90N000EB.{LBL,IMG}` | Label `83b4df3255dade92ab64c7261a3ce54728675e0f1e9c023b56e5facae9ec41ef`; image `e80333b01489e66ebf20ac83ec7e130bd5a03f0c3f98f8f7b8d5c054cd6ad239` |
| Full original Jezero HiRISE 25 cm orthomosaic | Acquired as `work/ingenuity-246/upstream/hirise-ortho.tif` (7,358,523,457 bytes) | `83f3faeabc87ba54db9af278611bd070494a0b0d43757108c871c763943e80d9` |
| Full original Jezero CTX 6 m orthomosaic | Acquired as `work/ingenuity-246/upstream/jezero-ctx.tif` (36,269,402 bytes) | `842b457afee7c2672022b66e3f60be836c6d52e99474015bfd9ced60099b8615` |
| Original MMGIS waypoint/path observations | NASA responses byte-identical to both vendored JSON files | Waypoints `457b536b6851259d2dfd1ee75c076ca95f4ad7f5f1cbd49c880564c3cf5d787b`; paths `f0b19df6290a4d26c6618188d8986774b01c509e3d98841e410e8168f868240a` |

The full original orthomosaics were absent from the searched `~/code/cosmolabe*`
checkouts; only the earlier 512 m crop was found. Both full originals were acquired
from the official USGS S3 endpoint, without reprojection or resampling. Their
filenames/URLs and HTTP identities are in the receipts. The HiRISE source has
the same upper-left map origin as the DTM and exactly four image pixels per DTM
pixel. This establishes grid preservation, not independent absolute registration.
Both orthomosaics have zero-valued nodata. A raster envelope is not a native-valid
coverage mask. No mission-wide imagery coverage claim is made from acquisition.

The first sandbox DNS failures were retried with permitted networking. NASA/USGS
access then succeeded. The guessed `M20/config.json` URL returned 403; the public
MMGIS client identifies the actual configuration API at
[`maps/api/configure/get?mission=M20`](https://mars.nasa.gov/maps/api/configure/get?mission=M20),
which was retrieved successfully and is retained verbatim.

**Global CTX access fails a required original-response check.**
[`MapServer/tile/6/23/96`](https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/6/23/96)
returns HTTP 200 and 92,426 bytes, but an IDAT chunk declares 8,192 bytes with
only 2,123 remaining. The zlib stream is truncated; GDAL and Sharp both reject
the pixels. Acquisition failed after five attempts, and a separate curl download
confirmed the truncated object. [Exact artifact receipt](ctx-source-failure.json)
and [headers](evidence/ctx-failure.headers) retain its identity. Parent resampling
was disabled for this acquisition, so a completed native response bundle was not
manufactured. Other missing CTX responses were observed but not independently
diagnosed; this is not a complete list of upstream gaps.

Viking acquisition used the original NASA Trek catalog source and the existing
`/tmp/cosmolabe-mars-source-images` response cache. It was interrupted after the
CTX failure; its partial output has no accepted manifest. This is not evidence
that the Viking service is unavailable. Four-source imagery acceptance remains
open, including useful overview coverage, exact fallback provenance, valid
footprints, controls and native fidelity.

### Datum and trajectory audit

[Full numerical report, including all 73 controls and all 72 flights](scientific-audit.json).

- Source DTM/ortho labels explicitly use planetocentric latitude, positive-east
  longitude, and a spherical 3,396,190 m equirectangular map. The original MMGIS
  configuration also declares equal 3,396,190 m radii. Its 73 projected control
  coordinates reproduce spherical EQC with inferred standard parallel
  18.466299998 degrees: maximum easting/northing residuals 0.000333/0.000291 m.
  The fitted standard parallel is numerical corroboration, not missing official
  CRS or SF3-transform documentation.
- Independently decode the official MEG016 big-endian grid, use its exact
  1/16-degree pixel-centre registration, interpolate with wrapped longitude, add
  the unchanged areoid scalar height, then form a radial Cartesian point.
  MEG016's model/version assumptions and absolute source uncertainty remain
  explicit. The areoid radius differs from the ellipsoid's radius on the source
  ray by about 335.33 m on average across these sites; a constant offset is not
  substituted for the grid.
- The current builder instead treats source latitude as geodetic and areoid
  height as ellipsoid height. Its physical planetocentric latitude is about
  0.2021–0.2027 degrees south of the source angle. The alternative radial
  reconstruction differs by mean 11,972.00 m, maximum 12,006.65 m over **60,602
  samples**. These are differences between coordinate interpretations, not an
  independent certification of true spacecraft-position error.
- Reconstruction of the current `.xyzv` positions agrees with the stored files
  to better than 0.000857 m. No flight labels, source timing, observations,
  sampled paths or flight files were rewritten. Time-based matching retains
  the original Flight 12/13 path-label swap.
- The 2D paths contain no observed altitude/time series. Keeping the current
  synthesized altitude and uniformly assigned sample times under the radial
  alternative produces minimum radial field clearance **−2.973 m**. Flights
  39, 47 and 67 have samples below −1 m. This is a reconstruction/model issue,
  not demonstrated helicopter penetration or independent DEM error. No terrain
  snapping or altitude offset was applied.

**Trajectory gate: hold regeneration.** The spherical source-map interpretation
is supported and the existing builder's universal geodetic claims are contradicted
by the original evidence. However, MMGIS does not supply an explicit geoid model
version, independently established SF3-to-IAU_MARS transform, altitude time series
or clock-to-ET definition. Preserve observations/timing and record the conditional
reconstruction before choosing a migration model. Unknown absolute accuracy must
remain unknown; scalar agreement must not be presented as its certification.

### Clean fusion and actual mission-region cube build

The shared `dem.py fuse` was run from the two original DEMs, with a 1 km taper,
fit stride 8 and **`--bias none`**. It did not consume the old residual. All four
new raster outputs (`residual`, `weight`, `coverage`, `fused`) are byte-identical
to the historical #50 rasters: all 459,843,200 cells per raster were compared.
The fitted offset is −8.645969777 m; slopes are +1.012174 m/km east and
−0.685260 m/km north. The plane remains present. Scalar agreement at the 73
MMGIS sites is RMS 0.004180 m, maximum 0.018162 m; this is shared-provenance
consistency, not independent positioning accuracy.

Fresh global overviews were also generated from the original base TIFF. The
new fusion's volatile timestamp and source paths were normalized before pinning
its complete raster dependency bundle. No historical fused artifact is an
execution binding. The #251 content-addressed executor built the terrain from
that bundle and the pinned official datum assets:

| Measurement | Result |
| --- | --- |
| Build ID | `b331f1728569c447b613df60abf54997374a5624749565730d5d5df9715f6840` |
| Terrain product | `terrain-4c5bc4ed7ef62452bb979d09` |
| Geometry/CPU coverage | 2,042 tiles, global L2 through mission L15; every original path sample inside an L15 cap |
| Maximum face-centre vertex interval | 3.2389 m at L15; source DTM native interval remains 1 m |
| CPU/control checks | 73/73 pass the predeclared 1 m representation gate; maximum 0.061733 m |
| Output size | 364,965,554 bytes, 4,089 objects; **published bytes null** |
| Existing numerical/structural gates | pass; zero invalid used baseline kernels; 96/96 generated worst-boundary rays hit |
| CPU vs emitted float32 triangles, ordinary rays | maximum 0.022 m (sampled representation comparison) |

See [build report](terrain-build.json), [lock](terrain.lock.json), and
[full cube validation including boundary rows](cube-validation.json).
The real profile now permits up to 128 controls so the 73-site mission audit is
not truncated to the pilot's 64-control ceiling; the synthetic profile keeps its
64-control ceiling and the 2,048-tile bound is unchanged.

**Historical static geometry/LOD diagnostic (retained, not an operational acceptance).** Generated worst-boundary samples
have maximum CPU/rendered difference **280.094 m**, p95 **182.272 m** and minimum
rendered clearance **48.496 m** for nominal 50 m CPU clearance. The old foundation
had 291.042 m / 30.797 m / 30.239 m respectively. These are different products
and independently selected worst boundaries, not a paired improvement claim;
p95 is worse. Twenty-seven new rendered hits are on skirts and 12 rays would
pass through cracks without them. Finer mission spacing alone does not solve
mixed-level transitions or cold/coarse residency. The original pinned boundary
fixture is unchanged, and has not been rebound to the new product.

The executor's `passed-supported-gates` result does **not** gate these CPU/rendered
deviations against a mission-operation tolerance. Source accuracy, representation
error, skirt hits, and current visual residency remain separate. At that checkpoint a reusable renderer/loading fix and operational acceptance
were still required. The current mission runtime report above now records those
checks on the completed five-product build. These static worst-boundary values
remain separate from that local runtime acceptance.

### Reproduce without publication

Use `python3` with GDAL/NumPy (recorded: Python 3.14.5, GDAL 3.13.0, NumPy 2.4.6)
and build the repository packages. All output directories below must be new.
Resolve `SOURCE_DIR` and `AREOID_DIR` to the original inputs in the inventory.

```sh
npm run build
SOURCE_DIR="$PWD/scripts/build-mars-terrain/data/source"
AREOID_DIR="$(cd ../cosmolabe-dupe-1/work/surface-build/mola-meg016 && pwd)"
RUN="$PWD/work/ingenuity-246/reproduction"
mkdir -p "$RUN/upstream" "$RUN/original-dem-inputs"
mkdir -p "$RUN/legacy"
git archive 70899b98e7bfe218c81e0c73ef7494924ebf9152 apps/viewer/test-catalogs/data/ingenuity | tar -x -C "$RUN/legacy"
curl -fL 'https://mars.nasa.gov/maps/api/configure/get?mission=M20' -o "$RUN/upstream/mmgis-config.json"
python3 scripts/terrain/dem.py fuse \
  --base "$SOURCE_DIR/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif" \
  --detail "$SOURCE_DIR/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif" \
  --out "$RUN/clean-fusion" --blend-m 1000 --fit-stride 8 --bias none \
  --vertical-datum 'MOLA areoid topography; planetocentric coordinates; radial height above areoid'
PYTHONDONTWRITEBYTECODE=1 python3 scripts/terrain/audit_ingenuity.py \
  --source "$SOURCE_DIR" --fusion "$RUN/clean-fusion" \
  --old-fusion scripts/build-mars-terrain/data/fused \
  --flights "$RUN/legacy/apps/viewer/test-catalogs/data/ingenuity" \
  --areoid "$AREOID_DIR/MEGA90N000EB.LBL" \
  --mmgis-config "$RUN/upstream/mmgis-config.json" --out "$RUN/scientific-audit.json"
```

Only the audit comparison reads `--old-fusion`; the new build uses exclusively
the newly generated outputs. To reproduce the executor's overview dependency,
copy or filesystem-clone the original base TIFF into `original-dem-inputs`, link
the original detail TIFF there, and generate the external overview sidecar:

```sh
cp "$SOURCE_DIR/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif" "$RUN/original-dem-inputs/"
ln -s "$SOURCE_DIR/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif" "$RUN/original-dem-inputs/"
gdaladdo -ro -r average "$RUN/original-dem-inputs/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif" 2 4 8 16 32 64 128 256
node scripts/surface-build/ingenuity.mjs "$RUN/original-dem-inputs" "$RUN/clean-fusion" \
  "$AREOID_DIR" "$RUN/scientific-audit.json" "$RUN/inputs"
node scripts/build-surface.mjs "$RUN/inputs/lock.json" \
  --bindings "$RUN/inputs/bindings.json" --cache "$RUN/cache" \
  --python /opt/homebrew/bin/python3 --workers 4 --execute > "$RUN/execution.json"
```

Use the corresponding Python path on other hosts. Toolchain or builder changes
produce a new identity; do not force an old build ID onto different bytes.
The public MMGIS configuration is mutable; its exact acquired snapshot is pinned
in the scientific report and retained under `evidence/`. Original observation
hashes are checked before terrain lock preparation. Complete product caches
remain byte-verified by the shared executor.

Full original imagery acquisition commands (keep the labels and HTTP receipts):

```sh
USGS_ROOT='https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn'
curl -fL "$USGS_ROOT/HiRISE/JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif" -o "$RUN/upstream/hirise-ortho.tif"
curl -fL "$USGS_ROOT/CTX/JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif" -o "$RUN/upstream/jezero-ctx.tif"
```

### Publication, rollback, and remaining acceptance

The read-only publication preflight rehashes the completed local terrain and
produces its exact immutable candidate prefix/inventory hash in the
[publication plan summary](terrain-publication-plan.json). The full plan, including
all object entries, is retained at `work/ingenuity-246/terrain-publication-plan.json`;
the summary's `fullPlanIdentity` belongs to that full plan. **This is not an upload authorization or a complete
mission publication plan.** The four imagery products and trajectory/LOD gates
must first be resolved. No production R2 identity exists for this migration yet.
Do not pin the terrain-only candidate into the deployed Ingenuity catalog.

After acceptance and explicit authorization, use #251/#137's existing
publication receipt and HTTP verification, then prepare an offline catalog
candidate with exact before/after pins and rollback. Retain the current catalog,
flight files and `datasets.json` as the rollback baseline. They are unchanged
here, so there is currently no deployed change to undo. Follow
[the existing publication/rollback procedure](../../surface-build-acceptance.md).

Validation performed: package build; all ten executor regressions (seven planning
and three GDAL rebuild/local-publication cases, with permitted localhost access); six
independent-audit regressions; six XYZ adapter regressions; real clean fusion;
content-addressed mission-region terrain execution with all 73 controls; emitted
triangle/boundary numerical validation; exact CTX response inspection. No browser,
GPU, cloud CI, hosted cold-load/outage/recovery, imagery-control or MoonFall
acceptance is claimed by this report. The geometric boundary fixture and the
existing unrelated catalog behavior are unchanged, but remain to be exercised
with any subsequent runtime fix.

Remaining #246 acceptance: complete four-source imagery locks and valid coverage;
scientifically justified trajectory-model decision; reusable bounded LOD/loading
safety; quantitative actual-mission browser tests, including all flight states
and MoonFall; complete immutable publication/pins/rollback; and explicit production
upload/deployment authorization. Keep #246 open and this prerequisite PR draft.
