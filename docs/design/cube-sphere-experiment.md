# Cube-sphere terrain experiment (ADR)

**Status:** open; experimental, not a production layout. Geometry evidence recommends *revise* (see *Layout comparison*)
**Issue:** #149 (remains open)
**Recorded:** 2026-10-04 (foundation); 2026-10-13 (lunar builder and viewer demo); 2026-10-14 (independent imagery; mixed-LOD crack mitigation and the geometry-layout comparison; LOD error and mesh simplification); 2026-10-15 (frame overhead and main-view draw culling)

## Decision

Keep the geographic and polar products as the production baselines. Continue a
cube-sphere experiment using the gnomonic mapping below, but do not migrate or
publish a global product yet. This record is not the layout decision, which
waits for the evidence still listed as remaining at the end.

Delivered so far: deterministic addressing and a renderer-independent CPU height
payload (foundation), then a bounded lunar builder over the authoritative fused
field, an opt-in viewer demo with CPU readout, picking and clearance through the
#148 port, numerical validation of the real product, and software-rendered
captures from the same camera poses as the #145 polar cap; then independent
cube-face imagery: a face-aware runtime adapter that refines map imagery at its
own levels over unchanged geometry, with a controlled fixture, rendered
registration read-back and a bounded real lunar example (see *Independent
imagery*); then mixed-LOD crack mitigation by skirts sized from the product's
measured gaps, and a geometry-only layout comparison of cube, polar and
geographic products on one hardware GPU (*Mixed-LOD crack mitigation*, *Layout
comparison*); then a measured, propagated geometric-error bound and optional
RTIN simplification, each compared at matched achieved error (*LOD error and
mesh simplification*): the bound is kept as validation and metadata but not as
the selection policy, and 0.03 × spacing simplification closes the
triangle/GPU gap to the polar cap at Shackleton and the pole while leaving a
draw-count gap; then the frame overhead explained and cut (*Frame overhead and
main-view draw culling*): most drawn tiles were selected by off-screen
streaming cameras and reached no pixel, and the cube path now draws only what
the main camera can see. Correctness, CPU/rendered-surface accuracy handling
and a matched-imagery comparison remain; see *Remaining for #149*.

## Mappings compared

### Quadrilateralized Spherical Cube (QSC)

PROJ's `qsc` projection is the documented reference candidate. It divides the
globe into six areas and provides an equal-area mapping on a sphere, with a
separate ellipsoid-to-sphere latitude conversion for ellipsoids. Its forward and
inverse equations are the O'Neill/Laubscher mapping as corrected by the PROJ
implementation. Face selection and the longitude offsets around each face must
be made part of a product specification; a label of “cube map” alone does not
select QSC or imply equal area.

QSC is attractive for more uniform sample area, but it has considerably more
branches and transcendental operations than the simple mapping. Before adopting
it, we would need conformance vectors pinned to a named PROJ version and an
explicit axis/orientation convention. See the [PROJ QSC documentation][qsc].

### Selected experiment: normalized (gnomonic) cube

For a face with orthonormal basis `(N, U, V)`, forward mapping is

```text
d = normalize(N + u U + v V),   -1 <= u,v <= 1
```

Inverse mapping chooses the face whose normal has the greatest dot product with
the direction, then computes

```text
u = dot(d, U) / dot(d, N)
v = dot(d, V) / dot(d, N)
```

The implementation fixes the bases, handedness, and exact-tie ownership in
`CubeSphere.ts`. X wins over Y, and Y over Z, at equal dominant magnitudes.
Tiles use `{face}/{level}/{x}/{y}`, with both indices increasing with face `u/v`;
each face is a standard quadtree. Shared-edge samples are duplicated in adjacent
products and must be numerically identical. The ownership rule chooses only the
address used for a query; it must not create a gap in rendered coverage.

This mapping is short, exactly invertible apart from non-unique seam labels, and
cheap to generate. It is **not equal area**: scale and anisotropy rise toward face
corners. Consequently, comparisons must use measured surface error and ground
detail rather than equal levels or nominal geometric-error values.

## Shape and height semantics

Cube coordinates describe a **geocentric direction**, not a longitude, geodetic
normal, or position on a reference ellipsoid. For a geodetic query the sampler
first constructs the zero-height Cartesian point on the declared datum, then
addresses its geocentric direction. This distinction is visible on the flattened
ellipsoid test fixture.

The sampler accepts the same datums as the shared physical-surface proof
(#148): a reference sphere, or a geodetic oblate ellipsoid (equal X/Y radii,
`geodetic-normal` heights) with a `reference-sphere` or `ellipsoid` vertical
datum. Anything else, including triaxial shapes, is rejected at construction
rather than addressed through an oblate substitute while still reporting the
original datum.

Equivalent geographic coordinates must address the same tile at every level.
Longitude is wrapped to the `[-180, 180)` sample convention, and the reference
ray uses degree trigonometry that is exact at multiples of 90 degrees, so the
poles and the 0/180 degree meridians land on exact child boundaries rather than
on whichever side a ~1e-16 residual picks. Other angles are not snapped. Generated vertices must reconstruct the declared
reference shape and add heights according to `heightConvention`; a radial lunar
field and a geodetic-normal ellipsoid field are not interchangeable.

The CPU payload stores the same fused height field sampled by generation, as a
regular grid per cube tile. Bilinear CPU samples therefore represent that field,
not the rendered triangle surface. A builder must measure and publish the maximum
Cartesian discrepancy against the emitted GLB triangles (including edge and
mixed-LOD cases); it must not claim those two surfaces are identical.

Geometry and imagery have separate addressing and residency. A geometry tile's
CPU grid contains datum and source provenance but no image bytes. An image
pyramid can consequently refine or evict without changing physical-surface
queries. Production rendering should reuse upstream 3D Tiles REPLACE refinement
and material/overlay facilities before adding custom split logic; *Independent
imagery* records why the installed and released overlay plugins could not drape
cube faces, and the small adapter used instead.

## Lunar builder: `dem.py cube-tile`

`scripts/build-moon-terrain/cube.sh` runs `scripts/terrain/dem.py cube-tile` on
the fused field that `fuse.sh` writes once for every Moon product (LOLA LDEM 118 m
plus the LOLA 87°S 10 m residual, #48). Every vertex comes from `field_heights`,
the function the geographic quantized-mesh pyramid and the #145 polar cap sample,
so the three products describe one surface. The faces, bases and tile addresses
are `CubeSphere.ts`'s; the validator derives its bases from the compiled module
rather than a second copy.

- **Levels.** All six faces to level 3 (6.8 km face-centre vertex spacing), then
  bounded regions: around Shackleton (89.67°S 129.78°E) down to level 11
  (26.5 m) within 25 km and level 12 (13.3 m) within 15 km, which holds the rim,
  floor and the pole and matches the polar cap's 24 m / 12 m levels; and around
  the px/py/nz corner (35.26°S 45°E) and the px/nz edge midpoint (45°S 0°E) down
  to level 8 (212 m). 4,030 tiles, no global high-resolution rebuild.
- **Geometry.** One .glb per tile, the full 65² lattice (no simplification),
  float32 positions relative to the tile's box centre with the centre as a
  float64 glTF node translation, through the polar tiler's `encode_glb`. Normals
  are central differences of the field along two tangents chosen from each
  vertex direction alone.
- **CPU grids.** `heights/{face}/{level}/{x}/{y}.f32` holds the same 65² heights
  (float32 metres above the 1,737.4 km sphere, radial). `cpu-grids.json` carries
  the datum, the whole product's height range (padded 1 m), the source revision (`cube-fused-<sha256(fusion.json)>-g3-m12`, with
  the fusion and generator hashes), every tile address and a per-tile
  uncertainty: the sampled representation error of the bilinear grid against the
  fused field at its finest source level, at 4× vertex density. It is not a bound
  and excludes source error, which neither source states per pixel.
- **Refinement and bounds.** A parent refines into all four children or none;
  unwanted siblings are leaves. A content-less root that always refines holds
  the six face roots. Each content box bounds the float32 vertices the renderer
  draws (a float64 box missed them by up to 3.5 cm at level 0); each node box is
  the union over its subtree.

### Boundary policy

- **Same level, within a face, across faces and at corners.** Lattice
  coordinates are exact dyadic rationals `(2k − n)/n`, so a shared vertex has the
  bit-identical body-fixed `N + uU + vV` on every tile, face and corner that
  holds it. Its height and normal are evaluated one point at a time: numpy's SIMD
  `arctan2`/`sin`/`cos` returned 1-ulp differences for the same input in different
  array positions, which broke bit identity on the first real build. Shared CPU
  heights are now identical; rendered positions differ only by each tile's
  float32 offset rounding.
- **Mixed levels.** A parent edge samples the field at its own spacing and
  source level, so a finer neighbour's edge vertices are T-junctions against
  the parent's straight edge. The cracks are measured on the surface triangles
  and covered by per-edge skirts sized from those measurements (*Mixed-LOD crack
  mitigation*); `--skirt-cells 0` builds the #178 product without them.
- **Ownership** is `CubeSphere.ts`'s: X > Y > Z on exact ties, and the upper
  child on an exact child boundary. It selects an address for a query only.

## Viewer and CPU integration

`TerrainConfig.cubeSphere = { cpuGrids }` (with `type: '3dtiles'`) is the only
switch. It lives in three unlisted catalogs under
`apps/viewer/test-catalogs/experiments/` (cube, polar baseline, geographic
baseline; same scene, epoch and errorTarget 2), so no production catalog changes.

- `CubeSphereGridSource` fetches levels 0–2 up front (the never-evicted coarse
  fallback) and finer grids **by query location**: a sample, a readout or a ray
  requests the tile chain under it, independently of what the renderer streams.
  Coverage at a point is explicit: `finest`, `parent-fallback` or `unloaded`.
- When configured, `TerrainManager.sample`/`sampleBodyFixed` answer from the
  grids, so the existing readouts, camera clamp and waypoint sampling use them
  unchanged. Until the grids arrive a sample is `null`, never the datum.
