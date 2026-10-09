# ADR: physical surface queries and independent imagery

Status: accepted for an opt-in, bounded integration proof; production migration
requires the gates below. Implements the decision/proof scope of #148, under #47.
Baseline: Cosmolabe main `3861b0d`; upstream audit: 3d-tiles-renderer 0.4.27
(pinned) and v0.5.3 tag, commit `476ed6b` (2026-10-04).

## Decision

Share a **body-fixed CPU ray-query port**, not a universal heightfield, renderer,
projection engine or on-disk format. Keep `TerrainSampler` and its scientific
`TerrainDatum`, decoded grid/TIN tiles and source metadata. Add only a mesh source
kind and optional immutable version to that metadata. A globe advertises height
sampling; an irregular source need not. Concave meshes retain their complete
Cartesian geometry and winding normals, even where one lat/lon has several hits.

The concrete interfaces and bounded implementations live in
[`packages/three/src/surface/`](../../packages/three/src/surface/). They import no
Three.js. They remain beside the existing CPU sampler for now: moving it into
`core` or introducing a new package would force unrelated import churn. Extract
the CPU modules together only when a second renderer actually consumes them;
`core` must never import the renderer package.

| Owner | Responsibility | Excludes |
| --- | --- | --- |
| Canonical physical source / CPU cache | Datum, source revision, decoded samples, physical intersections, coverage, approximation evidence | Scene traversal, imagery fetches |
| Renderer / tile streamer | Visual geometry, main camera streaming, mesh/texture GPU budgets, LOD transitions | Datum conversion, scientific fallback |
| Permanent map layer | Pixel registration, CRS adapter, cutline/nodata, resampling, independent image LOD and budgets | Choosing physical geometry depth |
| Transient observation layer | Frozen acquisition geometry/calibration, footprint, projection, occlusion, image lifecycle | Replacing permanent maps or elevation |
| Viewer / frame adapter | World → body-fixed rays, body orientation, scene scale and floating origin; presentation policy | Source tile addressing |

Cartesian 3D Tiles may transport both globe patches and irregular meshes; that
transport does not provide scientific sampling or source completeness semantics.
Neither a permanent global/polar join nor cube faces are selected by this ADR.

## Physical contract and semantics

`PhysicalSurface.intersectRay(SurfaceRay, SurfaceQueryOptions)` is cache-only and
synchronous. Position and ray distances are **km** in an explicit body-centered,
right-handed Z-up target frame; direction is normalized internally. The finite
inclusive `[nearKm, farKm]` interval excludes unwanted earlier hits. Queries are
geometric: orientation/epoch/aberration resolution occurs before entering the
port. Invalid inputs throw, rather than masquerading as unavailable data.

`SurfaceIntersection` distinguishes hit, miss and unavailable. A hit carries
position, unit winding normal, distance, triangle provenance, source/version,
reference shape/datum for a globe, achieved mesh-deviation bound and source
uncertainty. Winding normals are not automatically radial or observer-facing.
`meshDeviationBoundKm = null` means unknown. A validated mesh bound is a spatial
approximation bound against the canonical source, **not** source uncertainty,
triangle size, angular tile footprint, measured RMS, or renderer screen error.
A zero bound is valid when the canonical source itself is those exact triangles;
it says nothing about accuracy relative to a real body or an ideal analytic shape.

A hit or miss is `sufficient` only for a complete declared product and a known bound
meeting `maxMeshErrorKm`. Otherwise it is `coarse`; consumers must retain that
status. A complete-product miss means no intersection with **that selected
product**, not with every possible body source. Partial-product misses are
unavailable; partial-product hits are provisional nearest hits because missing
geometry may occlude them. Unknown coverage never becomes a reference-ellipsoid
hit. Source composition and a ray-prefix completeness certificate are prerequisites
for replacing global body picking; a renderer's visible tiles are not a certificate.
Coarse mesh misses carry their accuracy too: approximation may have missed a
canonical-source intercept, so an async caller can request finer geometry.

`sampleElevation` is optional and preserves `TerrainSample`: degrees north/east
(oblate geodetic latitude and longitude wrapped to [-180,180)), elevation
in km, datum, source/tile and uncertainty; its existing normals are **tile ENU**.
Ray hits use **body-fixed** normals. Height sampling is not mesh intersection:
a grid is bilinear in angular coordinates and a TIN uses angular barycentrics;
ray intersections are Cartesian triangles. Neither method should conceal that
difference. Areoid conversion, triaxial geodetics and oblate radial heights need
explicit adapters; the proof refuses those coordinate interpretations rather
than routing them through the existing oblate geodetic converter.

