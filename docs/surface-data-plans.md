# Offline planetary surface data plans

From a checkout with `npm ci` installed, run:

```bash
npm run --silent plan:surface -- docs/examples/surface-plans/jezero.plan.json \
  --sources docs/examples/surface-plans/jezero.sources.json --out /tmp/jezero-estimate.json
```

This compiles the shared core tooling, reads local JSON/GeoJSON, prints a report,
and saves summary JSON. Omit `--sources` for geometry-only estimates; use `--json`
for JSON on stdout. No viewer, archive credentials, SPICE kernels, raster downloads,
tiling tools or storage account are required. The CLI never fetches a URL or runs
a build executor. Its only generated data file is the explicitly requested `--out`.
Invalid input emits `{diagnostics: [...]}` on stderr and exits 2. An over-budget
estimate is a valid planning result, not a CLI failure.

The Jezero approach/landing/touchdown polygons and source descriptors are
**synthetic fixtures**, not Skyfall mission geometry or evidence of HiRISE DTM
coverage. The supplied DEM has 200 m native sampling: it cannot satisfy the
requested 100 m, 20 m or 1 m elevation targets. Imagery coverage remains unknown.
`lunar-pole.plan.json` exercises overlapping regions across the longitude seam
near the south pole. `lunar-pole-unsupported.plan.json` deliberately demonstrates
the diagnostic for a pole-enclosing ring; split it into unambiguous polygons.

## Version 1 contracts

The renderer-independent TypeScript schemas and runtime validators are exported
from `@cosmolabe/core`: `DesiredSurfacePlan`, `LockedSurfacePlan`,
`SurfaceSourceDescriptor`, `validateDesiredSurfacePlan`, `resolveSurfacePlan`,
`validateSurfaceSources`, `validateLockedSurfacePlan`. They use plain JSON data.
The estimator and validators have no filesystem, network or rendering dependency.
Only the CLI supplies local file contents. Unknown contract fields and unsupported
versions fail validation rather than quietly ignoring misspelled units/goals.