- `CubeGridSurface` implements the #148 `PhysicalSurface` over resident grids:
  it rebuilds a tile's exact .glb triangles in float64 and marches the ray across
  finest resident tiles (refining the march wherever the tile changes) inside
  the shell of the manifest's whole-product `heightRangeKm`, not just of what is
  resident. A tile's hit counts only where no finer resident tile owns that
  point (a parent's mesh still spans its children); a superseded hit is skipped
  and the search continues. Coverage is declared partial, so hits are
  provisional (`coarse`) and a no-hit is `unavailable`, never a miss. It is also
  its own `SurfaceQueryLoader`, so `requestSurfaceIntersection` makes one load
  attempt along the ray, over the product's available tiles, and requeries.
- `UniverseRenderer.pickSurface` keeps the rendered hit and adds `physical`: the
  same camera ray through the #148 port, with tile, provisional status and
  distance from the rendered hit (shown in the pick sheet). A pick starts the
  ray's coverage load, so a repeat pick answers from finer grids. Camera
  clearance uses `cameraPositionFromSurfacePick` on that hit.
- Debug views: `cube-face` (hue per face, brighter with depth) and, for cube
  grids, `cpu-coverage` (green where the tile's own grid is resident, amber where
  only an ancestor's is).

## Measured results (2026-10-13)

`node scripts/validate-cube-terrain.mjs` on the built product; full JSON in
[`docs/images/issue-149/validation.json`](../images/issue-149/validation.json).
Build: fuse 7 min 12 s, cube tiles 11 min 57 s on 4 workers (4-core Xeon
2.8 GHz, 16 GB), 4,030 tiles, 611 MB .glb + 68 MB CPU grids. The polar cap from
the same fuse: 27,700 tiles, 4.3 GB, 118 s.

Gates, all passing: six face roots and complete levels 0–3; every refining tile
has exactly its four children; every float32 vertex inside its content box, node
box and all ancestors' (max excess 4e-10 m); every CPU grid matches its lattice
vertices; 471,451 same-face, 19,686 cross-face and 37 corner shared-vertex
instances with bit-identical CPU heights, positions equal within float32 offset
precision (max 0.10 m on 1,500 km level-0 tiles) and normals within 3e-8°;
the south pole answers from `nz/12/2048/2048` at every longitude, ±180°/540°
and 0°/360° spellings answer identically.

| Child level | Crack vs parent edge, Δlevel 1 (no skirts): RMS / p95 / max (m) | CPU bilinear − emitted triangle along the radial: RMS / max (m) |
| --- | --- | --- |
| 1 | 461 / 1,107 / 2,854 | 144 / 922 |
| 3 | 192 / 432 / 2,177 | 41.4 / 575 |
| 5 | 45.5 / 97.0 / 538 | 8.6 / 94 |
| 7 | 6.7 / 14.1 / 79 | 1.07 / 11.2 |
| 9 | 1.94 / 3.69 / 38.8 | 0.25 / 2.5 |
| 11 | 0.46 / 0.90 / 18.3 | 0.060 / 0.82 |
| 12 | 0.28 / 0.56 / 18.3 | 0.039 / 0.40 |

The level-0 triangles sit on average 153 m below the bilinear CPU samples: the
chord sag of 54 km cells, which no amount of agreement at vertices removes.
Parent/child heights at shared lattice positions (the metric
`validate-terrain.mjs` reports for the geographic pyramid) are RMS 0.20 m /
max 4.5 m at level 12, against 0.87 m / 6.25 m for geographic z12 (different
spacings; context, not a ranking).

Control points: the 36 MoonFall waypoints' LOLA 118 m elevations against cube
CPU samples, all answered at their finest level: RMS 6.85 m, p95 15.8 m,
max 17.5 m; the geographic fused pyramid recorded RMS 6.95 m, max 17.5 m on the
same points (the field is the 10 m mosaic there, not LOLA 118 m).

Picking and clearance: 120 rays around Shackleton, the pole, the corner and the
edge (0–60° off nadir) through `requestSurfaceIntersection`: every ray hits,
provisional; CPU hits agree with brute-force intersection of the emitted float32
triangles to < 1 mm; a camera placed 50 m along each hit's normal sees that hit
at 50 m in all 120 cases and stays ≥ 49.7 m above the CPU sample below it.

Two findings belong to the shared field sampler rather than to the layout. The
LOLA base has no overviews, so coarse levels of every product point-sample the
118 m raster: the cube's sampled representation error is 5.5 km max (672 m mean
RMS) at level 0, falling to 0.12 m mean RMS at level 12. Building averaged base
overviews (`gdaladdo -r average`) would prefilter coarse levels for all three
products at once. And the representation maximum stays at ~71 m from level 9
down, isolated points that a 13 m grid cannot represent.

## Rendered evidence and comparison with #145

`node scripts/capture-cube-terrain.mjs --product cube|polar|geographic` loads the
experiment catalogs in the dev viewer, sets explicit IAU_MOON body-fixed camera
poses at the catalog epoch (paused, errorTarget 2, 1280×800, DPR 1, cold cache per
view) and captures once streaming has *finished*: nothing queued, downloading or
parsing, no CPU grid in flight, and the visible tile count unchanged for eight
500 ms polls. Records and images:
[`docs/images/issue-149/`](../images/issue-149/). Environment: HeadlessChrome 141,
`ANGLE (Vulkan 1.3.0, SwiftShader Device (Subzero))` — **software WebGL, no GPU
in the capture host** — on the 4-core host above; 3d-tiles-renderer 0.4.27,
three.js 0.183.2.

| View | Product | Finest level (vertex spacing) | Mesh / CPU-grid requests | MB | Visible tiles | Geometry MB |
| --- | --- | --- | --- | --- | --- | --- |
| Shackleton | cube | L10 (53 m) | 178 / 144 | 30.7 | 110 | 26.5 |
| Shackleton | polar | L6 (49 m) | 101 / — | 26.1 | 76 | 16.0 |
| Pole | cube | L8 (212 m) | 141 / 144 | 25.1 | 75 | 20.9 |
| Pole | polar | L4 (195 m) | 57 / — | 19.0 | 43 | 9.0 |
| Orbital overview | cube | L1 (27 km) | 48 / 136 | 10.8 | 15 | 6.9 |
| Face corner | cube | L7 (424 m) | 312 / 141 | 50.9 | 219 | 46.7 |

At equal poses and errorTarget the two products reach equivalent ground detail
(53 vs 49 m, 212 vs 195 m). The counts are not yet a fair cost comparison: the
polar cap covers only its 200 km square and draws nothing beyond it, while the
cube fills the horizon; the cube's REPLACE chain from a whole face to level 10
is deeper; and its CPU grids (levels 0–2 eagerly, ~17 KB each) are separate
requests by design. Settle times (5–16 s) are SwiftShader wall time and say
nothing about GPU frame time. The Shackleton frames are visually equivalent; the
cube's shows crack specks along the bright wall (no skirts) where the polar cap's
skirts hide them.

## Independent imagery (2026-10-14)

The question for this slice: does the cube layout support sharp map imagery
that streams independently of geometry, correctly across the poles, the
antimeridian and face edges/corners, at a bounded cost? Map imagery and
acquisition-time observation projection (#150) stay separate capabilities;
this is map imagery only.

### Upstream first

Independent LOD and projection correctness are separate questions, and neither
is answered by the installed or the newest released plugin:

- **Installed 0.4.27 `ImageOverlayPlugin`.** UVs are per-vertex cartographic
  coordinates (`getGeometryCartographicChannel`): longitude unwrapped about the
  tile centre, the pole vertex forced to the centre longitude, then interpolated
  linearly across each triangle, and each terrain tile composites its overlay
  into one texture over its lat/lon range. A cube tile touching a pole — four on
  `nz` and four on `pz` at every level from 1, since each pole is a face centre — spans
  ≥ 90° of longitude at that vertex, so its texture covers a quadrant of longitude
  for a few kilometres of ground and the triangles fanning from the pole smear.
  The planar `frame` option maps an affine (orthographic) function of the 3D
  position: height-dependent, not the gnomonic central projection. Splitting
  only applies to REPLACE leaves, and `TerrainManager` sets
  `enableTileSplitting: false`.
- **#136's leaf-splitting fix** is still listed under *Unreleased* in the
  upstream changelog (checked 2026-10-14); npm's newest release is 0.5.3
  (2026-09-18), which does not contain it. 0.5.3 maps overlays through
  `TilesRenderer.surface` — the ellipsoid's cartographic mapping or a flattened
  `ProjectedSurface` — so on a globe it is the same per-vertex longitude/latitude
  path. An upgrade would therefore neither decouple LOD (without a backport of an
  unreleased fix) nor make cube-face projection correct, and it carries the
  0.5.0 queue/cache changes recorded in the physical-surface ADR. **No
  dependency change.**

### Design: preprocess into faces, drape at runtime

Imagery is **reprojected at build time into the cube faces** — the
`CubeSphere.ts` bases and `{face}/{level}/{x}/{y}` quadtrees, but its own levels,
extent and residency — and draped at runtime by a small face-aware adapter,
`CubeImageryLayer`. The alternative, projecting geographic or polar-stereographic
image pyramids at runtime, needs per-fragment longitude/latitude (or a second
projection) with its wrap, pole and derivative problems, and samples several
source pyramids per fragment; preprocessing moves that cost and its resampling
choice to the builder once, at the price of a cube-specific copy of each source.

- **Registration** (`CubeImagery.ts`, `cube_imagery.py`): a tile file is
  `(T + 2g)²` pixels — 256 interior plus a 4-pixel gutter — with integer pixel
  corners: column `i` spans face `u ∈ u0 + [i − g, i − g + 1]·Δ/T`, row `j` (from
  the top) spans `v ∈ v1 − [j − g + 1, j − g]·Δ/T`, centres at `i + 0.5`. Every
  pixel, gutters included, is evaluated at the geocentric direction
  `normalize(N + uU + vV)` of its sample points; beyond a face edge that
  direction lies on the neighbouring face, so gutters carry the neighbour's
  content and filtering across tile and face edges reads continuous imagery.
  Each pixel averages 3×3 samples (box prefilter). Content is registered to the
  geocentric direction, like geometry addressing.
- **Exact face coordinates on the GPU.** For a geometry tile, `s = (p·a)/(p·n)`
  and `t = (p·b)/(p·n)` are its face coordinates mapped to `[0, 1]`
  (`tileProjectiveBasis`). Numerator and denominator are linear in the
  body-fixed position, so the layer stores `(p·a, p·b, p·n)` per vertex and the
  fragment shader divides: exact on every planar triangle, with no longitude,
  wrap or pole case. (Interpolating `(s, t)` itself drifts by > 1 m inside a
  level-0 cell; the unit test shows both.) The attribute costs 12 bytes per
  vertex on every cube tile (51 KB per 65² tile, +50% over position and normal);
  computing it in the vertex shader from a per-tile matrix would avoid that at
  some float32 precision cost, untested here. One `vec4` maps `(s, t)` to the texture
  of whichever imagery tile a block draws, finer or coarser than the geometry.
- **Independent levels.** Per visible geometry tile, `selectImageryBlocks`
  chooses a quadtree cut from projected texel size alone (default 1.5 px per
  texel, gnomonic scale at the block, terrain-camera frustum and distance),
  never from the tile's depth. Imagery coarser than the geometry draws an
  ancestor's sub-rectangle on the tile's own mesh: one draw, no change. Imagery
  finer than the geometry splits the tile into **blocks**: the tile's triangles
  clipped exactly to each imagery tile in 3D (each boundary is a plane through
  the body centre, so clipped vertices lie on the original triangles), each block
  an extra mesh with its texture. The original mesh is hidden but stays the
  picking target; the renderer's tile set, its meshes and its requests do not
  change. This is renderer-internal subdivision, and its cost is extra draws and
  block geometry, measured below.
- **Residency and lifecycle.** One texture LRU for the whole layer, capped by
  estimated GPU bytes (RGBA8 with mipmaps; default 160 MiB) with levels 0–1
  pinned (30 tiles) as the coarse fallback that is never missing. The request
  queue is rebuilt every frame from what visible blocks want (coarse levels
  first), at most 8 in flight, each holding its estimated bytes against the
  budget until it completes, fails or is aborted; a request nobody has wanted
  for 30 frames is aborted; when the budget is full of textures in use, new requests stop
  (`budgetLimited`) and blocks keep their fallback. A failed tile falls back to
  its nearest resident ancestor, is retried after 30 s doubling to 8 min, and
  nothing below it is requested meanwhile. A newly loaded or refined terrain
  tile acquires imagery on its first visible frame. Blocks unused for 120 frames
  are disposed; a disposed tile takes its blocks with it. CPU physical-surface
  queries never read any of this.
- **Contract.** The product carries what `MapImageLayer` asks for — a versioned
  layout id (`cosmolabe:cube-gnomonic-1/IAU_MOON`), the pixel-corner convention,
  footprint/cutline (alpha 0 outside), source provenance and attribution, an
  immutable content-hash version, resampling, level range and budgets — but in
  a tiled face layout that the interface's single affine `pixelToSource` cannot
  express. That interface needs a tiled-layout variant before a second
  implementation adopts it.
- **Config and views.** `TerrainConfig.cubeSphere.imagery = { url }` (plus
  optional texel target, budget, concurrency, resident level, level cap). Three
  unlisted catalogs: `moon-terrain-cube-imagery-{grid,registration,nac}`. Debug
  views `imagery-level` (hue per displayed imagery level) and `imagery-unlit`
  (raw texels, no lighting, tone mapping or colour conversion).

### Fixtures and the real example

`scripts/build-moon-terrain/cube-imagery.sh` builds three pyramids, each with an
`imagery.json` manifest:

| Pyramid | Content | Tiles | MB | Levels / finest texel |
| --- | --- | --- | --- | --- |
| grid | graticules (10°/1°/0.1°/0.01°, crowding meridians thinned near the poles), face edges, bullseye markers (rings 12 km → 12 m, coloured annuli, unique centre colours) at Shackleton, both poles, the antimeridian at 0°/60°S/88°S, the px/nz edge and the px/py/nz corner; `markers.json` gives each marker's expected tile and pixel at every level | 2,301 | 35.2 | all faces to L3 (1.7 km), L13 (1.66 m) at Shackleton and the pole, L10–L11 elsewhere |
| registration | R = interior column, G = interior row from the bottom, B = 32·face + level (linear data) | 2,301 | 1.4 | same tiles |
| nac | LROC NAC South Pole controlled mosaic (1 m, polar stereographic), read by window from the COG overview ≤ 0.4 output samples, 3×3 box; nodata → alpha | 1,022 | 38.8 | L6 over the mosaic, L13 (1.66 m) within 2 km of Shackleton and the pole |

Build: grid fixture 10.4 min, registration fixture 2 s, NAC 10.5 min reading
the remote COG, on the 4-core host. Unlike geometry, imagery does not need REPLACE
completeness: a tile may lack children and fully transparent subtrees are
dropped (NAC: 1,106 → 1,022 tiles).

### Offline gates (`node scripts/validate-cube-imagery.mjs`)

All pass; record in `docs/images/issue-149/imagery-validation.json`.

- Every manifest validates (complete tree, six roots, layout).
- **Builder vs viewer**: all 85 marker placements (each marker at every level
  holding it) land on the same tile and pixel in the Python builder and in the
  compiled `CubeImagery.directionToTexel`, within 9e-11 px. This gate first
  failed on two real defects, both fixed: the builder's exact-angle helper used
  Python's half-to-even `round` where `CubeSphere.ts` uses JavaScript's half-up
  `Math.round`, so the marker at the px/py/nz corner (lon 45°) went to `px` in
  the builder and `py` in the viewer; and the pole marker's outer annulus
  overpainted Shackleton's centre 10 km away.
- **Drawn markers**: annulus centroids within 0.08 px of the expected pixel
  where an annulus fits one file; for all 45 placements with a resolvable
  annulus — including the pole, the face edge, the face corner and the nx-centre
  antimeridian point, which sit on tile corners/edges — the annulus's inner edge
  is equidistant from the marker within 0.78 texel in every direction.
- **Gutters**: same-face neighbours' gutters equal the neighbour's interior pixels
  exactly (795 pairs, 0 counts); across face edges a gutter pixel matches the
  neighbour face resampled at its direction to 4.0 counts mean (3,496 samples; max
  76 on sharp lines, which the two faces' pixel lattices sample differently).

### Rendered evidence (`node scripts/capture-cube-imagery.mjs`)

HeadlessChrome 141, `ANGLE (Vulkan 1.3.0, SwiftShader Device (Subzero))` —
software WebGL, no GPU — on the 4-core host above; 1280×800, DPR 1, `?test=1`
(no antialias, bloom or stars); IAU_MOON body-fixed poses at the catalog epoch,
paused; terrain errorTarget 2; imagery 1.5 px/texel; each experiment on a cold
page. Records and images: [`docs/images/issue-149/`](../images/issue-149/).

**Fixed geometry, imagery refined.** Grid fixture; settle with imagery capped
at level 3, record the renderer's visible tile set, then lift the cap without
moving (`CubeImageryLayer.setOptions`). Across all five locations the visible
geometry tile ids, the mesh objects and the .glb request count are identical
before and after; only imagery tiles are requested.

| View | Geometry tiles (levels) | Tiles / meshes unchanged, new .glb | Imagery level, capped → refined | Imagery requests / MB | To target (s) | Textures / est. MiB | Blocks (extra draws) over split tiles | Block geometry MB | Layer update ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shackleton | 110 (L3–10) | yes / yes, 0 | L3 → L10 | 91 / 4.3 | 8 | 143 / 51 | 191 (+81) over 25 | 11.4 | 1.1 |
| South pole | 75 (L3–8) | yes / yes, 0 | L3 → L10 | 100 / 4.6 | 8 | 143 / 51 | 192 (+117) over 33 | 14.1 | 3.1 |
| Antimeridian 60°S | 75 (L1–4) | yes / yes, 0 | L3 → L8 | 89 / 1.9 | 6 | 208 / 74 | 300 (+225) over 42 | 21.7 | 1.7 |
| px/nz face edge | 177 (L1–7) | yes / yes, 0 | L3 → L8 | 95 / 1.5 | 11 | 215 / 76 | 342 (+165) over 55 | 25.4 | 2.7 |
| px/py/nz face corner | 219 (L1–7) | yes / yes, 0 | L3 → L6 | 102 / 2.1 | 13 | 245 / 87 | 354 (+135) over 43 | 22.0 | 1.7 |

"To target" is SwiftShader wall time from lifting the cap until nothing is in
flight, queued or waiting on a fallback. Texture memory is the layer's estimate
(RGBA8 + mipmaps, 264² per tile) including the 30 pinned tiles. The renderer's
geometry metric at Shackleton (every loaded tile mesh, cached ones included) is
43 MB with imagery capped and 51 MB refined. The extra draws are the block
meshes beyond one per drawn tile; block geometry duplicates the split tiles'
vertices (position, normal, projective coordinates) plus clip vertices. Layer update is
CPU time for selection and block builds in the frame measured, on this host.
Images: `imagery-fixed-{shackleton,pole,antimeridian-60s,face-edge,face-corner}.jpg`
(shaded and `imagery-level`, capped and refined).

**Terrain held coarse.** Grid fixture with the renderer's `maxDepth` set so
the cube geometry stops at level 2 (4 tiles of 64 cells, 13.6 km vertex spacing
at the face centre): imagery still reaches level 10 (13 m texels) at Shackleton
and at the pole, from 190 and 214 blocks on those 4 tiles (+186 / +210 draws,
3.9 / 4.0 MB block geometry, 143 / 165 textures ≈ 51 / 58 MiB, 6.0 / 6.6 MB
imagery requested). Displayed levels span L1–L10 on the same four meshes
(`imagery-frozen-terrain.jpg`: unlit fixture, `imagery-level`, `lod`).

**Rendered registration.** Registration fixture in `imagery-unlit`; a 43 × 34
pixel grid (1,462 samples) is read back from one synchronous canvas frame, each pixel decoded to
(face, level, column, row) and compared with the cube coordinate (via
`CubeSphere.directionToCubeFace`, independent of the layer's shader path) of the
body-fixed point a ray through that pixel's centre hits on the rendered terrain
meshes. Pixels whose filter footprint reaches a tile edge (clamped ramp values or
a neighbour with another tile's B), and sky, are excluded.

| View | Pixels | Error median (texels) | p95 | max | Face / tile mismatches | Imagery levels on screen |
| --- | --- | --- | --- | --- | --- | --- |
| Shackleton | 1,154 | 0.41 | 0.65 | 1.27 | 0 / 0 | 1, 3–10 |
| South pole | 1,403 | 0.41 | 0.70 | 1.00 | 0 / 0 | 1, 3–10 |
| Antimeridian 60°S | 1,422 | 0.41 | 0.67 | 1.06 | 0 / 0 | 1–8 |
| px/nz face edge | 1,421 | 0.41 | 0.66 | 1.01 | 0 / 0 | 1–8 |
| px/py/nz face corner | 1,411 | 0.41 | 0.61 | 1.07 | 0 / 0 | 1–6 |
| Overview (3,000 km) | 489 | 0.51 | 0.90 | 1.24 | 0 / 0 | 1–2 |

An 8-bit ramp decoded to the nearest count has an error uniform in ±0.5 texel
per axis, whose 2D median is 0.38–0.41: the measured distribution is that
quantization, with no offset at the pole, across ±180°, at the face edge or the
face corner, and with mixed imagery levels in every view (`imagery-registration-unlit.jpg`).
In metres the error scales with the displayed texel (13 m at L10 near
Shackleton, up to ~3 km for L2 texels on the horizon of the overview).

**Rendered markers.** Grid fixture in `imagery-unlit`, camera 14 km above each
marker: the marker-coloured pixels inside its 0.75 km ring (its 0.21–0.675 km
annulus, inner rings and centre) compared with the projection of its
body-fixed centre on the CPU-sampled surface (screen centroid), and those
pixels ray-cast onto the rendered terrain, footprint-weighted, in the marker's
tangent plane (ground centroid, free of the perspective bias relief adds).

| Marker | Imagery level | Pixels | Screen centroid error (px) | Ground centroid error (m) |
| --- | --- | --- | --- | --- |
| Shackleton (89.67°S 129.78°E) | L10 (13 m) | 1,960 | 0.07 | 1.8 |
| South pole (on Shackleton's rim) | L10 | 3,435 | 0.18 | 8.0 |
| Antimeridian 88°S | L8 (53 m) | 1,887 | 0.48 | 4.4 |
| Antimeridian 60°S | L9 (27 m) | 1,335 | 0.04 | 1.0 |
| Antimeridian at the equator (nx centre) | L10 | 4,503 | 0.10 | 0.2 |
| px/nz edge (45°S 0°) | L9 | 2,581 | 0.05 | 2.3 |
| px/py/nz corner (35.26°S 45°E) | L9 | 3,042 | 0.01 | 2.2 |

Every marker lands within a fraction of a displayed texel of its body-fixed
location. A first version cut at the 3 km ring and measured 8.7 px at the pole:
on the rim's 1–2 km of relief that window reached into the pole's outer
annulus on the downslope side — a measurement error, fixed by the tighter cut.

**Failed requests.** Grid fixture at the Shackleton pose with every request
for level ≥ 7 failing (Playwright route abort): imagery stays at L≤6 with no
untextured block; 69 requests failed — one per failing tile at the first failing
level, nothing requested below them — and 89 visible blocks report a failed
fallback (0 waiting); no request in the following 5 s (retry backoff from 30 s).
Settled in 9 s (`imagery-failure.jpg`). The first version of this experiment
exposed two defects, both fixed: the layer descended below failed tiles (1,539
failed requests) and retried every failed tile every 30 s; it now prunes failed
branches and backs off per tile up to 8 min.

**Navigation, refinement and eviction.** One warm page under a 64 MiB texture
budget (below what one view at the face corner wants): pole → Shackleton →
antimeridian 60°S → face edge → face corner → orbit → Shackleton → pole, then
five zoom cycles 0.3 → 3,000 → 0.3 km over Shackleton (59 samples). Resident
textures never exceeded the budget (≤ 180 tiles, 63.8 MiB, 30 pinned), 1,646
evictions and 1,826 requests in all; queued requests stayed bounded (≤ 113) and
drained to 0 whenever the camera rested; at the face edge and corner the layer
was budget-limited, kept fallbacks and requested nothing more; returning to
Shackleton refined to L10 again. No request was aborted (local requests finish
within the 30 frames before an unwanted request is aborted; the unit test
exercises aborts). Layer update stayed 0.5–8 ms per frame on this host (one
33 ms outlier). Record: `imagery-captures.json` → `navigation`.

Two earlier capture runs on this host stalled their page's frame loop part-way
(terrain and imagery counters frozen, no console error). Neither stall reproduced
in four targeted reruns, including this navigation path and the failure case. The
layer update is now wrapped so an imagery exception logs once and cannot stop terrain
streaming or the frame loop; the stall is recorded as unexplained SwiftShader-host
behaviour, not as fixed.

**Real imagery: LROC NAC south-pole mosaic.** Same poses, cold page each:

| View | Geometry tiles (levels) | Imagery to | Imagery requests / MB | To target (s) | Textures / est. MiB | Blocks (extra draws) | Block geometry MB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Shackleton | 110 (L3–10) | L10 | 139 / 5.8 | 10 | 139 / 49 | 203 (+93) | 14.8 |
| South pole | 75 (L3–8) | L10 | 122 / 5.0 | 7 | 122 / 43 | 183 (+108) | 14.3 |
| Footprint from 450 km | 81 (L1–4) | L5 | 34 / 0.7 | 7 | 34 / 12 | 96 (+15) | 5.4 |

The mosaic lands on the terrain without visible misregistration: the sunlit
rim band and the small craters sit on their relief (`imagery-nac.jpg`). Attribution
of what remains, by comparing with the source in its native projection
(`imagery-nac-source.jpg`, read directly from the COG) and with the grid fixture
at the same poses:

- **Source**: Shackleton's floor and other permanently shadowed regions are black
  (no illumination, not nodata), and adjacent mosaic patches differ in
  illumination and brightness; both appear identically in the native crops.
  The catalog's sun lights the already-shadowed image a second time, so shaded
  views look darker than the unlit ones.
- **Footprint**: outside 81.5°S the layer is transparent by its cutline and the
  terrain's own shading shows; the square edge in the 450 km view is the
  mosaic's polar-stereographic extent, not a tile seam.
- **Mapping**: no seam, smear or offset at the pole, along ±180° or between
  imagery levels; the same places in the grid fixture are continuous, and the
  registration fixture measures them at quantization level. The few dark specks
  along some geometry tile edges (visible in the fixture frames too) are the
  product's mixed-LOD cracks — it ships without skirts — not imagery.

### Hardware GPU (2026-10-14, Apple M4 Max)

The same script with `--gpu`: Chrome 148 headless, `ANGLE (Apple, ANGLE Metal
Renderer: Apple M4 Max)`, 16-core CPU, 48 GB, macOS 26; same poses, epoch and
settings. Record: [`imagery-gpu-captures.json`](../images/issue-149/imagery-gpu-captures.json).

**Correctness repeats on Metal.** Fixed geometry: all five views keep identical
tiles and meshes with 0 new .glb, imagery reaching the same levels (L10/L10/L8/L8/L6)
in 4 s each. Terrain held at L2: imagery to L10 at Shackleton and the pole.
Registration: median 0.41 texel in all five ground views (0.52 overview),
p95 ≤ 0.94, 0 face/tile mismatches; worst pixel ≤ 1.29 texels everywhere except one
2.77-texel pixel at Shackleton (p95 there 0.66 as in software; traced below to
filtering at grazing incidence). Markers:
screen centroids ≤ 0.47 px, ground centroids 0.0–8.2 m. Failure: 72 failed
requests, imagery held at L6, 0 untextured blocks, no retries in 5 s. Navigation
under 64 MiB (in-flight requests now reserved): ≤ 180 textures, 63.8 MiB, 1,842
evictions, 2,022 requests, queues ≤ 83 and drained at rest, layer update ≤ 0.9 ms.

**Frame cost.** Per view, warm: terrain only (the cube catalog without imagery),
imagery with no split tiles (capped at L0: one draw per tile), imagery refined.
120 back-to-back `renderFrame` calls, each fenced by a 1-pixel `readPixels` (wall
time including GPU completion, not vsync), with `EXT_disjoint_timer_query_webgl2`
around each (GPU time). Medians, ms; draws per frame.

| View (1280×800) | Draws: terrain / whole / refined | Wall: terrain / whole / refined | GPU: terrain / whole / refined | Blocks, block MB |
| --- | --- | --- | --- | --- |
| Shackleton | 115 / 115 / 196 | 1.8 / 3.3 / 3.8 | 0.53 / 1.09 / 1.09 | 191, 7.9 |
| South pole | 80 / 80 / 197 | 1.6 / 2.4 / 3.9 | 0.48 / 1.34 / 1.43 | 192, 10.5 |
| Antimeridian 60°S | 80 / 80 / 305 | 1.6 / 2.0 / 4.4 | 0.83 / 0.99 / 1.11 | 300, 13.6 |
| px/nz face edge | 184 / 184 / 349 | 4.7 / 5.6 / 7.2 | 2.15 / 2.68 / 2.80 | 342, 17.2 |
| px/py/nz face corner | 224 / 224 / 359 | 5.6 / 3.0 / 3.7 | 2.70 / 0.78 / 0.90 | 354, 13.5 |
| Overview | 20 / 20 / 62 | 1.0 / 1.3 / 1.6 | 0.55 / 0.58 / 0.62 | 57, 4.1 |
| **2560×1600** Shackleton | 199 / 199 / 295 | 2.0 / 4.2 / 3.9 | 0.75 / 1.78 / 1.12 | 290, 9.4 |
| Antimeridian 60°S | 185 / 185 / 518 | 3.9 / 2.9 / 5.4 | 2.09 / 0.56 / 0.72 | 513, 22.1 |
| px/nz face edge | 355 / 355 / 568 | 4.5 / 5.5 / 7.3 | 1.50 / 1.77 / 1.88 | 561, 22.3 |
| px/py/nz face corner | 416 / 416 / 614 | 5.1 / 6.4 / 8.1 | 1.48 / 1.82 / 1.96 | 609, 20.7 |
| **NAC**, 1280×800 Shackleton | 115 / 115 / 208 | 2.1 / 1.7 / 2.3 | 0.74 / 0.47 / 0.51 | 203, 8.9 |
| NAC pole | 80 / 80 / 188 | 1.8 / 1.3 / 2.5 | 0.62 / 0.40 / 0.42 | 183, 9.0 |

(2560×1600 pole and overview, p95s and all counts are in the record.)

Reading it: the comparison that isolates blocks is *whole → refined*, measured on
one page with the same tiles. Blocks add 0–0.45 ms of GPU time (median) and
0.4–2.5 ms of wall time, i.e. the cost is mostly CPU-side submission of the 1.5–3×
draws plus the layer's selection (≤ 1.1 ms), not fill or vertex work. *Terrain →
whole* crosses pages and is noisier than the effect (the face-corner and
antimeridian rows run faster with imagery than without), so it bounds the
texture-sampling cost only loosely. Every refined frame stayed under 8.3 ms median
(120 Hz) at 1280×800 and under 10.4 ms p95 at 2560×1600.

Limits: one high-end integrated GPU; `performance.now()` resolves 0.1 ms here;
`readPixels` fencing serializes CPU and GPU, so wall time overstates a pipelined
frame; no thermal soak. On weaker GPUs or with many more tiles the draw count is the
first thing to watch, and the mitigations under *What this proves* (shared vertex
buffers with index-only blocks, or one composited texture per tile) cut exactly it.

**The 2.77-texel registration outlier (follow-up from #184).** The Metal run
reproduces it exactly, and the registration experiment now records its worst
samples (`imagery-gpu-registration.json` → `worstSamples`): pixel (629, 204) of
the Shackleton frame, imagery `nz/8` tile (127, 127) — the tile with the pole at
its corner — decoded (R, G) = (75, 22) against an expected (74.75, 19.24), so
the error is 2.76 texels along the tile's row axis. What it is not:

- *Measurement against the wrong surface*: the four neighbouring pixels'
  ray-cast distances agree within 5% (no silhouette or depth step), and the hit
  is on surface triangles, not a skirt.
- *Rasterization or mapping*: the dense 9×9 error map around it is 0.07–0.83
  texels everywhere except three adjacent pixels of one screen row (1.51, 2.77,
  3.25); a mapping or rasterization offset would not be confined to one row of
  a smooth surface, and every other view stays ≤ 1.2 texels.

What it is: **filtering at grazing incidence**. The ray meets the surface at
cos 0.012 (89.3° from the normal); one screen row there spans ~8 texels of the
ramp (G goes 244 → 22 → 30 across the 3×3 neighbourhood, the row above already
in the next imagery tile). The hardware's anisotropic, mipmapped filter
averages the ramp over that long, perspective-skewed footprint — reaching the
tile's gutter — and the decoded value is the footprint mean, compared with the
point value at the pixel centre. 2.76 texels is a third of that footprint,
sub-pixel on screen; SwiftShader's filter gives ≤ 1.27 at the same pose. The
measurement excludes pixels whose immediate neighbours change imagery tile, but
not footprints this long; a stricter exclusion (screen-space derivative above a
few texels per pixel) would drop it. **No change to registration.**

### What this proves, and what it does not

Proven here, on software rendering and repeated on one hardware GPU:

- The cube layout supports map imagery whose level, requests and residency are
  independent of geometry: the same tile set and meshes show imagery from level 1
  to level 10, and terrain held at level 2 shows level-10 imagery.
- Face-aware projective texture coordinates register imagery to body-fixed
  directions at quantization level across the exact pole, ±180°, face edges and
  corners and mixed imagery levels, rendered and read back; the builder and the
  viewer agree on every control point. Gutters keep tile and face edges
  continuous under filtering.
- Loading is bounded: a byte budget with pinned coarse levels, a per-frame
  request set with a concurrency cap and aborts, failure fallback with backoff,
  block disposal. Coarse coverage is never missing once levels 0–1 load, and CPU
  surface queries are untouched.
- A real, controlled lunar mosaic drapes correctly; its visible artifacts are
  the source's (permanent shadow, mosaic illumination) and the terrain's (cracks).

Not established, and why it matters:

- **Cost beyond one GPU.** On an M4 Max (*Hardware GPU*) blocks cost ≤ 0.45 ms
  GPU and ≤ 2.5 ms wall per frame, mostly draw submission. Lower-end and discrete
  GPUs, other ANGLE backends and denser views are unmeasured; if the draw count
  matters there, the block geometry can share the tile's vertex buffer (index-only
  cell-aligned blocks) or composite into one texture per draw.
- **Whether the layout wins.** Nothing here compares imagery on the geographic
  or polar baselines. The upstream overlay works there today (with its terrain-depth
  cap, #136) and #147 covers the polar cap; a fair comparison needs matched
  imagery quality on all three.
- **A real global source.** The NAC mosaic covers 81.5°S and poleward. A global
  layer (e.g. LROC WAC 100 m, available on the same mirror) would also exercise
  equirectangular source smearing near the poles, which #147 attributes to that
  source.
- **Contract.** `MapImageLayer` needs a tiled-layout variant to describe this
  product rather than an affine raster.

## Mixed-LOD crack mitigation (2026-10-14)

The #178 product shipped without skirts so its cracks could be measured. The
geometry is unchanged here (the CPU height grids hash identically before and
after the rebuild); this slice chooses and implements how the rendered surface
closes them.

### Where the gaps come from

A tile edge meets a coarser tile along a line on which its own ancestor at
that level also has an edge, and same-level shared vertices are bit-identical
across tiles, faces and corners (*Boundary policy*). The coarse neighbour's edge
is therefore exactly the fine tile's ancestor's edge, on the same face or not.
Two things differ along it: the T-junction vertices the coarse chord lacks, and
the coincident vertices, which the coarse level sampled at its own spacing and
source level (point-sampled LOLA at coarse levels, *Measured results*). Both are
honest representation differences, not datum or source discontinuities: the
fused field is continuous and every level samples it.

Enumerated over the whole product (`cube_skirt_gaps`, independently re-derived
by the validator): 18,180 mixed-level edge pairs, 2,328 across faces, at level
differences 1 to 11 (8,044 / 4,000 / 1,932 at Δ1/2/3; 134 at Δ11 — level-12
tiles beside the level-1 tiles across the face-centre lines through the pole).
Radial gaps reach 3.6 km against levels 0–2 and 18 m at Δ1 between levels 11
and 12. At runtime the renderer's visible sets were milder: Δ ≤ 2 in every
captured view and in all 140 steps of the dynamic paths below, Δ2 present in
most views (cross-face Δ2 at the px/nz edge).

### Options compared

| | Skirts | Constrained boundary vertices (stitching) | Geomorphing |
| --- | --- | --- | --- |
| What it needs | A wall under each edge, deep enough for any neighbour the product allows | Each frame, every visible tile's neighbour level per edge, then moving its edge vertices onto the coarser chord | A per-vertex morph target (the parent surface at that point) and a morph factor that agrees at shared vertices |
| Neighbour levels | None at runtime. Depth from the product's own level pairs, computed offline | Runtime neighbour graph across faces and corners (orientation flips), and Δ > 1: classic stitching assumes a restricted (Δ ≤ 1) quadtree, which 3d-tiles-renderer does not enforce (Δ2 is common above) | Factors from distance agree only if LOD selection is per-vertex distance (CDLOD); 3d-tiles-renderer selects per tile by screen-space error on bounding volumes, so neighbours morph inconsistently |
| Streaming / fallback | Any mix of product tiles is covered, including parent fallback, failures and eviction | Re-stitch whenever a neighbour loads, fails or is evicted; parent fallback changes the neighbour mid-frame | Morph state per tile across loads; a fallback parent has no morph target |
| Rendered vs CPU surface | Surface vertices untouched; walls only where there is a gap | The rendered edge moves by up to the gap and depends on what is loaded: picks differ frame to frame | The rendered surface is time-varying between two levels: CPU samples agree with neither during a morph |
| Extra geometry | 4·64·2 triangles, 4·65 vertices per tile (+6.25% / +6.2%) | None (CPU buffer rewrites or a vertex-shader path with per-edge state) | One extra height (or position) per vertex, +4–12 bytes |
| Grazing angles | The visible part of a wall is bounded by the gap (below, the lower neighbour hides it; from the higher side, its own surface does) | None | Visible popping is reduced; cracks still need one of the others |
| Upstream | Already the renderer's convention: the quantized-mesh plugin adds skirts to the geographic baseline and the polar cap has them | No support | No support |

Prototyping limited to what decides: the neighbour-level census (above, and per
capture) rules out Δ ≤ 1 stitching without new runtime machinery; per-tile
screen-space error rules out consistent geomorphing; the product-wide gap
enumeration shows skirt depths can be fixed offline for every combination.
**Selected: skirts sized per edge from measured gaps.**

### Implementation

- **Builder** (`dem.py cube-tile`, now two passes): pass 1 samples heights,
  normals and CPU grids as before; `cube_skirt_gaps` then walks every tile edge
  against each coarser level (via `cube_tile_at`, so face edges and corners need
  no special case, stopping where the edge becomes interior to the ancestor) and
  measures the radial gap along each fine vertex ray against the coarse chord in
  their common great-circle plane, charging positive gaps to the fine tile's
  edge and negative ones to the coarse tile's edge on that line; pass 2 writes
  each `.glb` with a skirt per edge of 1.25 × its largest gap + 0.1 vertex
  spacing (the floor also covers rasterization at gap-free T-junctions), radial,
  with the edge normals. Surface triangles come first and the primitive carries
  `extras.surfaceTriangles` (8,192). `--skirt-cells 0` builds without skirts.
  Mean depth falls from 8.0 km at level 0 to 11 m at level 12; the maximum at
  level 12 is 1.38 km on the 134 Δ11 edges at the pole lines, which the renderer
  has not been seen to produce but the product allows.
- **Viewer**: `TerrainConfig.cubeSphere.skirts` (default true) and
  `TerrainManager.setCubeSkirts(visible)` set each tile's draw range to all or
  only the surface triangles: one product, and an unmitigated mode for diagnosis
  that also stops ray casts hitting skirts (three.js honours draw ranges).
- **Imagery**: gnomonic projective coordinates `(p·a, p·b, p·n)` are invariant
  along a radial line, so a skirt carries exactly its edge's texels — imagery
  runs straight down the wall. Two layer fixes were needed: blocks clip only the
  triangles the tile draws (its draw range), and a block side lying on the tile's
  own boundary is no longer clipped, because skirts lie exactly in that plane and
  float32 rounding decided whether their triangles survived — the unit test
  shows 23% of skirt area dropped without the fix, which would have reopened
  cracks wherever imagery splits a tile. Texel distances use the surface
  vertices' radius range, not the skirts'.
- **Physical surface**: CPU grids and `CubeGridSurface` rebuild triangles from
  the height grids, never from `.glb`, so skirts are excluded from samples,
  readouts, clamping, ray queries and clearance by construction. Rendered
  picking *can* hit a skirt — it is what the pixel shows through a gap — and
  `pickSurface` now reports `renderedSkirt`; its `physical` answer is the CPU
  surface as before. Mitigation does not touch surface vertices, so it cannot
  hide a datum or source discontinuity: those would still show in the CPU grids,
  the crack metrics and the shared-vertex gates.

### Validation (`node scripts/validate-cube-terrain.mjs`)

All previous gates pass on the rebuilt product with identical results (shared
vertices, REPLACE completeness, ownership, control points RMS 6.85 m / max
17.5 m, 120 picks matching the emitted triangles to < 1 mm, clearance). New:

- **Skirt shape**: every skirt vertex radially below its edge vertex, one depth
  per edge, edge normals; 8,192 surface triangles then 512 skirt triangles.
- **Coverage**: at all 1,181,700 fine-edge samples of the 18,180 mixed-level
  pairs, the higher side's skirt (read back from the `.glb`) reaches the lower
  edge; 0 uncovered, minimum margin 1.4 m. Halving the read-back depths makes
  the gate fail on 21,964 samples.
- **Bounds**: every vertex, skirts included, inside its content box, node box
  and all ancestors' boxes. Visible tile counts and levels at the #184 poses are
  unchanged (110 / 75 / 177 / 219 tiles), so the deeper boxes did not alter
  selection there.
- **Boundary picks and clearance**: 144 rays (0–60° off nadir from 2 km) at the
  worst-gap vertex of the 36 worst mixed-level edges (fine levels 7–12, same- and
  cross-face, gaps 1.6–2.4 km): 69 would pass through the crack without skirts;
  with skirts 73 hit a skirt, and those land within 5.2 m (p95 4.4 m) of the CPU
  hit. A #148 camera placed 50 m along the CPU normal stays ≥ 36.4 m above the
  rendered pair (fine tile + coarse neighbour) below it.

### Rendered evidence (`capture-cube-imagery.mjs --experiments cracks,cracks-dynamic,skirt-cost --gpu`)

Apple M4 Max, Chrome 148, ANGLE Metal, 1280×800, DPR 1, same epoch and
settings as *Hardware GPU*. **Geometric holes are measured separately from
shading and texture**: after each capture the visible terrain alone is drawn
unlit white on black twice in one task — as displayed (skirts, imagery
blocks) and as the same tiles' surface triangles only — and black pixels not
connected to the image border are holes. Shading or texture seams cannot
appear in that mask; a hole touching the horizon silhouette is counted as
background (an undercount, conservative for the unmitigated column only).
Montages show the unmitigated frame with its holes in magenta beside the
mitigated one, with a 4× inset of the densest hole window under each
(`cracks-*.jpg`; unlit — `cube-face` hues for terrain, raw texels for imagery —
because some poses are in lunar night).

| View (finished detail) | Visible tiles (levels) | Neighbour Δlevel samples 1 / 2 (cross-face) | Holes without skirts: px / regions | With skirts | Triangles +% |
| --- | --- | --- | --- | --- | --- |
| Shackleton oblique | 110 (L3–10) | 1,712 / 224 | 105 / 88 | 0 | 5.8 |
| Shackleton grazing (rim, 0.4 km) | 134 (L3–12) | 2,224 / 224 | 79 / 71 | 0 | 5.9 |
| Shackleton near ground (0.15 km) | 112 (L3–12) | 1,744 / 48 | 58 / 50 | 0 | 5.8 |
| South pole | 75 (L3–8) | 1,296 / 32 | 52 / 37 | 0 | 5.7 |
| Pole grazing (0.5 km, across the pole) | 119 (L3–11) | 1,936 / 160 | 38 / 21 | 0 | 5.7 |
| px/nz face edge | 177 (L1–7) | 2,080 / 192 (448 Δ1) | 36 / 36 | 0 | 5.9 |
| Edge grazing (1 km) | 113 (L0–8) | 1,664 / 192 (64 Δ2) | 0 / 0 | 0 | 5.7 |
| px/py/nz face corner | 219 (L1–7) | 2,496 / 0 (288 Δ1) | 6 / 6 | 0 | 6.0 |
| Corner grazing (1.5 km) | 177 (L1–8) | 2,096 / 352 (192 Δ1) | 1 / 1 | 0 | 5.9 |

Terrain only; the grid fixture and the NAC mosaic give the same hole counts at
the same poses (imagery does not change the geometry), and 0 holes with skirts
— including through imagery blocks, the path the clipping fix repaired. At rest
the unmitigated cracks are specks (≤ 105 pixels per frame at errorTarget 2),
which is why they read as background flecks rather than lines.

Picks on unmitigated hole pixels with skirts drawn hit a skirt in 419 of 422
cases (all views and catalogs). Their physical answer differs from the rendered hit by the same amount
as on surface pixels 3 px away (Shackleton median 6.8 vs 15.7 m; pole 283 vs
346 m, max 2.64 vs 2.63 km on grazing rays): that offset is the coarse rendered
level against the finest CPU grid, present with or without a crack.

**While refining, coarsening and moving** (grid fixture, one page per scenario,
35 steps: 3,000 km → Shackleton without waiting for detail, out to 600 km, then
pole → face edge → face corner at 50 km; holes measured at each step):

| Scenario | Steps with holes without skirts (max px) | With skirts | Notes |
| --- | --- | --- | --- |
| Normal | 25 (105) | 0 | 737 requests |
| Child `.glb` (level ≥ 6) delayed 2.5 s | 22 (134) | 0 | 18 steps still loading, up to 161 queued: parent fallback throughout |
| Child `.glb` (level ≥ 9) failing | 25 (85) | 0 | 52 failed loads; Shackleton held at level 8 |
| Tile cache 24–40 MB (evicting) | 25 (105) | 0 | cache held at ~25 MB, 60 re-requests of evicted tiles |

**Cost.** Same draws (skirts are in the tile's own buffers). Triangles
+5.7–6.0% per view (+4% in the overview, where level-0 tiles have proportionally
fewer edge cells drawn). Geometry +9.3 KB per tile before imagery (260 vertices ×
24 B + 512 triangles × 6 B), +3.1 KB with the imagery attribute; the product's
`.glb` bytes +6.2% (611 → 648 MB). GPU time per frame, medians on one page,
surface only → skirts (→ skirts again): −0.05 to +0.13 ms across twelve
view/catalog pairs, within the repeat's own spread in several (full p95s in
`crack-gpu-captures.json`); wall time +0 to +0.4 ms. Build: 1 min 43 s on 14
workers vs 1 min 26 s for the #178 builder on the same host; the gap pass itself
is 4.3 s. No runtime work beyond a draw-range assignment per loaded tile.

**Seams that remain are not geometry.** With skirts, a wall shades with its
edge normal and carries its edge's texels, so where a crack was the frame shows
the edge colour stretched over at most the gap. Remaining visible lines in
shaded frames are level transitions in shading (normals sampled at different
spacings) and imagery-level boundaries; neither appears in the hole mask.

**Skirts drawn through nearer surface (found in review, fixed outside this
slice).** Low grazing views showed skirts as streaked bands along fine/coarse
boundaries and speckle along crater rims. Those views were 1–4 km from the
surface, at the pole and at a rim near 88° S. The geometry is right: exact
ray-casts at those pixels hit surface triangles, on the original tiles and on
the imagery blocks alike. The fault is depth precision. The main pass uses
three.js log depth, `log2(1 + w)` with `w` in scene units (1e-6 per km), so
near the ground `1.0 + w` in float32 resolves ~120 m and the 24-bit buffer
~0.8 km. A skirt a few hundred metres behind the surface ties with it in depth,
and draw order picks the winner. The hole mask cannot see this, because the
surface is there either way. `cracks` now also draws the visible tiles with
surface triangles white and skirts red, then ray-casts a sample of the red pixels
(all of them here). A red pixel whose nearest hit is a surface triangle is a skirt
drawn through the surface. The same captures with the log-depth precision fix
(#189, `packages/three/src/LogDepth.ts`: `w` scaled to metres before the log),
first emulated by serving patched three.js chunks, then on the merged code:

| View (terrain; grid and NAC identical) | Skirt pixels drawn through surface, three's log depth | With the fix | Skirt pixels with the fix |
| --- | --- | --- | --- |
| Shackleton oblique | 5,157 | 0 | 111 |
| Shackleton grazing | 6,040 | 1 | 102 |
| Shackleton near ground | 13,149 | 1 | 75 |
| South pole | 5,357 | 0 | 52 |
| Pole grazing | 8,923 | 2 | 48 |
| Pole, 1 km up (reported) | 22,178 | 2 | 53 |
| Rim near 88° S, 1.7 km up (reported) | 13,899 | 0 | 83 |
| px/nz face edge | 2,474 | 3 | 38 |
| Edge grazing | 4,199 | 0 | 3 |
| px/py/nz face corner | 2,725 | 2 | 10 |
| Corner grazing | 9,390 | 0 | 2 |

Per-view rows for all three catalogs are in `crack-skirt-bleed.json`. With the
fix, visible skirt pixels drop to about the unmitigated hole counts:
skirts show only where they fill cracks. The 1–3 pixels left per frame have
not been examined. The depth problem affects any terrain on that pass that
relies on the depth test to stay hidden, not only skirts. #184's code shows the
same bands on a skirted product, because it cannot hide skirts. The cube layout
should not be adopted without the fix, which is now on main. After merging main
(2026-10-14) the same captures on the real code give the same counts as the
emulation (Shackleton 0, pole 1 km up 2, rim 0; terrain and NAC).

## Layout comparison: geometry (2026-10-14)

`node scripts/capture-cube-imagery.mjs --gpu --experiments compare` loads the
three products — cube, the #145 polar cap and the #48 geographic quantized-mesh
pyramid, all sampled from the same fused field (`dem.py field_heights`) — from
identical IAU_MOON poses on a cold page each, waits for finished detail, then
times 240 warm frames. Same viewer, viewport (1280×800, DPR 1), epoch,
lighting, tile cache (512 MiB, the TerrainManager default for all three), fade
off, Apple M4 Max as in *Hardware GPU*. Records: `comparison-gpu-captures.json`.

**What is matched, and how.**

- *Surface detail.* The products define geometric error differently per vertex
  spacing: cube 0.25 (`dem.py`), geographic ≈ 0.25 (QuantizedMeshPlugin
  `πR / (4·65·2^z)` against a `πR / (64·2^z)` latitude spacing), polar cap
  0.125. Equal errorTarget therefore leaves the cap about one level coarser
  (Shackleton: cube L9 106 m, cap L4 195 m at errorTarget 2). The comparison
  runs the cap at errorTarget 1 and the others at 2, and records the level and
  nominal vertex spacing of the tile under the screen centre. That matches
  Shackleton, Shackleton-grazing and pole-grazing to within 10%; at the pole and
  cap-nadir the cap is still about 2× finer at the centre, so the cube was also
  run at errorTarget 1 (*bracket* rows). The geographic spacing given is along
  the meridian; across it, polar tiles are slivers far finer than that.
- *Far-field coverage.* The cube and geographic products are global, the cap a
  200 km square. Each capture measures the fraction of the frame covered by
  terrain (the hole-mask pass): on every near-ground, grazing and cap-nadir pose
  the cap covers the same pixels as the global products (57–100%; the horizon is
  within the cap), so those rows compare like with like; at Shackleton the cap
  misses a 1% horizon sliver, and the overview (cap 0% vs 34%) is not a cap
  comparison at all.
- *Imagery.* None: no baseline has a matched imagery product yet, so these are
  geometry-layout costs only. Cube imagery costs are in *Hardware GPU*.
- *Encoding, not layout.* The cube and cap ship the full 65² lattice; the
  geographic tiles are RTIN-simplified quantized meshes (error 0.1 × spacing).
  Triangle counts therefore mix layout with encoding; tiles and draws do not.

**Warm frames and memory at finished detail** (240 frames; wall time fenced by
`readPixels`, GPU by `EXT_disjoint_timer_query_webgl2`; median / p95 ms):

| View | Product | Centre level (spacing) | Terrain in frame | Visible tiles | Draws / triangles | Geometry MB | Wall | GPU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shackleton oblique | cube | L9 (106 m) | 82% | 110 | 115 / 1.02 M | 32 | 1.3 / 2.7 | 0.39 / 1.66 |
|  | polar cap (eT 1) | L5 (98 m) | 81% | 142 | 147 / 1.30 M | 30 | 1.9 / 3.8 | 0.51 / 2.11 |
|  | geographic | L9 (167 m) | 82% | 2,495 | 2,500 / 4.38 M | 174 | 25.8 / 30.0 | 5.58 / 9.01 |
| Shackleton grazing | cube | L9 (106 m) | 57% | 134 | 139 / 1.23 M | 35 | 1.5 / 3.0 | 0.43 / 1.88 |
|  | polar cap (eT 1) | L5 (98 m) | 57% | 163 | 168 / 1.48 M | 35 | 1.6 / 2.8 | 0.59 / 1.37 |
|  | geographic | L9 (167 m) | 57% | 3,193 | 3,198 / 5.53 M | 220 | 32.1 / 36.4 | 6.00 / 9.82 |
| South pole | cube | L8 (212 m) | 100% | 75 | 80 / 0.72 M | 23 | 1.0 / 2.0 | 0.30 / 1.14 |
|  | polar cap (eT 1) | L5 (98 m) | 100% | 103 | 108 / 0.96 M | 22 | 1.2 / 3.1 | 0.40 / 1.73 |
|  | geographic | L9 (167 m) | 100% | 3,244 | 3,249 / 5.51 M | 222 | 33.3 / 38.1 | 6.81 / 9.51 |
| Pole grazing | cube | L11 (27 m) | 61% | 119 | 126 / 1.13 M | 31 | 1.3 / 2.9 | 0.39 / 1.69 |
|  | polar cap (eT 1) | L7 (24 m) | 61% | 179 | 186 / 1.65 M | 38 | 1.8 / 3.3 | 0.59 / 1.46 |
|  | geographic | L10 (83 m) | 61% | 5,446 | 5,453 / 8.87 M | 389 | 56.9 / 67.4 | 8.23 / 17.22 |
| Cap nadir (40 km) | cube | L7 (424 m) | 100% | 117 | 122 / 1.08 M | 29 | 1.2 / 2.6 | 0.32 / 1.46 |
|  | polar cap (eT 1) | L4 (195 m) | 100% | 52 | 57 / 0.52 M | 11 | 0.9 / 1.8 | 0.23 / 0.96 |
|  | geographic | L7 (666 m) | 100% | 764 | 769 / 1.64 M | 60 | 6.4 / 9.2 | 1.08 / 3.71 |
| px/py/nz corner | cube | L7 (424 m) | 100% | 219 | 224 / 1.97 M | 53 | 2.3 / 4.7 | 0.65 / 2.86 |
|  | geographic | L7 (666 m) | 100% | 107 | 112 / 0.37 M | 16 | 1.6 / 1.9 | 0.61 / 0.62 |
| Overview (3,000 km) | cube | L1 (27,147 m) | 34% | 15 | 20 / 0.20 M | 14 | 0.7 / 1.1 | 0.17 / 0.50 |
|  | polar cap (eT 1) | — | 0% | 4 | 9 / 0.10 M | 1 | 0.6 / 0.7 | 0.20 / 0.21 |
|  | geographic | L1 (42,642 m) | 33% | 14 | 19 / 0.10 M | 12 | 0.7 / 0.9 | 0.28 / 0.30 |

Reading it:

- **Pole and Shackleton: the cube against geographic.** Geographic tiles at the
  pole are slivers (#144). At the four near-ground poses within 0.6° of the pole
  the geographic pyramid draws 23–46× the cube's tiles and draws, 4.3–7.8× its
  triangles and 5–13× its geometry memory; warm frames cost 20–44× the wall time
  (25.8–56.9 ms median, below 30 Hz at pole-grazing) and 14–23× the GPU time. At
  cap-nadir (40 km up, 0.5° from the pole) it is 6.5× the tiles, 5× the wall and
  3.4× the GPU time. Its centre detail is similar or coarser along the meridian
  (167 vs 106 m at Shackleton) and its triangles are already simplified, so this
  is the layout, not the encoding.
- **Pole region: the cube against the polar cap**, and **mid-latitudes**: a
  single centre tile is too weak a detail match to decide these (the cap's
  centre was 2× finer at the pole and cap-nadir); see the achieved-error sweep
  below, which supersedes these rows for both comparisons.
- **Overview.** All three are cheap (≤ 0.3 ms GPU); the cap shows almost nothing.

**Cost at equal achieved surface error.** Matching by the tile under the
centre is weak, so a second pass measures detail across the frame: a 32×20
pixel grid is ray-cast onto each product's rendered meshes, and every hit is
scored against the fused field itself — `dem.py field-error` evaluates
`field_heights` at its finest source level along the hit's geocentric ray, the
function all three builders sample, so the only difference left is level of
detail. Signed errors centre on zero for all three products (medians within
±2.3 m), so the absolute error is LOD spread, not a datum or registration
bias. Each product was swept over errorTarget (cube and geographic 1, 2, 4; cap
0.5, 1, 2), 120 warm frames each; record `comparison-gpu-sweep.json`.

| View | Product, errorTarget | \|rendered − field\| median / p95 (m) | Visible tiles | Triangles (M) | Geometry MB | Wall median (ms) | GPU median (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Shackleton oblique | cube 1 | 0.63 / 4.7 | 194 | 1.75 | 48 | 2.3 | 0.65 |
|  | cube 2 | 1.08 / 9.6 | 110 | 1.02 | 31 | 1.6 | 0.43 |
|  | cube 4 | 2.04 / 18.8 | 68 | 0.66 | 24 | 0.9 | 0.24 |
|  | polar 0.5 | 0.30 / 2.3 | 349 | 3.10 | 74 | 3.6 | 1.18 |
|  | polar 1 | 0.69 / 4.5 | 142 | 1.30 | 30 | 1.8 | 0.51 |
|  | polar 2 | 1.22 / 10.2 | 76 | 0.73 | 16 | 1.0 | 0.27 |
|  | geographic 1 | 2.21 / 16.4 | 4,931 | 8.22 | 396 | 56.3 | 7.66 |
|  | geographic 2 | 3.55 / 21.3 | 2,495 | 4.38 | 174 | 25.7 | 2.74 |
|  | geographic 4 | 8.04 / 46.9 | 1,013 | 2.03 | 78 | 13.8 | 5.05 |
| Shackleton grazing | cube 1 | 0.39 / 1.7 | 203 | 1.83 | 50 | 2.8 | 0.66 |
|  | cube 2 | 0.63 / 2.6 | 134 | 1.23 | 35 | 1.4 | 0.43 |
|  | cube 4 | 0.69 / 6.2 | 104 | 0.97 | 30 | 1.2 | 0.34 |
|  | polar 0.5 | 0.21 / 1.1 | 328 | 2.92 | 70 | 3.8 | 1.21 |
|  | polar 1 | 0.35 / 1.6 | 163 | 1.48 | 35 | 1.9 | 0.59 |
|  | polar 2 | 0.55 / 2.4 | 88 | 0.83 | 19 | 1.1 | 0.33 |
|  | geographic 1 | 2.02 / 11.3 | 4,891 | 8.23 | 398 | 63.4 | 6.45 |
|  | geographic 2 | 2.48 / 14.1 | 3,193 | 5.53 | 220 | 36.2 | 3.21 |
|  | geographic 4 | 4.95 / 24.7 | 1,804 | 3.29 | 129 | 16.9 | 3.05 |
| South pole | cube 1 | 0.82 / 3.9 | 144 | 1.32 | 37 | 1.8 | 0.48 |
|  | cube 2 | 1.53 / 7.5 | 75 | 0.72 | 23 | 1.0 | 0.26 |
|  | cube 4 | 3.79 / 16.1 | 60 | 0.59 | 22 | 1.0 | 0.19 |
|  | polar 0.5 | 0.40 / 2.0 | 271 | 2.42 | 58 | 2.6 | 0.96 |
|  | polar 1 | 0.86 / 3.4 | 103 | 0.96 | 22 | 1.2 | 0.40 |
|  | polar 2 | 1.50 / 7.4 | 43 | 0.44 | 9 | 0.9 | 0.20 |
|  | geographic 1 | 3.33 / 19.2 | 4,777 | 7.92 | 393 | 65.4 | 8.15 |
|  | geographic 2 | 3.62 / 16.3 | 3,244 | 5.51 | 222 | 37.3 | 4.29 |
|  | geographic 4 | 8.11 / 28.5 | 1,504 | 2.82 | 112 | 16.5 | 3.97 |
| Pole grazing | cube 1 | 0.13 / 0.7 | 193 | 1.77 | 47 | 2.2 | 0.62 |
|  | cube 2 | 0.16 / 0.8 | 119 | 1.13 | 31 | 1.3 | 0.39 |
|  | cube 4 | 0.18 / 1.5 | 101 | 0.97 | 27 | 1.1 | 0.32 |
|  | polar 0.5 | 0.03 / 0.2 | 337 | 3.02 | 73 | 4.1 | 1.07 |
|  | polar 1 | 0.04 / 0.5 | 179 | 1.65 | 38 | 1.8 | 0.60 |
|  | polar 2 | 0.07 / 0.7 | 103 | 0.99 | 22 | 1.4 | 0.41 |
|  | geographic 1 | 1.39 / 28.7 | 4,139 | 6.92 | 390 | 73.6 | 4.52 |
|  | geographic 2 | 0.56 / 4.5 | 5,446 | 8.87 | 389 | 69.7 | 8.63 |
|  | geographic 4 | 0.71 / 7.2 | 3,406 | 5.75 | 228 | 33.5 | 6.96 |
| Cap nadir (40 km) | cube 1 | 2.05 / 11.4 | 306 | 2.73 | 67 | 3.2 | 0.80 |
|  | cube 2 | 4.07 / 14.7 | 117 | 1.08 | 27 | 1.3 | 0.32 |
|  | cube 4 | 11.82 / 47.2 | 81 | 0.77 | 21 | 1.0 | 0.22 |
|  | polar 0.5 | 1.41 / 5.8 | 148 | 1.35 | 31 | 1.9 | 0.52 |
|  | polar 1 | 3.56 / 13.2 | 52 | 0.52 | 11 | 0.8 | 0.22 |
|  | polar 2 | 7.32 / 39.9 | 19 | 0.23 | 4 | 1.0 | 0.48 |
|  | geographic 1 | 8.07 / 26.1 | 2,120 | 3.94 | 152 | 23.8 | 2.15 |
|  | geographic 2 | 17.29 / 62.5 | 764 | 1.64 | 61 | 8.7 | 1.57 |
|  | geographic 4 | 43.46 / 147.3 | 380 | 0.94 | 32 | 3.3 | 0.56 |
| px/py/nz corner | cube 1 | 0.65 / 5.3 | 411 | 3.64 | 97 | 4.3 | 1.32 |
|  | cube 2 | 1.82 / 12.1 | 219 | 1.97 | 57 | 2.9 | 0.65 |
|  | cube 4 | 3.18 / 19.5 | 105 | 0.98 | 31 | 1.2 | 0.34 |
|  | geographic 1 | 8.10 / 33.2 | 224 | 0.69 | 26 | 2.5 | 0.42 |
|  | geographic 2 | 15.72 / 59.5 | 107 | 0.37 | 15 | 1.2 | 0.14 |
|  | geographic 4 | 28.34 / 98.1 | 62 | 0.25 | 10 | 0.9 | 0.11 |

- **Cube against geographic, at equal error: the cube wins everywhere.** Near
  the pole, geographic at errorTarget 1 is still less accurate than the cube at
  4 (Shackleton 2.21 vs 2.04 m median) and costs 73× the tiles, 12× the
  triangles and 32× the GPU time (7.66 vs 0.24 ms); at pole-grazing geographic
  needs 5,446 tiles and 8.6 ms GPU for 0.56 m against the cube's 119 tiles and
  0.39 ms for 0.16 m. At the mid-latitude corner, geographic errorTarget 1
  (8.1 m, 0.69 M triangles, 0.42 ms) is both less accurate and dearer than the
  cube at 4 (3.2 m, 0.98 M, 0.34 ms); its apparent advantage in the first table
  was 9× coarser surface. Simplified quantized mesh costs fewer triangles per
  tile, but RTIN error at 0.1 × spacing plus the geographic layout leave its
  surface error far above the cube's at every budget measured.
- **Cube against the polar cap, inside the cap: the cap is cheaper.** At equal
  median error the cap draws 25–50% fewer triangles and spends 15–40% less GPU
  time: pole 0.86 m — cap (1) 0.96 M / 0.40 ms vs cube (1) 0.82 m 1.32 M /
  0.48 ms; Shackleton ~1.1 m — cap (2) 0.73 M / 0.27 ms vs cube (2) 1.02 M /
  0.43 ms; cap-nadir — cap (0.5) 1.41 m 1.35 M / 0.52 ms vs cube (1) 2.05 m
  2.73 M / 0.80 ms; at the grazing poses the cap is also more accurate at
  equal errorTarget-matched cost (pole-grazing 0.04 vs 0.13 m at 1.65 vs 1.77 M
  triangles). (Separated since in *LOD error and mesh simplification*: encoding
  explains the triangle and GPU gap, the error estimate does not.) Likely causes as first listed: the cube's geometric
  error uses the face-centre spacing for every tile of a level, the cube tiles at
  the Shackleton region carry a longer REPLACE chain (levels 0–12 against the cap's
  0–8 for similar ground detail), and polar stereographic has near-unit scale over
  the cap. The cap's advantage holds only inside its 200 km square; outside it a
  geographic product is the only far field there is, at the costs above.


**Cold loading** (fresh page per pose; tile traffic over an emulated 40 ms RTT,
100 Mbit/s link; time from the pose to the start of a 2 s stable streak;
requests and bytes since the pose, then including what the catalog's initial
view had already loaded; the cube counts its CPU grids, loaded by query):

| View | Product | To finished detail (s) | Requests / MB since pose | Total requests (CPU grids) / MB |
| --- | --- | --- | --- | --- |
| Shackleton oblique | cube | 2.8 | 139 / 21.1 | 336 (144) / 34.6 |
|  | polar cap (eT 1) | 4.0 | 188 / 30.2 | 189 / 40.3 |
|  | geographic | 27.7 | 3,294 / 47.0 | 3,351 / 48.3 |
| Shackleton grazing | cube | 3.5 | 173 / 26.4 | 363 (145) / 38.8 |
|  | polar cap (eT 1) | 4.5 | 216 / 34.8 | 217 / 44.8 |
|  | geographic | 35.6 | 4,221 / 59.3 | 4,279 / 60.6 |
| South pole | cube | 1.8 | 93 / 13.7 | 288 (144) / 26.8 |
|  | polar cap (eT 1) | 2.9 | 136 / 21.9 | 137 / 31.9 |
|  | geographic | 36.0 | 4,292 / 59.2 | 4,363 / 60.8 |
| Pole grazing | cube | 2.9 | 141 / 21.4 | 338 (144) / 34.9 |
|  | polar cap (eT 1) | 5.0 | 240 / 38.6 | 241 / 48.6 |
|  | geographic | 77.0 | 9,026 / 115.7 | 9,084 / 117.0 |
| Cap nadir (40 km) | cube | 1.8 | 90 / 13.9 | 317 (139) / 32.2 |
|  | polar cap (eT 1) | 1.6 | 68 / 10.9 | 69 / 21.0 |
|  | geographic | 8.6 | 992 / 17.4 | 1,019 / 17.9 |
| px/py/nz corner | cube | 5.6 | 277 / 43.7 | 487 (141) / 59.3 |
|  | geographic | 1.1 | 112 / 2.9 | 171 / 4.2 |
| Overview (3,000 km) | cube | 0.5 | 22 / 3.4 | 229 (136) / 18.5 |
|  | polar cap (eT 1) | 0.3 | 4 / 0.6 | 5 / 10.7 |
|  | geographic | 0.2 | 12 / 0.3 | 65 / 1.5 |

On localhost (no throttling) every cube and cap pose finished within 0.2–0.5 s
of the pose, geographic in 0.2–34.9 s (the 9,050-request pole-grazing pose);
those times measure the dev server, not a network.

**Limits.** One high-end integrated GPU (the *Hardware GPU* caveats apply:
`readPixels` fencing, 0.1 ms timer resolution, no thermal soak); an emulated
network, not a CDN; one run per pose; single-tile-under-the-centre detail
matching, not a field-wide error metric; no imagery on the baselines.

### Recommendation from the geometry evidence: revise

- **Against the geographic layout, the cube is the better global geometry
  layout** on every measured axis near the pole — tiles, draws, triangles,
  memory, cold requests and time, warm frames — by one to two orders of
  magnitude at equal or better achieved error, and it stays ahead at equal
  error at mid-latitudes. Nothing measured favours keeping geographic tiles as
  the global geometry.
- **Against the polar cap, the cube costs 25–50% more inside the cap** at equal
  error, while needing no second product, no join and no far-field fallback. A
  cap-plus-global design pays that join (and the global product's own cost at
  the cap edge, 81.5°–87°S, where geographic slivers are already expensive) to
  save it.
- *Update after* LOD error and mesh simplification: (1) the measured error
  bound did not reduce cost at matched error and stays out of selection; (2)
  0.03 × spacing RTIN simplification brings the cube to the cap's triangles,
  geometry memory and GPU time at Shackleton and the pole, at 1.5–2.2× its
  draws. Still **revise**: the remaining cap advantage is draw count (and
  cap-nadir), which a shallower REPLACE chain or more children per tile would
  address.
- *Update after* Frame overhead: most of that draw gap was tiles selected by
  off-screen streaming cameras, drawn for no pixels, on the cube and the cap
  alike. With the main-view draw cull the cube draws no more than the uncull
  cap anywhere inside it, and about as much as the culled cap (Shackleton 50
  vs 64, cap nadir 25 vs 24); simplified 0.03 matches the baseline's draws at
  the face centre and still needs 2× at the face edge and corner. Frames are
  far inside 120 Hz on the available M4 Max in every configuration measured,
  so draw count is no longer an adoption blocker on this hardware; weaker
  devices are not required for the decision.
- So the recommendation is **revise, not yet adopt**: keep the cube as the
  candidate global layout and close the gap before deciding — (1) find why
  gnomonic tiles cost more than the cap at equal error (per-tile geometric error
  from measured representation error instead of the face-centre spacing; a
  shallower REPLACE chain, e.g. coarser roots or more children per level), (2)
  add mesh simplification so the encoding comparison is like for like, (3) run
  the matched-imagery comparison and (4) acceptable performance on the
  available hardware (M4 Max; met, *Frame overhead*). **Reject** would need
  the cube to stay behind the cap after (1)–(2) by more than the join costs;
  **adopt** needs (1)–(4) and the correctness items under *Remaining for
  #149*. #149 stays open.

## LOD error and mesh simplification (2026-10-14)

The layout comparison left the cube 25–50% dearer than the polar cap inside the
cap at equal achieved error, and named two possible causes in the cube's own
encoding: a geometric error taken from the face-centre vertex spacing, and an
unsimplified 65² lattice. This slice measures each change separately, on the
same fused field, poses, viewport, lighting, imagery configuration and cache
budgets as *Layout comparison*. Neither change touches the mapping, the
skirts, the CPU grids or the selected product extent.

### A field-sampler defect found on the way (fixed first)

`dem.py field_heights` added the polar residual only when the queried lon/lat
range overlapped its bounds *strictly*. The residual's bounds are
`(−180, −90, 180, lat_max)`, so a lone point at lon ±180° or lat −90° got the
LOLA 118 m base alone. `cube-tile` samples every tile-edge vertex one at a time
(for bit-identical shared vertices), so the cube product's **pole vertex** and
the `nz` edge line along the **antimeridian** inside the 87°S coverage carried
base heights while their neighbours carried the fused field. That is a crease
on every level: 9,940 heights on 184 `nz` tiles move, median 1.9 m, up to 71 m
at levels 7–12 and 1.1 km at the level-1/2 pole vertex (where the lon/lat base
kernel is longitude-dependent). Batched evaluations — interior cube vertices,
the geographic pyramid, the polar cap, `field-error` — were never affected.

It surfaced as an 18 m step in a simplified tile at the pole (see below); the
earlier gates could not see it because every tile holding those vertices
evaluated them identically, and the control points avoid that line. Fixed with
closed bounds (commit "sample the residual at a lone antimeridian or pole
point"), with a selftest regression. **Every product and number in this
section is built on the fixed field**; the baseline is rebuilt, and a build from
the fix-only commit is byte-identical to one from this branch's builder (same
SHA over every `.glb`, `.f32` and `tileset.json`), so the builder changes below
do not alter the baseline. `validation.json` is now the corrected product's
(all gates pass; control points unchanged, RMS 6.85 m). Earlier sections'
figures are from the pre-fix product; only measurements touching the `nz`
antimeridian line or the pole vertex can differ.

### 1. What the existing estimates measure

- **`geometricError` = 0.25 × face-centre vertex spacing** of the tile's level,
  for every refining tile. It ignores relief, and ignores that gnomonic cells
  shrink toward face edges (≈ ½) and corners (≈ ⅓ along the diagonal).
- **`cpu-grids.json` per-tile uncertainty** (`tiles[i][4]`) is the maximum of
  |bilinear-in-(u, v) CPU grid − fused field at its finest source level| over a
  4× denser sample lattice. It is *sampled* — relief between samples is
  missed — and it describes the bilinear CPU surface, not the emitted triangles
  (which differ from bilinear by up to 922 m at level 1, *Measured results*),
  and not the deviation from descendants that REPLACE selection depends on. It
  is neither a triangle-mesh bound nor a selection error, and is not used as
  one here.

### 2. Geometric error from the rendered triangles (`dem.py cube-error`)

For every parent and each child, `cube_radial_deviation` bounds the radial
distance between the two emitted surfaces over the child's footprint (skirts
excluded). Both meshes have their vertices on lattice rays, and gnomonic
projection maps 3D edges to straight lines in (u, v); splitting each child cell
by both diagonals gives sub-triangles that no edge of either mesh crosses
(lattice, RTIN or the parent's), so each surface is one plane there. Along the
unnormalized ray w = N + uU + vV a plane sits at r = |w|/g(w) with g affine in
(u, v), so

```text
|r_a − r_b| ≤ max|g_b − g_a| · max|w| / (min g_a · min g_b)   (all over the sub-triangle's vertices)
```

— a conservative bound in exact arithmetic, computed on the float32 vertices
the `.glb` actually holds, metres. Radial distance also bounds the distance
between the surfaces. Then

```text
geometricError(P) = max over children C of [ deviation(P, C) + geometricError(C) ],   leaves 0
```

which bounds P's distance from the finest surface the product holds under it
(triangle inequality), so detail that only a grandchild resolves reaches every
ancestor even where parent and child agree at every vertex they share. Output:
`tileset-measured.json` (same tree and bounds, only geometricError changed,
rounded up to 1 mm) and `mesh-error.json` (per tile: nominal, measured, each
child deviation, and the same bound against the CPU lattice). 6–9 s for 4,030
tiles on 14 workers; `cube.sh` runs it after every build.

Regressions (`dem.py selftest`): the bound against 1,500 dense samples on
lattice and RTIN meshes at a face centre, edge and corner tile (never below the
sample, within 5% above it); a 50 m spike at a child vertex between a parent's
samples (bound within the flat-tile chord sag of 50 m); a three-level REPLACE
chain at the px/py/nz corner whose 80 m peak only the grandchild resolves (the
parent's own comparison is < 80 m, its propagated error ≥ 80 m); monotone
errors and an otherwise unchanged tileset on the synthetic product. Mutating the
propagation to parent-child only, or loosening the bound's denominator, fails
them. `validate-cube-terrain.mjs` gates `tileset-measured.json` monotonicity.

**What the measurement shows about the nominal estimate** (baseline product,
`mesh-error-baseline.json`):

| Level | Refining | Nominal (m) | Measured p5 / p50 / p95 (m) | Parent–child only, p50 | Measured ÷ nominal, p50 (p5–p95): centre / edge / corner | Raised by propagation |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 6 | 13,573 | 10,129 / 11,727 / 14,696 | 4,709 | 0.86 (0.75–1.08) / — / — | 6 |
| 2 | 96 | 3,393 | 1,726 / 2,381 / 4,019 | 2,331 | 0.80 (0.66–1.67) / 0.66 (0.55–1.15) / 0.62 (0.47–0.90) | 11 |
| 4 | 53 | 848 | 331 / 583 / 1,218 | 529 | 1.09 (0.87–1.76) / 0.72 (0.55–1.04) / 0.47 (0.34–0.73) | 17 |
| 6 | 58 | 212 | 46 / 109 / 275 | 102 | 0.87 (0.61–1.39) / 0.53 (0.37–0.97) / 0.33 (0.18–0.79) | 20 |
| 7 | 63 | 106 | 14 / 44 / 141 | 44 | 0.98 (0.50–1.40) / 0.40 (0.27–1.16) / 0.22 (0.12–0.61) | 14 |
| 9 | 83 | 26.5 | 12.6 / 21.3 / 33.2 | 15.1 | 0.80 (0.48–1.25) / — / — | 57 |
| 10 | 204 | 13.3 | 4.5 / 7.9 / 12.5 | 6.8 | 0.59 (0.34–0.94) / — / — | 78 |
| 11 | 284 | 6.6 | 2.1 / 3.2 / 4.8 | 3.2 | 0.48 (0.31–0.73) / — / — | 0 |

(All levels in `mesh-error-baseline.json`; the bound is at most 1.7% above the
largest vertex difference, at level 0, and < 0.01% from level 7 down.) The
nominal value over-states the error of face-edge and corner tiles 1.5–8×
(they refine more than their relief needs), under-states rough centre tiles by
up to 1.8×, and propagation matters: it raises 57 of 83 refining level-9 tiles,
and doubles levels 0–1.

### 3. Mesh simplification (`cube-tile --simplify FRAC`)

The existing RTIN (`dem.py tile`, Martini-style) with two changes: a vertex's
own error is its exact radial distance from the hypotenuse it splits (the uv
midpoint's ray meets the 3D chord), and the threshold is FRAC × the level's
face-centre vertex spacing. Every edge vertex is kept, so tile boundaries — and
therefore the measured skirt gaps, skirt depths and cross-face registration —
are exactly the full lattice's (gated: every unit boundary segment is an edge of
exactly one surface triangle). Unused vertices are dropped; skirts keep their
place after the surface (`extras.surfaceTriangles` is the simplified count).
REPLACE structure and subtree boxes are unchanged in kind (boxes from the
written vertices). CPU grids are unchanged and fetched by query as before, so
CPU residency is independent of what renders; they are byte-identical across
all configurations here.

**Rendered vs CPU surface.** `CubeGridSurface` still intersects the grid's full
lattice. A simplified product says so: `cpu-grids.json` gains `renderedMesh`
and a per-tile `tiles[i][5]`, the conservative bound between the rendered and
the CPU-lattice triangles (`CubeGridManifest` types it; the surface's docs no
longer claim the two are the same). One finding: RTIN's finest triangles
alternate diagonals while the lattice always splits v00→v11, so where a cell
twists the two differ by half the twist *with nothing simplified* (2 km at
level 3 on the point-sampled base, 2.7 m at level 12). Cells whose two
anti-diagonal halves both survive are now re-split like the lattice (a
full-detail RTIN then equals the lattice exactly, selftest); halves whose
partner is part of a coarser triangle cannot be, and they still set most
tiles' maximum.

| `--simplify` | `.glb` MB | Mean surface triangles (vs 8,192) | Rendered − CPU lattice, p50 / max (× vertex spacing) | Build (14 workers) |
| --- | --- | --- | --- | --- |
| 0 (baseline) | 648.5 | 8,192 | float32 only (≤ 6 cm) | 91 s + 9 s `cube-error` |
| 0.03 | 309.5 | 3,519 (−57%; −45% at L3, −71% at L8, −55% at L12) | 0.05–0.15 / 0.13–0.28 | 104 s + 8 s |
| 0.1 | 161.9 | 1,485 (−82%) | 0.13–0.17 / 0.17–0.29 | 104 s + 9 s |

Validated (`validation-simplified-003.json`, all gates pass): sampled emitted −
CPU-lattice differences RMS 0.10 m / max 0.52 m at level 12, never beyond the
stated tile bound; the 120 CPU picks lie 0.94 m RMS / 3.7 m max radially from
the rendered triangles (gated against each tile's bound; the unsimplified gate
of < 5 cm no longer applies), clearance unchanged (120/120, ≥ 49.7 m above the
CPU sample); CPU bilinear − rendered triangles RMS 0.10 m at level 12. Imagery
on simplified triangles (`capture-cube-imagery.mjs --cube-tileset
moon-terrain-cube-simplified-003/tileset.json`, M4 Max): rendered registration
median 0.41–0.42 texel in every ground view (0.53 overview), p95 ≤ 0.72, 0
face/tile mismatches; all seven markers within 0.49 px / 8.3 m, as on the full
lattice; a clipping regression partitions a simplified (fan) corner tile into
blocks at three depths with area preserved. Rendered picking on hole pixels
hits a skirt in 197 of 199 cases; 0 hole pixels with skirts in all eleven
static views and in all 140 steps of the refine/coarsen/delayed/failed/evicting
paths.

### 4. Measurements

`capture-cube-imagery.mjs --gpu --experiments compare --frames 240
--error-target {0.5,1,2,4} --cube-tileset … --label …` for each cube
configuration, the polar cap at 0.5/1/2, then `dem.py field-error` on each
record. Apple M4 Max (16-core, 48 GB, macOS 26), Chrome headless 148, ANGLE
Metal; 1280×800, DPR 1, `?test=1`; IAU_MOON poses at the catalog epoch, paused;
fade off; 512 MiB tile cache; cold page per row. Eight poses: *Layout
comparison*'s seven plus the px/nz face edge. Records:
`lod-error-sweep.json` (178 rows), `lod-error-screen.json`, `lod-error-captures.json`.

Cost at **matched achieved error**: each configuration's sweep interpolated
(log–log) to the error the baseline reaches at eT 2, and the cap at eT 1. Cell:
triangles · visible tiles (≈ draws − 5) · geometry MB · GPU / wall median ms.
"—" means the configuration did not reach that error anywhere in eT 0.5–4 (not
extrapolated).

*Median |rendered − field|, target = baseline at eT 2:*

| View | Target (m) | Baseline | Measured error | Simplified 0.1 | Simplified 0.03 | 0.03 + measured | Polar cap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Shackleton | 1.07 | 1.02 M · 110 · 30 · 0.39 / 1.30 | 1.06 M · 114 · 31 · 0.40 / 1.25 | 0.66 M · 281 · 17 · 0.29 / 2.15 | 0.72 M · 144 · 20 · 0.24 / 1.33 | 0.71 M · 144 · 20 · 0.24 / 1.22 | 0.84 M · 88 · 19 · 0.32 / 1.03 |
| Shackleton grazing | 0.63 | 1.23 M · 134 · 35 · 0.43 / 1.40 | 1.20 M · 130 · 33 · 0.42 / 1.39 | 0.77 M · 336 · 20 · 0.40 / 2.85 | 0.91 M · 179 · 24 · 0.28 / 1.47 | 0.90 M · 178 · 24 · 0.27 / 1.43 | — |
| South pole | 1.53 | 0.72 M · 75 · 24 · 0.26 / 1.00 | 0.74 M · 77 · 22 · 0.27 / 1.03 | 0.57 M · 234 · 15 · 0.20 / 1.96 | 0.65 M · 124 · 18 · 0.20 / 1.12 | 0.63 M · 118 · 17 · 0.19 / 1.12 | — |
| Pole grazing | 0.16 | 1.13 M · 119 · 31 · 0.40 / 1.20 | 1.48 M · 159 · 39 · 0.52 / 1.84 | — | — | — | — |
| Cap nadir | 4.07 | 1.08 M · 117 · 27 · 0.31 / 1.10 | 1.11 M · 120 · 28 · 0.33 / 1.20 | 1.24 M · 456 · 30 · 0.43 / 3.36 | 1.09 M · 193 · 26 · 0.26 / 1.82 | 0.96 M · 168 · 23 · 0.24 / 1.37 | 0.45 M · 43 · 9 · 0.19 / 0.73 |
| px/nz face edge | 1.73 | 1.63 M · 177 · 48 · 0.51 / 1.80 | 2.24 M · 247 · 58 · 0.72 / 2.91 | — | 2.38 M · 490 · 61 · 0.69 / 3.58 | — | — |
| px/py/nz corner | 1.82 | 1.97 M · 219 · 54 · 0.66 / 2.40 | 2.45 M · 274 · 65 · 0.79 / 3.03 | — | 2.92 M · 681 · 75 · 0.87 / 4.41 | — | — |

*p95 |rendered − field|, target = baseline at eT 2:*

| View | Target (m) | Baseline | Measured error | Simplified 0.03 | 0.03 + measured | Polar cap |
| --- | --- | --- | --- | --- | --- | --- |
| Shackleton | 9.60 | 1.02 M · 110 · 30 · 0.39 / 1.30 | 0.86 M · 92 · 27 · 0.32 / 1.04 | 0.64 M · 124 · 18 · 0.22 / 1.26 | 0.60 M · 115 · 17 · 0.20 / 1.03 | 0.76 M · 80 · 17 · 0.29 / 0.94 |
| Shackleton grazing | 2.62 | 1.23 M · 134 · 35 · 0.43 / 1.40 | 1.19 M · 129 · 33 · 0.41 / 1.39 | 0.93 M · 183 · 24 · 0.28 / 1.49 | 0.91 M · 181 · 24 · 0.27 / 1.44 | — |
| South pole | 7.49 | 0.72 M · 75 · 24 · 0.26 / 1.00 | 0.78 M · 82 · 23 · 0.29 / 1.08 | 0.51 M · 87 · 14 · 0.16 / 0.96 | 0.52 M · 91 · 15 · 0.16 / 0.95 | — |
| Pole grazing | 0.84 | 1.13 M · 119 · 31 · 0.40 / 1.20 | 1.41 M · 152 · 37 · 0.50 / 1.75 | 0.94 M · 201 · 24 · 0.29 / 1.57 | 1.16 M · 259 · 30 · 0.35 / 1.92 | — |
| Cap nadir | 14.68 | 1.08 M · 117 · 27 · 0.31 / 1.10 | 1.11 M · 120 · 28 · 0.33 / 1.20 | 1.10 M · 195 · 26 · 0.27 / 1.84 | 0.87 M · 152 · 21 · 0.23 / 1.28 | 0.48 M · 47 · 10 · 0.20 / 0.76 |
| px/nz face edge | 13.04 | 1.63 M · 177 · 48 · 0.51 / 1.80 | 2.32 M · 257 · 60 · 0.74 / 3.05 | 1.16 M · 225 · 30 · 0.33 / 1.79 | 1.70 M · 331 · 43 · 0.44 / 2.40 | — |
| px/py/nz corner | 12.05 | 1.97 M · 219 · 54 · 0.66 / 2.40 | 2.53 M · 283 · 67 · 0.82 / 3.11 | 1.48 M · 330 · 39 · 0.42 / 2.35 | — | — |

*Against the polar cap at its eT 1 (median / p95 target, m):*

| View | Target | Baseline | Measured error | Simplified 0.03 | 0.03 + measured | Polar cap |
| --- | --- | --- | --- | --- | --- | --- |
| Shackleton, median | 0.69 | 1.58 M · 174 · 44 · 0.59 / 1.99 | 1.52 M · 167 · 41 · 0.59 / 1.80 | 1.06 M · 235 · 29 · 0.36 / 1.83 | 0.98 M · 216 · 26 · 0.33 / 1.72 | 1.30 M · 142 · 30 · 0.51 / 1.60 |
| Shackleton, p95 | 4.53 | 1.79 M · 198 · 49 · 0.67 / 2.24 | 1.65 M · 182 · 44 · 0.64 / 1.94 | 1.05 M · 232 · 28 · 0.35 / 1.81 | 0.94 M · 205 · 25 · 0.32 / 1.64 | 1.30 M · 142 · 30 · 0.51 / 1.60 |
| Shackleton grazing, median | 0.35 | 2.01 M · 223 · 54 · 0.73 / 2.31 | 2.27 M · 253 · 59 · 0.82 / 3.06 | 1.35 M · 287 · 35 · 0.48 / 2.34 | — | 1.48 M · 163 · 35 · 0.60 / 1.70 |
| Shackleton grazing, p95 | 1.55 | 1.97 M · 219 · 53 · 0.71 / 2.26 | 1.83 M · 203 · 49 · 0.65 / 2.39 | 1.50 M · 326 · 39 · 0.56 / 2.68 | 1.29 M · 277 · 33 · 0.38 / 1.90 | 1.48 M · 163 · 35 · 0.60 / 1.70 |
| Pole, median | 0.86 | 1.26 M · 138 · 36 · 0.46 / 1.46 | 1.22 M · 132 · 34 · 0.47 / 1.47 | 1.01 M · 225 · 27 · 0.31 / 1.68 | 0.94 M · 202 · 25 · 0.30 / 1.59 | 0.96 M · 103 · 22 · 0.41 / 1.30 |
| Pole, p95 | 3.40 | 1.51 M · 165 · 42 · 0.56 / 1.68 | 1.33 M · 145 · 37 · 0.52 / 1.57 | 1.02 M · 228 · 27 · 0.31 / 1.69 | 0.92 M · 197 · 25 · 0.29 / 1.56 | 0.96 M · 103 · 22 · 0.41 / 1.30 |
| Cap nadir, median | 3.56 | 1.30 M · 141 · 32 · 0.37 / 1.29 | 1.25 M · 135 · 31 · 0.37 / 1.35 | 1.30 M · 235 · 31 · 0.31 / 2.22 | 1.08 M · 191 · 26 · 0.27 / 1.49 | 0.52 M · 52 · 11 · 0.22 / 0.80 |
| Cap nadir, p95 | 13.20 | 1.60 M · 176 · 40 · 0.46 / 1.56 | 1.32 M · 143 · 33 · 0.39 / 1.43 | 1.65 M · 303 · 40 · 0.37 / 2.87 | 1.05 M · 186 · 25 · 0.26 / 1.46 | 0.52 M · 52 · 11 · 0.22 / 0.80 |

At pole-grazing the cap reaches 0.04 m median (eT 1) and no cube configuration
gets below 0.11 m at eT 0.5: the cube's level 12 extends only 15 km from
Shackleton, so this is the product extent, not the layout or either change.

**Cold loads** (`--throttle 40,100`: 40 ms RTT, 100 Mbit/s emulated; seconds to
finished detail · requests · MB since the pose; CPU grids, 144 requests /
2.4 MB at Shackleton, are identical in every cube configuration):

| View | Baseline eT 2 | Baseline eT 1 | Measured eT 2 | Simplified 0.03 eT 2 | Simplified 0.03 eT 1 | 0.03 + measured eT 2 | Polar eT 1 | Polar eT 0.5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shackleton | 2.6 · 128 · 19.3 | 4.9 · 244 · 38.0 | 2.6 · 125 · 18.8 | 1.4 · 130 · 10.7 | 3.0 · 438 · 28.7 ¹ | 1.5 · 132 · 11.0 | 4.0 · 188 · 30.2 | 9.7 · 464 · 74.6 |
| Shackleton grazing | 3.4 · 170 · 25.9 | 4.8 · 241 · 37.3 | 3.2 · 160 · 24.3 | 1.8 · 170 · 14.5 | 2.9 · 254 · 21.6 | 1.8 · 163 · 13.9 | 4.5 · 216 · 34.8 | 9.0 · 436 · 70.1 |
| South pole | 1.8 · 89 · 13.0 | 2.5 · 167 · 25.6 | 1.8 · 90 · 13.2 | 0.9 · 72 · 6.1 | 2.0 · 175 · 14.7 | 1.4 · 109 · 9.6 | 2.9 · 136 · 21.9 | 7.5 · 360 · 57.9 |
| Pole grazing | 2.1 · 106 · 15.8 | 5.1 · 251 · 39.1 | 2.7 · 133 · 20.1 | 1.7 · 148 · 12.1 | 2.7 · 240 · 18.9 | 1.4 · 124 · 10.1 | 5.0 · 240 · 38.6 | 9.4 · 456 · 73.4 |
| Cap nadir | 1.7 · 82 · 12.6 | 6.9 · 336 · 53.5 | 2.3 · 113 · 17.6 | 1.3 · 108 · 10.5 | 4.5 · 368 · 35.8 | 1.2 · 115 · 11.1 | 1.6 · 68 · 10.9 | 4.1 · 196 · 31.5 |
| px/nz face edge | 4.3 · 218 · 34.2 | 8.8 · 442 · 70.3 | 3.1 · 160 · 24.9 | 2.7 · 214 · 19.1 | 4.8 · 440 · 38.3 | 1.8 · 152 · 13.5 | — | — |
| px/py/nz corner | 5.6 · 282 · 44.5 | 10.6 · 528 · 84.1 | 4.1 · 212 · 33.2 | 3.3 · 282 · 23.9 | 5.4 · 539 · 43.1 | 2.6 · 219 · 19.0 | — | — |

¹ The first run of this row took 472.9 s with the same 194 tiles and ~440
requests finally loaded; two repeats took 3.0 and 3.1 s (shown). A one-off
stall, recorded unexplained like the earlier SwiftShader stalls.

**Imagery** (NAC mosaic, `frametime`, warm, 240 frames; simplified at eT 1.5
≈ the baseline's accuracy at eT 2; median / p95 ms):

| Configuration | View | Tiles | Terrain triangles | Terrain only: wall / GPU | Refined: draws, wall / GPU | Blocks · block geometry | Layer update |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline eT 2 | Shackleton | 110 | 1.02 M | 1.4 / 3.7 · 0.40 / 1.70 | 208, 2.4 / 4.1 · 0.54 / 1.25 | 203 · 9.0 MB | 0.3 ms |
| Measured eT 2 | Shackleton | 110 | 1.02 M | 1.2 / 2.7 · 0.39 / 1.62 | 205, 3.0 / 4.9 · 0.52 / 2.35 | 200 · 9.3 MB | 0.4 ms |
| Simplified 0.03 eT 1.5 | Shackleton | 131 | 0.65 M | 1.4 / 3.1 · 0.22 / 0.95 | 211, 1.9 / 3.7 · 0.30 / 1.26 | 206 · 4.5 MB | 0.7 ms |
| Baseline eT 2 | Pole | 75 | 0.72 M | 1.0 / 2.6 · 0.26 / 1.17 | 188, 2.0 / 3.8 · 0.35 / 1.55 | 183 · 9.2 MB | 0.6 ms |
| Simplified 0.03 eT 1.5 | Pole | 96 | 0.53 M | 1.0 / 2.2 · 0.18 / 0.76 | 191, 2.2 / 3.3 · 0.36 / 0.98 | 186 · 5.1 MB | 0.4 ms |

(Face-edge and corner rows, outside the mosaic, and the 0.03 + measured rows are
in the record.) Block geometry halves with the triangles; draws are set by the
imagery blocks there, so they do not change; layer update stays 0.3–0.7 ms in
every configuration (within this host's 0.1 ms timer and frame-to-frame spread).

Frames: `lod-error-{shackleton,shackleton-grazing,pole,pole-grazing,face-corner}.jpg`
— shaded and wireframe, baseline / measured / simplified 0.03 / polar cap
(pole-grazing is in lunar night; its wireframe row shows the meshes).

### 5. What the measurements say

**Measured geometric error — not justified as the selection policy.** At
matched median error it is within ±4% of the baseline at Shackleton, the pole
and cap-nadir, and **dearer** at the face edge (+37% triangles), the corner
(+24%) and pole-grazing (+31%); at matched p95 it saves 16% at Shackleton and
18% at cap-nadir against the cap's target, and costs +42% / +28% at the edge
and corner. Judging error in screen pixels instead of metres
(`lod-error-screen.json`) gives the same picture (+33% / +24% at edge/corner),
and so does the worst pixel. A bound on each tile's *maximum* deviation is the
right quantity for correctness, but as a selection signal it spends detail on
tiles with a single steep feature or a long propagated chain, while the
nominal spacing — however crude — keeps triangles near uniform on screen,
which is what the pixel-sampled error rewards. Retained, as validation and
metadata (the rendered/CPU bound for simplified products, a monotonicity gate,
and the per-tile evidence that face-corner tiles carry 2–8× more detail than
their nominal error claims); `tileset.json` keeps the nominal policy.

**Simplification at 0.1 × spacing — rejected.** Leaves carry their own
simplification error with nothing finer to refine into, so wherever the product
stops at level 8 (edge, corner, cap-nadir) it never reaches the baseline's
accuracy, and where it does it needs 2.5× the tiles and draws.

**Simplification at 0.03 × spacing — retained as a build option, not yet the
default.** At matched error at Shackleton and the pole (both targets, median
and p95) it cuts triangles 10–35%, geometry memory 25–35% and GPU time 23–39%,
and halves product size (648 → 310 MB) and imagery block geometry. It costs
30–65% more tiles and draws (simplified leaves are less accurate, so the same
accuracy needs deeper selection), which leaves wall time between −8% and +15%.
Cold, at the same errorTarget it moves 45–53% fewer bytes; at *matched
accuracy* the saving shrinks to 26% / 23% (bytes / time to finished detail) at
Shackleton and 7% / 6% at the pole, and turns into a loss at cap-nadir (+58% /
+47%), where it must refine two levels deeper. At the face edge and corner it
loses at matched median (+46–48% triangles, 2.8–3.1× tiles) and wins at matched
p95 (−25–29% triangles); screen-space error agrees (median −15–18% triangles at
Shackleton and the pole, +33% at the edge; p95 −18–36%). Combined with measured
error it is the cheapest cube configuration at Shackleton and the pole, by small
margins over 0.03 alone.

**Against the polar cap, inside the cap, at the cap's accuracy:** the
simplified cube now draws **fewer triangles than the cap at Shackleton**
(0.94–1.06 vs 1.30 M) and about as many at the pole (0.92–1.02 vs 0.96 M), spends
**less GPU time** (0.29–0.36 vs 0.41–0.51 ms) and similar geometry memory
(25–29 vs 22–30 MB). It still needs **1.5–2.2× the cap's tiles and draws**, and
so 7–30% more wall time per frame on this host. Its cold load at the cap's
accuracy needs eT < 1, outside the throttled runs; the unsimplified cube there
takes 4.3 s / 33 MB at Shackleton against the cap's 4.0 s / 30 MB. At cap-nadir (40 km straight down) the cap remains
about 2× cheaper on every axis. The 25–50% triangle/GPU gap the layout
comparison recorded is closed at Shackleton and the pole by encoding parity;
what remains is draw count, from the deeper REPLACE chain (levels 0–12 against
the cap's 0–8) and the less accurate simplified leaves.

Limits: one high-end integrated GPU (the *Hardware GPU* caveats); GPU medians
of 0.2–0.5 ms vary by up to ±0.2 ms between otherwise identical rows, so only
consistent differences are claimed; one run per row except where noted;
log–log interpolation between four sweep points; no matched imagery on the
baselines; an emulated network.

## Frame overhead and main-view draw culling (2026-10-15)

*LOD error and mesh simplification* left 0.03 × spacing simplification with
fewer triangles, less geometry and GPU time, but 30–65% more tiles and no
consistent total-frame win. This slice explains where a cube-terrain frame's
time goes, why the simplified product selects more tiles, and tests one
targeted change. Same fused field, products, poses, viewport (1280×800, DPR 1),
epoch, lighting, 512 MiB tile cache, imagery targets (`maxScreenTexelError`
1.5, 160 MiB texture budget) and fade off as *LOD error and mesh simplification*.

**Hardware coverage.** One machine: Apple M4 Max (16-core CPU, 48 GB, macOS 26),
Chrome headless 148, `ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max)`. No
weaker, discrete or non-Apple GPU was used or emulated; none is needed for the
decision this slice informs (see *Remaining for #149*). The page is not
cross-origin isolated, so `performance.now()` resolves 0.1 ms with jitter:
stage costs are means over 240+ frames, totals are medians/p95.

### Instruments (`capture-cube-imagery.mjs --experiments profile`)

Per pose, at finished detail, on a cold page:

- **Stage timers** around the frame: `renderFrame`; the terrain update split
  into tile traversal/LOD/scene updates (`TilesRenderer.update`, all four
  streaming cameras) and cube imagery selection, block construction and cache
  maintenance (`CubeImageryLayer.update`); and every `WebGLRenderer.render`
  pass split at its first draw into render-list preparation (scene traversal,
  culling, sorting, shadow casters) and draw submission. Read in two modes:
  240 back-to-back frames each fenced by a 1-pixel `readPixels` (the benchmark
  kept from *Hardware GPU*, wall time including GPU completion), and the
  viewer's own `requestAnimationFrame` loop for 2 s with vsync and the frame
  cap off (`--uncapped`), so CPU and GPU pipeline as in normal use and the
  interval is the pipelined frame time. GPU time from
  `EXT_disjoint_timer_query_webgl2` in both.
- **A sampled CPU profile** (CDP, 50 µs) of the fenced frames, each sample
  assigned to the innermost stage on its stack: an independent check on the
  timers, and the self time behind one draw.
- **Footprints**: one unlit pass of every selected tile's meshes in a flat
  per-tile colour, read back: each tile's on-screen pixels. Each tile is also
  classified against the main camera — outside its frustum, or wholly behind a
  sphere below all terrain (1,727 km) — and the gap left is "in view, no
  pixels" (occluded by nearer terrain or sub-pixel).
- Surface/skirt triangles from each mesh's draw range, imagery blocks and
  their geometry, textures, geometry memory, and the 32×20 ray-cast grid that
  `dem.py field-error` scores for achieved surface error.

### 1. Where the time goes, and what is drawn

Before any change (record: [`frame-overhead-before.json`](../images/issue-149/frame-overhead-before.json)):

| Pose (terrain only, eT 2) | Selected = drawn tiles | With pixels | Outside main frustum | Behind horizon | In view, no pixels | Triangles reaching no pixel | Fenced wall / GPU (ms) | CPU: traversal + prep + submit (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shackleton | 110 | 38 | 65 | 0 | 7 | 0.63 of 0.96 M (66%) | 1.4 / 0.39 | 0.24 + 0.09 + 0.19 |
| Shackleton grazing | 134 | 25 | 79 | 0 | 30 | 0.95 of 1.17 M (81%) | 1.4 / 0.43 | 0.25 + 0.08 + 0.19 |
| South pole | 75 | 16 | 43 | 0 | 16 | 0.51 of 0.65 M (78%) | 0.9 / 0.26 | 0.15 + 0.05 + 0.12 |
| Pole grazing | 119 | 25 | 69 | 0 | 25 | 0.82 of 1.04 M (79%) | 1.3 / 0.40 | 0.22 + 0.07 + 0.19 |
| Cap nadir | 117 | 12 | 73 | 24 | 8 | 0.91 of 1.02 M (89%) | 1.2 / 0.32 | 0.19 + 0.08 + 0.17 |
| px/nz edge | 177 | 28 | 100 | 23 | 26 | 1.30 of 1.54 M (84%) | 1.7 / 0.51 | 0.28 + 0.09 + 0.25 |
| px/py/nz corner | 219 | 39 | 133 | 19 | 28 | 1.57 of 1.91 M (82%) | 2.0 / 0.65 | 0.34 + 0.10 + 0.32 |
| *Polar cap (eT 1)*, Shackleton | 142 | 57 | 83 | 0 | 2 | 0.74 of 1.24 M (60%) | 1.6 / 0.51 | 0.29 + 0.11 + 0.24 |
| *Polar cap*, cap nadir | 52 | 18 | 33 | 0 | 1 | 0.30 of 0.45 M (67%) | 0.8 / 0.21 | 0.10 + 0.06 + 0.10 |

With grid-fixture imagery refined at the same poses, draws rise to 196–359
(blocks), fenced wall to 2.5–4.3 ms, and the layer's update costs 0.32–0.60
ms and submission 0.42–0.88 ms of a 1.2–2.3 ms CPU frame; GPU stays 0.45–0.85
ms. The NAC mosaic draws 188–235 at the five poses it covers (2.0–2.9 ms).

Reading it:

- **The bottleneck is drawing what the main camera cannot see.** The tile
  renderer counts a tile in view when *any* of its cameras sees it (3d-tiles-
  renderer 0.4.27 `calculateTileViewError`), and TerrainManager registers four:
  the main camera's 1.5× wider terrain camera, a 178° coverage camera and a 90°
  nadir camera looking at the body centre, which keep the far field and the
  ground underfoot loaded. Tile meshes have three.js frustum culling off (the
  main camera's 1e-12 … 1e6 near/far gives degenerate far planes), so every
  selected tile is drawn: 66–89% of cube triangles and 60–74% of the cap's reach
  no pixel. 49–63% of the cap's tiles are off screen too; this is how the
  terrain path draws any 3D Tiles product, not a cube property.
- **Hierarchy depth is not what draws.** Replaced ancestors are not drawn
  (draws = selected tiles + 5–7 non-terrain draws, every pose). Depth costs
  traversal instead: `TilesRenderer.update` is 0.15–0.34 ms here and 0.37–0.97
  ms for simplified tiles at the face edge and corner at matched accuracy
  (below), with the draw cull on or off.
- **Where a frame's time goes.** Main-thread JavaScript is 0.35–0.8 ms of the
  0.9–2.0 ms fenced terrain frame (the CPU profile agrees: traversal 0.26, list
  preparation 0.07, submission 0.20 ms at Shackleton; submission self time is
  `setProgram`, matrix/uniform uploads and vertex-array binding, ~2 µs per
  draw). The rest of the fenced wall is the `readPixels` wait — Chrome's GPU
  process executing the command stream plus GPU work, which grows with draws
  and triangles. With imagery, the layer's selection and submission of 1.5–3×
  the draws double the CPU frame.
- **Normal animation frames are not terrain-bound on this host.** Uncapped,
  the animation loop runs at a 1.0–1.8 ms median interval whatever the terrain
  costs at 1280×800 — Chrome's per-frame floor (compositing, swap) — and every
  pose sits far inside a 120 Hz frame (8.3 ms) with vsync. The overhead was
  acceptable on this hardware before any change; what follows reduces work
  rather than rescuing a frame rate.

### 2. Why simplification needs more tiles at matched accuracy

A 0.03 × spacing RTIN leaf is less accurate than the full lattice, so the
same achieved error needs a lower errorTarget. errorTarget applies to every
streaming camera, so most of the extra selection is off screen
(record: `frame-overhead-ab.json`, achieved error from `dem.py field-error`):

| Pose | Baseline eT 2: median / p95 error (m); selected · with pixels | Simplified: eT, error; selected · with pixels |
| --- | --- | --- |
| Shackleton | 1.07 / 9.60; 110 · 38 | 1.5: 1.13 / 9.43; 131 · 45 |
| South pole | 1.53 / 7.49; 75 · 16 | 1.5: 1.41 / 7.43; 96 · 24 |
| Shackleton grazing | 0.63 / 2.62; 134 · 25 | 1.5: 0.65 / 2.99; 152 · 33 |
| Cap nadir | 4.07 / 14.68; 117 · 12 | 1.5: 5.70 / 16.58; 180 · 12 — 1: 2.98 / 13.18; 306 · 25 |
| Pole grazing | 0.16 / 0.84; 119 · 25 | 1: 0.23 / 0.85; 193 · 41 — 0.75: 0.21 / 0.77; 232 · 55 |
| px/nz edge | 1.73 / 13.04; 177 · 28 | 1: 2.00 / 8.94; 348 · 63 — 0.75: 1.63 / 8.14; 411 · 84 |
| px/py/nz corner | 1.82 / 12.05; 219 · 39 | 1: 2.61 / 9.52; 411 · 87 — 0.75: 2.14 / 8.74; 519 · 130 |

At the face centre (Shackleton, the pole) eT 1.5 matches and adds 21 selected
tiles of which 7–8 are on screen; at cap-nadir the 63 extra tiles at eT 1.5
are all off screen. At the face edge and corner the on-screen count itself
grows 2–3×: gnomonic cells there are ½–⅓ the face-centre size, so the
full lattice is 2–5× more accurate than its nominal error there (*LOD error*,
measured ÷ nominal), and a simplification threshold set from the face-centre
spacing removes exactly that slack. The median at the corner stays above the
baseline even at eT 0.75 (p95 matches from eT 1).

### 3. The change: draw only what the main camera can see

**Recorded before implementing.** Bottleneck: draws and vertex work for
selected tiles outside the main view. Mechanism: after `tiles.update()`, hide
(`scene.visible = false`) each selected tile whose bounding box lies outside
the main camera's frustum or wholly behind the horizon; the renderer still
counts it selected, so selection, loading, LRU residency and REPLACE coverage
are unchanged and the effect is on drawing only. Expected: draws and triangles
fall to the on-screen set; GPU, submission and imagery work fall with them;
traversal does not. Considered:

- *Streaming*: nothing selected or requested changes; a culled tile is already
  resident when it turns into view (it is drawn the next frame).
- *Precision*: tests are in the tile-set frame, metres, float64, without near
  or far planes — the planes that degenerate for the main camera. Conservative:
  a box is culled only if all 8 corners are outside one side plane, or all lie
  beyond the horizon plane *and* inside the shadow cone of a sphere at 0.99 ×
  the smallest ellipsoid radius (17 km below the Moon's datum; the lowest
  terrain is 9.1 km below) — a convex region, so the whole box is hidden
  (Cesium's occluder test). Boxes are subtree boxes from the written vertices,
  skirts included.
- *Memory*: geometry and cache unchanged; imagery blocks for culled tiles are
  not built (the layer skips culled tiles: no selection, blocks or requests
  for what is not drawn).
- *Independent imagery*: unchanged per drawn tile; imagery is no longer
  prefetched for tiles only the wider streaming cameras see.
- *Physical queries*: CPU queries read the cube grids, never meshes; rendered
  picking ray-casts the tile group, and three.js ray casts ignore `visible`.
- *Other cameras*: the cull is the main camera's. The instrument
  picture-in-picture view (the only other camera that renders terrain) shows
  every selected tile again before it renders. TilesFadePlugin also sets
  `scene.visible`; the cull only hides scenes the plugin left visible and
  restores exactly those before the next update.

**Implementation** (`TerrainManager`): `TerrainConfig.drawCulling` (default on
for `cubeSphere` products, off otherwise, so the polar and geographic
baselines are unchanged), `setDrawCulling()` for paired measurement,
`showCulledTiles()`, and `terrainMetrics.tiles.drawn`. The test reuses the
existing `tileInMainView`, which needed two fixes: the main-view frustum
disabled three.js plane 5 (near) instead of plane 4 (far), so its "no far
plane" kept a 50 km far plane at the surface and dropped tiles beyond it from
the imagery layer statistics it already served; and its horizon test treated a
point as hidden below its *own* tangent plane, which hides distant peaks that
are visible over the lower terrain between. The cull was not written to
remove the remaining "in view, no pixels" tiles (occlusion by terrain); that
needs occlusion queries.

### 4. Measurements

`--experiments profile --ab --repeat 3`: per pose, three cold pages; on each,
at finished detail, the cull off and on in ABBA order (BAAB on the second
page), each block 240 fenced frames and 2 s of the uncapped animation loop.
Same tiles, imagery and accuracy in both arms (identical frames, below).
Pooled medians off → on; *Δ* is the paired per-page change, median [range].
Records: [`frame-overhead-ab.json`](../images/issue-149/frame-overhead-ab.json),
summary [`frame-overhead-summary.json`](../images/issue-149/frame-overhead-summary.json)
(`node scripts/summarize-cube-ab.mjs DIR`).

*Terrain only, baseline eT 2:*

| Pose | Draws | Fenced wall median (Δ) | Wall p95 | GPU median / p95 | CPU frame | Submit |
| --- | --- | --- | --- | --- | --- | --- |
| Shackleton | 115 → 50 | 1.9 → 1.9 (−0.15 [−0.80, 0.00]) | 3.1 → 2.3 | 0.93 → 1.15 / 1.71 → 1.27 | 0.64 → 0.45 | 0.22 → 0.09 |
| Shackleton grazing | 139 → 60 | 2.3 → 2.0 (−0.20 [−0.60, −0.15]) | 3.5 → 2.5 | 1.02 → 1.16 / 1.94 → 1.32 | 0.75 → 0.59 | 0.27 → 0.13 |
| South pole | 80 → 37 | 1.1 → 0.9 (−0.20 [−0.25, −0.05]) | 2.0 → 1.6 | 0.30 → 0.28 / 1.16 → 0.79 | 0.41 → 0.33 | 0.13 → 0.07 |
| Pole grazing | 126 → 57 | 1.6 → 1.2 (−0.30 [−0.35, −0.25]) | 2.4 → 2.0 | 0.41 → 0.32 / 1.02 → 1.17 | 0.61 → 0.46 | 0.21 → 0.10 |
| Cap nadir | 122 → 25 | 1.3 → 0.9 (−0.50 [−0.95, −0.10]) | 2.7 → 1.3 | 0.36 → 0.25 / 1.44 → 0.57 | 0.54 → 0.36 | 0.20 → 0.05 |
| px/nz edge | 184 → 64 | 1.8 → 1.3 (−0.50 [−0.55, −0.50]) | 3.0 → 2.3 | 0.51 → 0.36 / 1.41 → 1.21 | 0.77 → 0.55 | 0.30 → 0.11 |
| px/py/nz corner | 224 → 74 | 2.1 → 1.4 (−0.70 [−0.80, −0.70]) | 3.1 → 2.6 | 0.66 → 0.35 / 1.58 → 1.51 | 0.87 → 0.62 | 0.34 → 0.12 |

*With imagery refined* (grid fixture; NAC at its five poses):

| Configuration, pose | Draws | Fenced wall median (Δ) | Wall p95 | GPU median | CPU frame | Imagery update |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline + grid, Shackleton | 196 → 116 | 2.2 → 1.6 (−0.55) | 3.5 → 2.7 | 0.53 → 0.41 | 1.07 → 0.75 | 0.29 → 0.17 |
| Baseline + grid, pole | 197 → 127 | 2.3 → 1.6 (−0.75) | 4.0 → 3.0 | 0.39 → 0.27 | 1.08 → 0.76 | 0.31 → 0.20 |
| Baseline + grid, cap nadir | 347 → 79 | 3.7 → 1.3 (−2.20) | 5.4 → 2.5 | 0.78 → 0.29 | 1.89 → 0.62 | 0.58 → 0.12 |
| Baseline + grid, px/nz edge | 349 → 136 | 3.7 → 1.9 (−1.65) | 5.3 → 3.7 | 0.71 → 0.38 | 2.00 → 0.96 | 0.57 → 0.20 |
| Baseline + grid, corner | 359 → 119 | 6.5 → 3.6 (−2.80) | 7.7 → 4.3 | 2.82 → 1.97 | 2.32 → 1.15 | 0.61 → 0.20 |
| Baseline + NAC, Shackleton | 208 → 113 | 2.2 → 1.5 (−0.60) | 3.8 → 3.0 | 0.52 → 0.38 | 1.01 → 0.73 | 0.29 → 0.16 |
| Baseline + NAC, cap nadir | 215 → 64 | 2.1 → 1.2 (−1.10) | 3.7 → 1.7 | 0.41 → 0.21 | 1.10 → 0.52 | 0.32 → 0.09 |
| Simplified + NAC, Shackleton (eT 1.5) | 211 → 111 | 2.4 → 1.5 (−0.90) | 3.3 → 2.3 | 0.32 → 0.26 | 1.10 → 0.73 | 0.30 → 0.15 |
| **2560×1600** baseline + grid, Shackleton | 295 → 173 | 4.2 → 3.2 (−0.85) | 5.1 → 4.4 | 1.10 → 0.78 | 1.98 → 1.38 | 0.53 → 0.31 |
| 2560×1600, cap nadir | 614 → 105 | 6.7 → 2.0 (−4.10) | 10.2 → 3.7 | 1.29 → 0.43 | 3.76 → 1.10 | 1.10 → 0.18 |
| 2560×1600, px/nz edge | 568 → 150 | 6.6 → 3.2 (−3.25) | 8.7 → 4.2 | 1.59 → 0.91 | 3.69 → 1.40 | 1.03 → 0.25 |
| 2560×1600, corner | 614 → 139 | 7.5 → 3.6 (−3.70) | 9.1 → 4.5 | 1.90 → 1.15 | 4.06 → 1.53 | 1.09 → 0.23 |

Every pose and configuration is in the summary (simplified terrain and grid at
eT 1.5, 1 and 0.75; the polar cap with the cull switched on for comparison).
Paired wall changes are negative on every page of every imagery row; for
baseline terrain they are −0.15 to −0.70 ms median, with single pages from
0.00, and one cap-nadir page of the culled polar cap is +0.10.
Terrain-only GPU medians of 0.2–1.2 ms move by ±0.2 ms between identical
blocks on this host, so the GPU column is claimed only where consistent (all
imagery rows, the edge and corner); Shackleton terrain's +0.2 ms is within that
spread (its p95 falls).

**Normal animation frames.** At 1280×800 the uncapped interval stays at the
0.9–1.8 ms browser floor in both arms (terrain, NAC); with grid imagery it
falls where the uncull frame exceeded the floor (cap nadir 1.9 → 1.1 ms,
corner 2.3 → 1.5); at 2560×1600 it falls 2.1 → 1.6 (Shackleton) and
3.7–4.3 → 1.4–1.5 ms (cap nadir, edge, corner), p95 4.8–5.2 → 2.0–2.2 ms.
With vsync, navigation (below) never misses a 120 Hz refresh because of
terrain alone.

**Navigation** (`--experiments navigate --repeat 2`, record
[`frame-overhead-navigate.json`](../images/issue-149/frame-overhead-navigate.json)):
the *cracks-dynamic* path — 3,000 km → Shackleton (refining), out to 600 km
(coarsening), then across the pole, px/nz edge and px/py/nz corner at 40–60
km — flown in the normal vsync'd animation loop, 410 interpolated frames, cold
page per run, cull off/on alternating; medians over the path:

| Run | Drawn of selected (mean, max) | Frame CPU median / p95 | GPU median / p95 | Long frames (> 1.5× interval) | .glb requests / MB | Imagery requests / MB | Finished after path |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Terrain, off | 88 of 88 (177) | 1.0 / 1.8–1.9 ms | 1.20 / 2.02–2.06 | 0 | 698–739 / 112–119 | — | 3.5–3.6 s |
| Terrain, on | 25 of 88 (63–68) | 0.8 / 2.0–2.1 ms | 0.63–0.64 / 1.05 | 0 | 708–731 / 114–118 | — | 3.6 s |
| Grid, off | 87 of 87 (174) | 3.0 / 9.6–10.0 ms | 1.59 / 2.65–2.72 | 22, 27 | 654–682 / 105–110 | 641–643 / 18.2–18.3 | 3.6 s |
| Grid, on | 25 of 88 (60–71) | 1.5–1.6 / 8.3–8.4 ms | 0.86–0.87 / 1.48–1.52 | 22, 18 | 667–692 / 107–111 | 554–558 / 16.4 | 3.6 s |
| Simplified + grid (eT 1.5), off | 121 of 121 (219) | 2.8–2.9 / 6.8–7.2 ms | 1.15 / 1.62–1.63 | 13, 10 | 906–912 / 78 | 628–634 / 18.2–18.6 | 3.5–3.6 s |
| Simplified + grid (eT 1.5), on | 31 of 121–123 (63–69) | 1.6 / 5.3–5.6 ms | 0.71 / 1.01–1.02 | 3, 4 | 900–929 / 77–80 | 548–558 / 16.2–16.3 | 3.6 s |

Terrain requests and bytes are unchanged within run-to-run spread (the same
selection); imagery requests fall 13% (no prefetch for tiles only the
streaming cameras see) with no change in time to finished detail. Long frames
occur only with imagery (terrain-only runs have none), where frame CPU p95 is
5–10 ms either way; the cull reduces them for the simplified product (10–13 →
3–4) but not the baseline, and their cause is not isolated here.

**Matched accuracy, simplified against baseline, cull on** (the cull leaves
accuracy untouched: identical frames). At the face centre the simplified
product's draw penalty is gone: Shackleton 57 vs 50 draws (1.1 vs 1.9 ms
fenced, GPU 0.26 vs 1.15 ms — the baseline's GPU there is the noisy row),
pole 44 vs 37 (0.9 vs 0.9 ms); with imagery 117 vs 116 and 116 vs 127 draws.
At cap nadir, between eT 1.5 and 1 (bracketing the baseline's median and
p95), 20–33 vs 25 draws, 1.1–1.3 vs 0.9 ms. At the face edge and corner it
still needs about 2× the drawn tiles of the baseline (eT 0.75: 125 / 164 vs
64 / 74 draws, 2.2 / 2.6 vs 1.3 / 1.4 ms) and traversal 0.72–0.91 vs
0.32–0.38 ms — the on-screen effect of section 2, which the cull cannot remove.
Inside the cap the cube with the cull now draws fewer tiles than the cap
without it at every pose, but the like-for-like comparison is the cap culled
too (an experiment here, `setDrawCulling(true)` on the cap's terrain): cap
Shackleton 64 draws / 1.3 ms against the cube's 50 / 1.9 and simplified 57 /
1.1 ms; cap nadir 24 / 0.8 ms against 25 / 0.9 and 20–33 / 1.1–1.3 ms.

### 5. Correctness

With the cull on (default for cube products):

- **Nothing visible is removed.** Every A/B page: the displayed frame with the
  cull off and on differs in 0 pixels (141 pages at 1280×800 and 2560×1600,
  terrain, grid, NAC, baseline and simplified); the footprint pass draws
  culled tiles too and finds 0 culled tiles with any pixel; rendered picks
  (`pickSurface`, 16×10 grid) differ in 0 of 96–160 hits per pose.
- **Delayed, failed and evicting loads** (`cracks-dynamic`, record
  [`frame-overhead-gates.json`](../images/issue-149/frame-overhead-gates.json)):
  35 steps each of refining, coarsening and panning across the pole, edge and
  corner without waiting for detail — normal, child .glb delayed 2.5 s
  (17 steps still loading), level ≥ 9 failing, and a 24–40 MiB evicting cache:
  0 hole pixels with skirts in every step, as before; 2,010–2,353 culled
  tile-steps per scenario, 0 with pixels. REPLACE coverage, bounds, picking
  and clearance are the product's (unchanged; `validate-cube-terrain.mjs`:
  all gates pass, re-run on this branch).
- **Imagery** (`registration,markers,failure,navigation`, same record):
  registration median 0.41 texel in every ground view (0.52 overview), p95 ≤
  0.72, 0 face/tile mismatches, the same 2.77-texel grazing outlier at
  Shackleton; failure fallback holds at level 6 with 0 untextured blocks;
  navigation under 64 MiB: ≤ 180 textures, ≤ 63.8 MiB, queues drained.
- **Residency stays bounded**: terrain cache and geometry unchanged by
  construction; texture budget as before; block geometry falls with the
  blocks of culled tiles (freed after 2 s unused).
- **CPU/rendered-surface discrepancy: unchanged.** The cull changes neither
  emitted triangles nor CPU grids: the simplified product's per-tile
  rendered/CPU bound (`cpu-grids.json` `renderedMesh`, `tiles[i][5]`) and the
  baseline's float32-only agreement stand as recorded in *LOD error and mesh
  simplification*; query accuracy metadata is untouched.
- Tests: `tileInMainView` (frustum without near/far, the conservative horizon,
  a peak below its own tangent plane but visible over the horizon sphere, a
  camera inside the sphere), the cull/restore cycle on a cube TerrainManager
  (a fading tile another owner hid stays hidden), and the imagery layer
  skipping a culled tile.

Visual: [`frame-overhead-cull.jpg`](../images/issue-149/frame-overhead-cull.jpg)
— per pose, the frame with the cull off and on (identical), and a view from
behind and above with drawn tiles green and culled red (Shackleton 45 / 65,
cap nadir 20 / 97, corner 69 / 150; the corner pose is in lunar night at the
catalog epoch, so its shaded frames are dark).

### 6. Recommendation: retain

Retain the main-view draw cull, on by default for cube products. It removes
the largest overhead measured — selected tiles drawn for no pixels — with no
visible, picking, streaming, query-accuracy or imagery-registration change,
and its largest wins are exactly where cube costs were highest (imagery,
face edge/corner, cap nadir, large viewports). It does not by itself make
simplification the default: at the face centre the simplified product now
draws as little as the baseline, but at the face edge and corner it still
needs 2× the on-screen tiles and 2–2.5× the traversal at matched accuracy.
Applying the cull to the polar and geographic products is a separate change
(same code, `drawCulling: true`), deliberately not made here so the baselines
stay as measured.

## Reproducible checks delivered

The unit fixture creates all six root faces from one analytic height function.
It exercises poles, the longitude wrap, face edges/corners, deterministic tile
ownership, finer resident geometry selection with parent fallback, unloaded
behavior, provenance, equivalent longitudes and both poles at level 1, rejection
of unsupported datums, and a strongly flattened oblate ellipsoid where the
geodetic normal and geocentric ray select different faces. Tests reconstruct a direction after
every forward/inverse operation because the same edge has valid coordinates on
two faces.

For imagery, `CubeImagery.test.ts` checks the pixel-corner convention and gutters
on every face, exact pole/antimeridian/corner addressing, projective coordinates
against direct face coordinates at any height (and against affine
interpolation, which drifts), texture transforms to finer and coarser imagery,
geometry-independent level selection, block budgets and the view test, clipping
that partitions a tile exactly (area preserved, vertices on the original
triangles, cell-aligned and sub-cell blocks, at the pole and a face corner) and
manifest validation. `CubeImageryLayer.test.ts` drives the layer with an
injected loader over a fixed coarse geometry tile: refinement 4+ levels below
it with the original mesh untouched and blocks at its world transform,
coarsening and block disposal, failure fallback without retry storms or
descending below failed tiles, the texture budget with pinned levels, aborts and
bounded requests under camera motion, and restoring the original mesh for other
debug views.

For crack mitigation, `CubeImagery.test.ts` also checks that skirts lying in a
tile's boundary planes survive block clipping exactly once (23% of skirt area
was lost before the fix) and carry their edge's projective coordinates;
`CubeImageryLayer.test.ts` that blocks follow the tile's draw range and rebuild
when it changes; `dem.py selftest` builds the synthetic product with skirts and
checks their shape, extras and coverage at coincident vertices.

These checks are intentionally small and source-independent. They establish the
addressing and CPU contract, but are not substitutes for the authoritative fused
lunar field or GPU evidence.

## Required evidence before adoption

1. ✅ A bounded builder over the authoritative fused field: six coarse faces,
   Shackleton and edge/corner detail, GLB/3D Tiles, immutable datum/source metadata.
2. ✅ (without skirts) REPLACE coverage, subtree bounds, edge/corner agreement,
   mixed-LOD cracks, control points, picking, camera clearance and absent CPU
   data; ✅ repeated with skirts as the mitigation (*Mixed-LOD crack
   mitigation*): coverage gated, CPU grids unchanged, picks and clearance at
   the worst boundaries.
3. ✅ (map imagery; software rendering and one hardware GPU) Register an
   independently refined controlled imagery pyramid and demonstrate geometry/image
   LOD combinations along all selected paths: see *Independent imagery*.
4. ◐ Compare cube, geographic, and geographic-plus-polar products with the same
   physical source, viewport, lighting, cache budgets and camera paths. Done
   for geometry (*Layout comparison*): all three products, same poses, cache,
   lighting and epoch, coverage measured per frame, cost at equal achieved
   error. Not done: imagery on the baselines; a geographic-plus-polar
   composite (no join exists, by decision — the cap is compared inside its
   footprint, where coverage is equal).
5. ◐ Record requests/bytes, tiles, memory, generation time/product bytes,
   CPU-grid/triangle discrepancy, seam error and control-point error, cold
   loading over an emulated network and warm frame-time distributions with the
   GPU and driver recorded (done, Apple M4 Max / ANGLE Metal), with the frame
   decomposed by stage and normal animation-loop timing (*Frame overhead*).
   Not done: a real network. Other GPUs are optional extra coverage, not a
   requirement.

### Remaining for #149

Exact checklist for the adopt/revise/reject decision (*Recommendation from the
geometry evidence*):

- [x] **Cube vs cap cost gap, (a) geometric error.** Done with a conservative
  triangle-mesh bound from the emitted meshes rather than the sampled grid
  representation error, which is not one (*LOD error and mesh simplification*):
  no gain at matched error; nominal spacing stays.
- [x] **Cube vs cap cost gap, (b) draw count.** Explained and cut (*Frame
  overhead and main-view draw culling*): the gap was mostly off-screen tiles
  the streaming cameras select, drawn for no pixels. Retained: the main-view
  draw cull, on for cube products. A shallower REPLACE chain stays an option
  only for traversal (0.2–1.0 ms) and loading, not draws.
- [x] **Encoding parity.** `--simplify` (RTIN, edges kept, so skirt gaps are
  unchanged and gated), CPU-grid/triangle discrepancy stated per tile and
  gated. 0.03 × spacing is the useful setting. As a product default it still
  costs 2× the on-screen tiles and traversal at the face edge and corner at
  matched accuracy (the threshold comes from face-centre spacing; an
  edge-aware threshold is the candidate fix) and widens the rendered/CPU
  discrepancy below; it stays opt-in.
- [ ] **Rendered/CPU twist discrepancy.** Simplified tiles still differ from the
  CPU lattice by up to ~0.2 × vertex spacing where an RTIN anti-diagonal half
  borders a coarser triangle; a twist-aware RTIN error, or a CPU surface built
  on the rendered triangulation, would remove it.
- [ ] **Matched imagery.** The NAC mosaic (and a global source, e.g. LROC WAC)
  on the cap (#147 path) and on the geographic product through the upstream
  overlay, at a matched texel target; then the same frame, memory and request
  captures with imagery, kept apart from the geometry costs above.
- [x] **Acceptable performance on the available hardware.** M4 Max, every
  configuration: fenced frames ≤ 3.6 ms at 1280×800 and 2560×1600 with the
  cull, animation loop at the browser floor, no missed 120 Hz refresh from
  terrain alone (*Frame overhead*). Other GPUs would be useful extra
  coverage; they are not an adoption gate and were not acquired or emulated.
- [ ] **A real network.** Cold loads from hosted data instead of the
  emulated link (not blocking: the cull changes no terrain requests).
- [ ] **Draw cull on the baselines (optional).** `drawCulling: true` on the
  polar and geographic products would cut their off-screen draws the same
  way (49–63% of the cap's tiles); not applied here so they stay as measured.
- [ ] **Prefiltered coarse levels.** `gdaladdo -r average` overviews for the
  LOLA base (all products): smaller coarse-level gaps (the skirts now cover up
  to 3.6 km) and coarse representation error.
- [x] **Log depth precision.** #189 merged; captures re-run on the merged code
  (*Skirts drawn through nearer surface*).
- Imagery-at-scale items from *Independent imagery* (shared vertex buffers for
  blocks, a tiled-layout `MapImageLayer` variant) stay open.

Commands: `bash scripts/build-moon-terrain/cube.sh --workers N` (also writes
`tileset-measured.json` / `mesh-error.json` via `dem.py cube-error DIR`);
`CUBE_OUT=…/moon-terrain-cube-simplified-003 bash scripts/build-moon-terrain/cube.sh --simplify 0.03`;
`node scripts/validate-cube-terrain.mjs [--dir …]`;
`node scripts/capture-cube-imagery.mjs --gpu --experiments compare --frames 240 --error-target E --cube-tileset DIR/TILESET --label L [--shots]`;
`node scripts/capture-cube-imagery.mjs --gpu --experiments cracks,cracks-dynamic,skirt-cost`;
`node scripts/capture-cube-imagery.mjs --gpu --experiments compare [--products P] [--error-target N] [--throttle 40,100]`,
then `python3 scripts/terrain/dem.py field-error RECORD.json --base … --fusion …`;
frame overhead: `node scripts/capture-cube-imagery.mjs --gpu --uncapped --experiments profile [--cpu-profile] [--ab --repeat 3] [--catalog grid|nac] [--products polar] [--cube-tileset …] [--error-target E] --label L`,
`node scripts/summarize-cube-ab.mjs DIR`, `--experiments navigate --repeat 2 [--catalog grid]` (vsync, no `--uncapped`),
`--experiments cracks-dynamic` and `--experiments cull-view`.

No permanent polar/global join and no removal of either baseline until the
decision.

[qsc]: https://proj.org/en/stable/operations/projections/qsc.html