`requestSurfaceIntersection` adds a separate `SurfaceQueryLoader` port: one
source-owned ensure-coverage/detail attempt with `AbortSignal`, then requery.
It returns achieved availability even if detail could not be loaded, and propagates
load errors. Cancellation is checked before and after loading; late results do
not get delivered. The source owns request sharing/reference counts and must
not abort another consumer's download when one caller cancels. No speculative
network loader is added in this proof.

## Working proof and limits

- `GlobeTileSurface` derives a CPU triangle snapshot from **one explicitly selected
  decoded tile in the existing TerrainSampler**, using its corrected heights,
  datum and TIN topology (or a fixed grid diagonal). It never reads rendered
  meshes. Tile replacement/eviction invalidates the snapshot. Height sampling
  remains the original sampler's best cached geographic sample and reports its
  own tile provenance; it may be a different tile from the explicitly selected
  ray-query tile. This is not a new independently selected globe pyramid.
- `CpuMeshSurface` owns copied Cartesian buffers, performs double-sided CPU
  triangle intersection, and preserves the nearest hit in the requested interval.
  It is deliberately a linear bounded proof, not a DSK loader or large-mesh BVH.
  Degenerate triangles are ignored; malformed arrays/indices are rejected.
- Both enforce an 8 MiB default **retained geometry** budget, separate from the
  TerrainSampler's existing tile-count budget and renderer GPU/LRU budgets.
  The globe adapter checks derived size before allocation. Construction needs
  transient buffers in addition to retained bytes. Production streaming needs
  byte accounting across decoded tiles, snapshots, acceleration and in-flight
  decode, not just this per-source cap. Treat sampler tiles as immutable and
  replace them through `addTile`; do not mutate cached arrays in place.
- `pickPhysicalSurface` and `cameraPositionFromSurfacePick` demonstrate consumers
  for both representations. Camera placement uses the returned winding normal;
  coarse/provisional placement requires explicit opt-in. This proves placement,
  not swept-volume clearance, interior classification, surface walking or a
  complete irregular-body navigation mode. Existing viewer picking and camera
  modes are unchanged until production gates pass.

Run `npx vitest run packages/three/src/__tests__/PhysicalSurface.test.ts`.
The fixture is a closed torus with 1,024 triangles: the +x ray from the center
hits both x=1 and x=3 at the same lat/lon, with the inner normal pointing into
the concavity. A ray through its hole misses. The authoritative fixture is the
tessellated mesh, not the smooth analytic torus used to construct its vertices.

The globe proof uses the repository's actual MarsHub level-14 terrain fixture,
without datum offsets, with an explicit oblate/geodetic datum. At a tested
triangle interior, scientific sample vs ray height must agree within **1 m**;
CPU ray vs independently reconstructed, tile-centered float32 rendered triangle
must agree within **1 mm**. The latter uses the pinned upstream Ellipsoid mapping
and a Three.js raycaster in the **test only**. These are fixture gates, not
universal accuracy claims. The ray result keeps its global approximation bound
unknown. Existing tileset radius-offset compatibility may have additional
ellipsoid conversion error and needs separate validation before migration.

## Independent imagery contracts

`MapImageLayer` defines a versioned planetary CRS, source pixel-corner affine
registration, footprint/cutline, nodata, explicit latitude/longitude convention
via the named CRS, datum and measured registration error. Its resampling policy,
texel-error target, image level range and decode/GPU/request budgets belong to
that layer. An adapter must map surface positions into image coordinates;
unsupported CRS/coverage is transparent or explicitly unavailable. Pixel-center
conversion is explicit (`i+0.5,j+0.5`), including seam/pole and cutline tests.
An image level is selected from projected texel footprint, never terrain depth;
geometry need not refine for sharper imagery. Texture subdivision/virtual
texturing may still be needed when a coarse triangle spans many image tiles.
This ADR does not claim the current overlay residency is fully decoupled: it
still attaches image work/materials to terrain tiles.

`ObservationImageProjection` stays separate from map registration. It contains
reception acquisition ET (TDB seconds past J2000), observer, target/camera frames,
versioned calibration and distortion, camera origin/rotation, target epoch,
kernel/geometry revision, aberration convention, occlusion/incidence rules and
transient budget. Camera axes are +x right, +y down, +z forward; quaternion is
xyzw camera → target. Playback time never substitutes for acquisition geometry.

