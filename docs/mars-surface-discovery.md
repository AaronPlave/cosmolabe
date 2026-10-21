# Mars source discovery (#249)

The renderer-free `recommendSurfaceSources` query consumes a desired #248 plan
and up to 32 evidenced upstream source records. It returns **1–3 exploratory
imagery + terrain combinations per region**, channel candidates/fallbacks,
coverage polygons, costs, quality tradeoffs, and diagnostics. It never creates
a build lock, downloads rasters, reprojects, fuses images, or generates stereo.
No archive service runs in the viewer. All normal operations are offline.

## Run the two acceptance cases

```bash
npm run build
node scripts/build-mars-discovery-inventories.mjs
npm run --silent discover:surface -- \
  docs/examples/surface-plans/jezero.plan.json \
  --inventory docs/examples/surface-plans/mars-jezero.inventory.json \
  --out /tmp/jezero-discovery.json \
  --sources-out /tmp/jezero-recommended-sources.json \
  --inventory-out /tmp/jezero-full-inventory.json
npm run --silent plan:surface -- \
  docs/examples/surface-plans/jezero.plan.json \
  --sources /tmp/jezero-recommended-sources.json
```

Repeat with `gale` replacing `jezero`. The plans contain **synthetic regions**,
not mission landing/operations geometry. Use `--policy consistent`,
`finest-imagery`, or `physical-accuracy`. The first favors controlled products,
the second source image sampling, the third documented terrain accuracy.
Known insufficiency, coverage, registration, reuse restrictions, and cost
also affect ranking. Unknown accuracy remains unknown at every pixel size.

`--sources-out` exports only the **top combination per region**, de-duplicated,
with source identity, metadata/evidence and uncertainty preserved. The report's
`estimatorHandoff` identifies each recommended combination. This is an explicit
candidate handoff for cost estimation, not an approved or locked selection.
`--inventory-out` separately exports the full normalized records, including
unselected alternatives. It is never implicitly fed to the estimator.

The combination download range concerns its selected raster assets. Missing
sizes leave the upper bound unknown; shared URL/version assets count once.
`requestedBaseGridBytes` is a transparent work proxy: ROI area / requested GSD²,
times 3 imagery or 4 terrain bytes/sample. It excludes pyramids, gutters,
compression, reprojection, input decode/scratch, and overlapping-region reuse;
use #248 for those output scenarios. The estimator may leave its download
upper bound unknown even for sized candidates when additional coverage is
unresolved. These are planning estimates, not achieved output or timings.

## Independently verifiable inventory

Both seven-product inventories are rebuilt **without network access** from
checked-in [primary captures](examples/surface-plans/evidence/manifest.json).
The manifest records response times, metadata URLs and SHA-256 hashes. Raw
ODE JSON includes original `LabelURL`, assets, archive/index footprint WKT,
illumination/time fields, and original labels where ODE supplied them. MOLA's
original PDS4 XML and both detached HiRISE ortho labels are also cached. The generator never invents IDs or
copies a DTM's geometry into its orthoimage.

| Source | Jezero example | Gale example | Evidence/limits |
| --- | --- | --- | --- |
| Viking global MDIM baseline tiles | `mg15n277.img` | `mg00n217.img` | Real regional tiles from the global baseline, original labels/footprints; raster scale differs from observation-native resolution and illumination |
| MOLA MEG128 topography | `megt44n000hb` | `megt00n090hb` | Individual PDS4 products, label extents, 463.0576672 m grid interval, radial heights above GMM3 areoid; empty shot bins interpolated |
| CTX | `P02_001820_1984_XI_18N282W` | `T01_000815_1749_XN_05S222W` | Original EDR assets/labels, ODE index polygons and acquisition sampling; unprojected images require camera-model work |
| HRSC terrain | `H0988_0000_DT4.IMG` | `H4235_0001_DT4.IMG` | Archived original labels, irregular footprints, 75/50 m grids, sinusoidal, 3396 km spheroid heights, `MEX:DTM_MISSING_DN=-32768` |
| HiRISE image | `ESP_023524_1985_RED` | `ESP_016520_1750_RED` | Released RDR image, separate archive footprint, 0.25 m source raster grid, acquisition/illumination; sampling is not measured accuracy |
| Released HiRISE DTM | `DTEEC_023524_1985_023379_1985_U01` | `DTEEC_016520_1750_016375_1750_A01` | Separate released DTM records, real footprint polygons, original attached labels, Mars 2000 equipotential heights, missing constant and file sizes; physical accuracy/target transform unresolved |
| Matching orthoimage | `ESP_023524_1985_RED_C_01_ORTHO` | `ESP_016520_1750_RED_C_01_ORTHO` | Original detached labels independently establish source DTM, envelope, ~1.01 m grid, data type, I/F scaling and null/saturation values; envelope is not valid pixels |