A desired plan has `version: 1`, `kind: "desired-surface-plan"`, `body`, `frame`,
`coordinates`, `layers`, and `regions`. It expresses intent, never source coverage.
The frame must be the shared `IAU_<BODY>` body-fixed frame. `coordinates` is the
existing [planetary GeoJSON descriptor](geographic-layers.md#coordinate-interpretation),
including the **physical** sphere/oblate ellipsoid in km. There is no implicit
Earth/WGS84 interpretation. Triaxial/prolate shapes, ambiguous global rings,
areoid ROI heights and arbitrary CRS conversions remain unsupported as in #196.

Each layer uses `GeographicLayerDefinition` (`id`, `name`, `body`, `source`, optional
coordinates/display/provenance). Add `geojson: {type: "FeatureCollection", features: [...]}`
to embed data, or omit it to resolve `source` from caller-supplied text. CLI paths
resolve relative to the plan, not the current directory. All layers in v1 share
the plan's body and coordinate conventions. Original features/properties/holes
and authored ROI boundaries survive serialization. ROI Z does not change the
horizontal reference-surface area; missing Z does not imply measured terrain.

A region refers to an existing `(layerId, featureId)` using #196's **typed stable
IDs** (`string:touchdown`, `number:7`), not a private geometry or array index.
It requests imagery and/or elevation independently:

```json
{
  "id": "touchdown",
  "feature": {"layerId": "jezero", "featureId": "string:touchdown"},
  "imagery": {"gsdM": 0.25},
  "elevation": {"gsdM": 1, "accuracyM": 0.5},
  "priority": 100,
  "fallback": "require-target"
}
```

`gsdM` and optional maximum source `accuracyM` are positive meters. Output sample
density, native physical sampling, source uncertainty, and mesh approximation
are separate quantities. Larger integer `priority` protects budget comparisons;
default is 0. Fallback is `require-target` (default), `allow-coarser`, or
`leave-unavailable`. Neither preferences nor priorities change the authored request.

Within overlaps, the smallest requested GSD and smallest requested accuracy win
**independently per channel**. Priority never suppresses finer authored requests.
Regions are unioned into disjoint detail bands for counting, including holes and
MultiPolygons; they are not destructively rewritten in the desired plan. Edges
are linear in the declared longitude/latitude plane, as in #196, not geodesic
arcs. Longitude seams are unwrapped and split for Boolean operations with
`polygon-clipping`. Area integrates the sphere/oblate ellipsoid surface measure
along those edges (32-subinterval Simpson quadrature); centric latitude is
converted within that integral. This is reference-shape area, not a terrain-slope
area measurement or a new ellipsoid renderer.

## Source descriptors and locked plans

The CLI accepts a local JSON **array** of `SurfaceSourceDescriptor` metadata.
Each describes one candidate product/asset: stable `id` and `productId`, channel,
body/frame, footprint conventions, optional GeoJSON footprint, native GSD and
accuracy (`null` if unknown), nodata evidence, projection, the shared `TerrainDatum`,
URL or documented retrieval, version/checksum/bytes where available, and license
and attribution. `jezero.sources.json` is a complete example. This is the seam for
later discovery; there is no crawler or automatic source selection here.

A footprint with `nodata: "none"`, adequate known native sampling/accuracy, and a
matching datum can provide positive evidence. Missing footprints, unknown native
GSD/accuracy, nodata `"unknown"` or `{maskUrl: "..."}`, and unimplemented datum
transforms leave coverage unknown. Masks are recorded, never downloaded or
assumed valid. Incompatible bodies/frames/coordinate conventions are diagnosed
and excluded. Coverage outside supplied footprints is **unknown**, not a claim
that an archive contains no product. Coarse known coverage is **unsatisfied**;
partly adequate coverage is **partial**. An unknown candidate never overwrites
positive evidence from another adequate source. Resampling cannot create native
resolution or improve source accuracy.

A locked plan has `kind: "locked-surface-plan"` and a distinct validator. Use
`createLockedSurfacePlan` with an explicitly supplied desired snapshot, sources,
and processing/output choices; estimation never locks a plan automatically.
`resolveSurfacePlan(plan, references).desired` supplies the snapshot with every
referenced GeoJSON embedded. Every requested region/channel needs an explicit
selection of source IDs, output GSD, resampling, and documented transformations
(including an explicit identity transform). Each selected source requires a
footprint, known native GSD/datum, a product version or SHA-256 checksum, retrieval
information and license. Known nodata/mask semantics stay attached to the source.
The lock records generator name/version, processing/fusion parameters, output
representation/version, tile size/gutter and per-channel encoding. A selection
does not assert that physical targets are satisfied; build execution must still
honor coverage, nodata and the recorded transforms.

`serializeSurfacePlan` produces canonical finite JSON with sorted object keys
and preserved array order; `surfacePlanIdentity` hashes it with SHA-256 (Web
Crypto, also available in Node 20+). The estimator's `desiredIdentity` includes
resolved GeoJSON contents, so a changed referenced file changes the identity.
The lock has both that desired identity and its own content identity. Changed
sources, output density, transformations or generator versions require a new
lock; `validateLockedSurfacePlan` verifies both hashes and rejects stale/tampered
ones. Consumers must validate a lock before executing it.

## Reading estimates

The JSON includes `estimatorVersion`, resolved desired and source-metadata identities, `stage`, explicit
assumptions, diagnostics, per-channel/detail/accuracy bands, source evidence,
resource totals, a browser scenario and optional budget comparisons. Stages are
`geometry-only` or `source-aware`; this estimator never claims sample-build
calibration. No live time, network response or arbitrary file path enters its
identity. Reports round values to three significant digits; JSON retains counts
and computed areas for comparison. Byte units are decimal MB/GB, not MiB/GiB.

The report separates:

- **Raw download:** all intersecting/possibly intersecting compatible candidate
  products counted once by source ID. This is an explicit all-candidates scenario,
  not an optimized download plan. Known bytes form the lower bound; missing sizes
  or uncovered requests keep the upper bound unknown.
- **Peak/intermediate disk:** source bytes plus an output-sized scratch scenario.
  The separate `outputWorkDiskBytes` scenario applies both multiplier bounds.
  The upper bound remains unknown because source decode/intermediate sizes are
  not derivable from compressed asset size alone. The output scratch multiplier
  is an assumption, not a measured generator peak.
- **Publication:** independent imagery/elevation base samples, pyramid samples,
  object counts and compressed byte ranges. Counts use full tiles and gutters;
  the packing scenario ranges from ideal area packing to a boundary/perimeter
  allowance with per-component padding, including overview levels.
- **Browser/network:** decoded tile bytes and a configurable visible-tile scenario
  with transfer byte and request ranges. These exclude meshes, mipmaps, caches,
  prefetch, HTTP overhead and renderer behavior; they are not a performance test.

Defaults are 256 px tiles, 1 px gutters, RGB8 imagery, float32 elevation, compression
ratios 0.08–0.5 / 0.25–0.8, and 16–64 visible tiles per active channel. Overview
counts use powers of two until ideal area fits in one tile (roughly 4/3 samples
for a large compact region). These are **uncalibrated scenario bounds**, not a
statistical confidence interval or guaranteed tiler packing bounds. Long thin or
fragmented ROIs, a different lattice/representation, compression, additional
metadata or source processing may lie outside them. No exact source GB figure
is invented when metadata is unknown. Impossible counts use `null` upper bounds
and diagnostics; `null` always means unknown, never zero.

An optional `budget: {publishedBytes: ...}` yields `within` if the entire scenario
range fits, `over` if its lower bound exceeds the budget, and `uncertain` otherwise.
At most two comparisons coarsen GSD by 2× and 4× in `allow-coarser` regions at the
lowest priority, protecting all higher-priority regions and their overlap goals.
The report lists every affected region; it never edits the desired plan or trades
away accuracy. These are bounded comparisons, not a global budget optimizer.

Limits: 2 MiB finite JSON and depth 32 per document, 16 layers, 32 regions, 32 source
descriptors, 64 features / 4,096 vertices per footprint, and 4,096 vertices across
desired layers. Existing #196 topology work limits also apply. CLI external
GeoJSON has an 8 MiB aggregate read limit. This intentionally supports small
planning ROIs; simplify or split larger datasets before estimating.

Run regression tests with:

```bash
npm run build
npx vitest run packages/core/src/__tests__/surface-plan.test.ts scripts/surface-plan.test.mjs
```

This tooling does not change MoonFall/Ingenuity catalogs, terrain rendering, Mars
cube migration, independent imagery LOD, fusion, publishing or geographic editing.