A single frozen pose is sufficient for geometric `NONE` projection of a static
body-fixed source. For LT/CN and stellar aberration, the light time and target
orientation can vary by pixel/intercept; a single camera pose/target epoch must
**not** be presented as a complete corrected solution. `ObservationRayResolver`
is the per-pixel geometry/calibration seam; a future SPICE-backed projector must
resolve interception and target epoch iteratively, consistent with SINCPT.
Rolling shutter/time-dependent shape requires another explicit capability.
No projector ships in this query proof. Its migration gate is acquisition-time
replay with calibrated pixels, back-face rejection and nearest physical hit
occlusion on both globe and concave mesh, including unavailable geometry.

## Upstream reuse audit

The audited v0.5.3 tag has the surface mapping change in its changelog's
**Unreleased** section, so the source tag was checked directly rather than
inferring behavior from the heading. `TilesRenderer.surface` defaults to Ellipsoid;
`ProjectedSurface` implements cartographic ↔ local position/normal conversion
for a **flattened x/y plane**, with z height, normalized scale/offset and +z
normals. ImageOverlayPlugin maps through that interface. Reuse it in a rendering
adapter after a separately validated upgrade; do not copy it as a scientific
surface query abstraction.

Its ProjectionScheme recognizes equirectangular, Mercator and Equal Earth
(EPSG:8857), plus unprojected image space. It is not evidence of lunar polar
stereographic, arbitrary nonlinear CRS, cube-face layout or concave DSK support.
A plane with constant normals is not a physical lunar cap wrapped onto the body.
The existing 0.4.27 overlays already choose image levels using image resolution
(the 0.4.24 change), which is useful to retain, but does not certify independent
texture residency. RasterElevationSamplingPlugin's rasterized visual elevation
sampling likewise cannot replace authoritative CPU source queries.

Upgrade risks from 0.5.0: deprecated APIs removed; renderer instances share
process/download/priority queues and the LRU cache by default; overlays share
queues; tile visibility/fade/traversal behavior changed. TerrainManager currently
patches clipping, virtual child disposal, queue/cache behavior and overlay
resolution. Inventory/retest each patch against public APIs before upgrading;
explicit per-body cache/queue ownership must survive. No dependency bump here.

## Migration gates and dependencies

1. Preserve #49 sample/datum semantics and #52 numerical instrumentation. The
   proof is additive; current globe navigation and demo catalog paths stay live.
2. Source-owned multi-tile selection must handle finest valid coverage, parent
   fallback, holes, overlapping source priority and async budgets. Certify the
   ray prefix before calling a nearest hit sufficient. Add a CPU spatial index
   and measure query cost for realistic meshes; do not port the linear proof
   to millions of DSK triangles. This precedes a global picking/collision switch.
3. Quantify sample ↔ Cartesian mesh ↔ rendered mesh error per source/LOD, including
   pole/antimeridian, offsets, boundaries and parent/child transitions. Record
   max/RMS/p95 separately from a validated conservative mesh bound. Keep fusion,
   scientific uncertainty, datum and continuity requirements in the terrain plan.
4. Validate the upstream upgrade and rendering adapter separately. The polar
   prototype (#144/#145) and imagery follow-up (#147) inform this work but do
   not define a permanent globe/polar join. #53 imagery work should implement
   layer-specific LOD/residency using the registration contract.
5. #107 observations and #28 irregular mission geometry can adopt the same CPU
   port. Full Rosetta ingestion is not a prerequisite: preserve frame/calibration
   provenance and demonstrate occlusion on the fixture before mission replay.

## Sources

- [3D Tiles specification](https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc)
- [Audited v0.5.3 changelog](https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/476ed6be569ad31290772f540f4f153e00a6935b/CHANGELOG.md)
- [ProjectedSurface implementation](https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/476ed6be569ad31290772f540f4f153e00a6935b/src/three/plugins/images/utils/ProjectedSurface.js)
- [ProjectionScheme implementation](https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/476ed6be569ad31290772f540f4f153e00a6935b/src/three/plugins/images/utils/ProjectionScheme.js)
- [OpenSpace RenderableGlobe](https://docs.openspaceproject.com/latest/reference/asset-components/Renderable/RenderableGlobe.html)
  separates height and color layer groups; this is precedent for ownership,
  not a requirement to copy its renderer/layout.
- [NAIF SINCPT](https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/sincpt_c.html)
  distinguishes ellipsoid/DSK interception, observer and target epochs, frames,
  and light-time/stellar-aberration conventions.