MOLA labels describe gridding, interpolation and shot gaps up to 12 km. They
are not a mask audit. HRSC labels explicitly identify missing DN. ODE footprint
polygons and image bounding rectangles establish product extent, **not valid
raster pixels**. Accordingly these real fixtures report **no verified valid
pixel coverage**, rather than claiming full coverage from archive overlap.
Native/source raster sampling, underlying observation detail, requested output
GSD, and physical height/registration accuracy remain distinct.

The final metadata-only acceptance refresh on 2026-10-21 recovered original
CTX and HiRISE image/DTM labels through ODE, plus both matching ortho labels
directly from the archive. The manifest records the successful URLs, timestamps
and hashes. Earlier DTM requests returned `not found`; those failures no longer
limit the curated metadata. Ortho envelopes and grid intervals come from their
own labels, independently of the DTM polygons. No raster was fetched.

The labels add material quality evidence: Gale CTX reports
`DATA_QUALITY_DESC=ERROR` (Jezero reports `OK`), HiRISE images/orthos identify
`CORE_NULL=0` and saturation values, and both DTMs specify
`MISSING_CONSTANT=16#FF7FFFFB#` and elevations above the Mars 2000 equipotential
surface (Smith et al. 2001). These are diagnostics and source conventions,
not verified masks, measured physical accuracy or completed target transforms.
Fixed-record CTX/Viking/HRSC/DTM download sizes use original label record counts;
JP2 download sizes retain approximate ODE sizes, not uncompressed label storage.
MOLA primary assets are the `.IMG` rasters (ODE estimate **126,720,000 bytes**
each); their same-stem 2 KB ENVI headers and labels remain ancillary. ODE KBytes
is an approximate size source, not an exact byte count or guaranteed upper bound.

## Shared provenance and coverage contract

`SurfaceSourceDescriptor.metadata` is the upstream metadata seam shared with
#248/#250/#251 and #136. It includes label/evidence URLs, confidence/unknowns,
source raster grid interval, bands/type, acquisition/observation, original
projection/coordinate/datum descriptions, registration evidence, illumination
and photometry, related **released** stereo products, assets/size evidence and
reuse terms. Optional XYZ/WMTS metadata describes grid/projection/coordinates,
ellipsoid assumptions, template, tile dimensions, origin/order, zoom limits,
nodata, native-resolution claims, immutable identity and CORS/access/usage.
Unknown provider properties are null. No published-cube availability is
inferred or stored in the upstream descriptor.

Normalized geographic footprints use the declared planner coordinate system;
original raster conventions remain separate metadata. HRSC sphere heights and
MOLA areoid/radial topography retain their actual datums. They are not relabeled
as ellipsoid/geodetic heights. Transform/projection/registration warnings remain
visible; #248's identity-only lock validation still rejects unresolved datums.
A HiRISE image alone never establishes a matching DTM; relationships are added
only from separately cached released products and their asset listings.

Pixel evidence requires `metadata.validData.geometry`, an HTTPS evidence URL,
a method and `extent`. `complete-mask` also identifies invalid pixels within
the source envelope; `known-valid-subset` leaves its remainder unknown. This
distinction survives selected-source export into #248: a 60% valid complete
mask leaves 40% unsatisfied for those candidates, while a 60% known subset
leaves 40% unknown. Other candidate evidence can fill or qualify those pixels;
missing evidence outside product footprints remains unknown in the estimator.
`nodata: "none"` alone is insufficient. Both forms preserve holes and dateline
splits through the same polygon/planetary area implementation as #248.
Masks outside a product footprint are rejected. Metadata-bearing sources need
independent validity evidence before an estimator can establish fidelity or a
lock can accept coverage; legacy #248 descriptors retain their existing contract.

Each combination/channel has disjoint `verifiedGeometry`, `unknownGeometry`,
`gapGeometry` and their ROI fractions. They sum to the requested ROI; overlaps
are counted once. Gaps mean absent from **these selected products**, never that
the archive has no other products. `targetVerifiedFraction` additionally requires
native sampling, requested physical accuracy, and the matching target datum.
Coverage status is complete, partial, empty or unknown; a 1% sliver remains
partial with 99% visibly unresolved/missing. Complete pixel availability can
still fail target fidelity. Unregistered or datum-mismatched masks are not
unioned to manufacture complete coverage. Separate observations, illumination
mismatches (>10 degrees incidence), source projections, unknown photometry,
registration and reuse terms appear in combination warnings. Alternatives with
unknown joint registration remain exploratory and explicitly unverified.

The bounded selector starts from ranked independent products and grows sets
of at most three compatible products only for incremental verified coverage.
It compares imagery/terrain choices and returns the best three deterministic
alternatives. This bounded heuristic is not an exhaustive mosaic optimizer.
Channel fallback lists separately identify finer/equal, coarser and unknown
source sampling; `require-target`/`leave-unavailable` do not silently select a
known coarser source. An empty/offline inventory returns explicit missing
candidates and partial-plan diagnostics.

## Optional live ODE and deterministic replay

The adapter uses the documented
[ODE REST v2.1.5 contract](https://oderest.rsl.wustl.edu/ODE_REST_V2.1.5.pdf),
`https://oderest.rsl.wustl.edu/live2/`, `query=product`, `target=mars`,
`results=copmf`, `output=json`. It reads actual `ODEResults.Products.Product`
singleton/array responses, `pdsid`/`Product_lid`, `Footprint_geometry`,
`Map_scale`, `Product_files.Product_file`, and service status. Supported bounded
product families are CTX EDR, HiRISE RDRV11/DTM, HRSC DTMRDR terrain, MOLA
MEGDR topography, and Viking MDIM/MDIMC. Other families are diagnosed, not guessed.
MOLA's ODE `Map_scale` is pixels/degree, not metres; its original XML label
supplies the curated grid scale.

A full **mission/instrument/productType tuple** is mandatory: the service can
silently ignore spatial limits for incomplete tuples or product-only searches.
Supply planetocentric latitude and east longitude 0..360 bounds (west > east is
a longitude-seam search), or a product ID within the tuple. Example query file:

```json
{"mission":"mro","instrument":"ctx","productType":"edr","minLat":18.3,"maxLat":18.6,"westernLon":77.2,"easternLon":77.7}
```

```bash
node scripts/discover-surface.mjs docs/examples/surface-plans/jezero.plan.json \
  --inventory docs/examples/surface-plans/mars-jezero.inventory.json \
  --ode-query /tmp/jezero-ctx-query.json --ode-cache-out /tmp/ode-cache.json

# Exact same adapter/recommendation path, offline:
node scripts/discover-surface.mjs docs/examples/surface-plans/jezero.plan.json \
  --inventory docs/examples/surface-plans/mars-jezero.inventory.json \
  --ode-cache docs/examples/surface-plans/evidence/jezero-ctx-live.cache.json

# Explicit integration smoke: 2 pages x 2 products; writes replayable raw metadata.
node scripts/smoke-ode-mars.mjs /tmp/ode-smoke.json
```

The live smoke succeeded on 2026-10-21 with four distinct CTX IDs over two
advancing pages. Its checked-in cache is tested offline. Despite the manual's
0-based description, the live service echoed offset 0 as 1; the validated
adapter uses **1, 1+pageSize** (smoke: 1 and 3). `Count` described the returned
page in these captures, so termination uses short pages, caps, and repeated
identities rather than treating it as the archive total. Archive ordering is
not a cross-date lock; cache the metadata for deterministic decisions.

Live access is CLI opt-in: at most **2 pages x 16 products**, 1 MiB/page,
12 seconds/page by default. Fixed HTTPS metadata endpoint, no redirects,
credentials, browse/raster requests, arbitrary URL templates, or polling.
Timeouts, HTTP/service errors, malformed/oversized payloads, unsupported
products, repeats and caps return diagnostics and preserve available offline
records. The combined inventory stays capped at 32, with reviewed curated
metadata taking precedence over duplicate live identities. Old arbitrary
`--ode-template` URLs are replaced by validated query files.

## Verification

```bash
npm run build
npm run typecheck:tests
npm run lint
npm run lint:purity
npx vitest run packages/core/src/__tests__/surface-discovery.test.ts \
  packages/core/src/__tests__/surface-plan.test.ts scripts/surface-discovery.test.mjs
```

Regressions cover primary-capture hashes and inventory regeneration, Jezero/Gale
reports, determinism, the partial-sliver bug, compatible coverage union, overlap,
holes/dateline, unknown/complete masks, datum/registration/projection conflicts,
illumination/observation warnings, policy choices, candidate download costs,
source sampling versus accuracy, real MOLA raster selection/costs, original
label quality/datum/envelope evidence, ODE page formats/errors/caps/offline replay,
and discovery → selected candidates → #248 estimator. No scientific mask,
accuracy, registration transform or product availability is fabricated to make
an example pass. The final evidence audit incorporates obtainable product-level label fields
and archive links while preserving unknown per-pixel masks, physical accuracy,
and target transforms. Those scientific unknowns are supported report outcomes,
not deferred implementation. Keep #249 open until human acceptance; later
source build selection remains a separate action.
