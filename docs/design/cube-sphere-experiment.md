# Cube-sphere terrain experiment (ADR)

**Status:** open; experimental, not a production layout or a measured verdict
**Issue:** #149 (remains open)
**Recorded:** 2026-10-04 (foundation); 2026-10-13 (lunar builder and viewer demo); 2026-10-14 (independent imagery)

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
imagery*). Mixed-LOD crack mitigation, a hardware-GPU performance comparison and
the geographic(-plus-polar) side of the comparison remain; see *Remaining for #149*.

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
  the parent's straight edge. The product ships **without skirts** so the cracks
  can be measured and seen; `cube.sh --skirt-cells 1` adds the polar cap's
  edge-normal skirts. A crack-free alternative (constraining child edge vertices
  to the parent edge, or geomorphing) is not attempted here.
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
  first), at most 8 in flight; a request nobody has wanted for 30 frames is
  aborted; when the budget is full of textures in use, new requests stop
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

### What this proves, and what it does not

Proven here, on software rendering:

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

- **Cost on a GPU.** Blocks multiply draw calls (+81 to +225 per view here) and
  duplicate split tiles' vertices (11–25 MB per view); every cube tile carries
  the 12-byte projective attribute. Software rendering cannot
  say whether that matters; a hardware-GPU frame-time distribution must, and if it
  does, the block geometry can share the tile's vertex buffer (index-only
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

These checks are intentionally small and source-independent. They establish the
addressing and CPU contract, but are not substitutes for the authoritative fused
lunar field or GPU evidence.

## Required evidence before adoption

1. ✅ A bounded builder over the authoritative fused field: six coarse faces,
   Shackleton and edge/corner detail, GLB/3D Tiles, immutable datum/source metadata.
2. ✅ (without skirts) REPLACE coverage, subtree bounds, edge/corner agreement,
   mixed-LOD cracks, control points, picking, camera clearance and absent CPU
   data. Repeat with skirts only as a mitigation, after this record.
3. ✅ (map imagery, software rendering) Register an independently refined
   controlled imagery pyramid and demonstrate geometry/image LOD combinations
   along all selected paths: see *Independent imagery*. The hardware-GPU cost of
   its blocks and textures belongs to item 5.
4. ◐ Compare cube, geographic, and geographic-plus-polar products with the same
   physical source, viewport, lighting, cache budgets and camera paths. Done:
   cube vs polar cap at Shackleton and the pole from one script and pose set.
5. ◐ Record requests/bytes, tiles, memory, generation time/product bytes,
   CPU-grid/triangle discrepancy, seam error and control-point error (done), and
   cold time to target surface error and warm frame-time distribution on a
   hardware GPU with its driver and display recorded (not available here).

### Remaining for #149

- **Mixed-LOD cracks first.** Decide between skirts, constrained parent edges
  and geomorphing using the crack table above; prefilter coarse base levels
  first. Imagery now drapes across those cracks, so they are visible as
  background slivers between differently refined tiles.
- **Imagery cost at scale.** The block approach's extra draws and duplicated
  block geometry (measured above) need a hardware-GPU frame-time measurement; if
  they matter, share the tile's vertex buffer and index cell-aligned blocks
  (clipping only sub-cell blocks), or composite blocks into one texture per draw.
  A real global imagery source (e.g. LROC WAC) and a contract variant of
  `MapImageLayer` for tiled layouts remain open; so does the same imagery on the
  geographic and polar baselines, for a matched imagery comparison.
- **Geographic side of the comparison.** Build `fused.sh` (~45 min, ~11 GB) and run
  `capture-cube-terrain.mjs --product geographic` over the same poses; compare
  against a geographic-plus-polar composite only once one exists (there is no
  permanent join, by decision).
- **Hardware GPU.** Re-run the captures on a GPU host with warm-cache frame-time
  distributions, at matched far-field coverage (the polar cap needs a global
  product underneath to compare horizon cost).
- **Fair comparison.** Geographic/polar/cube at matched achieved surface detail,
  imagery quality and far-field coverage, including hardware-GPU measurements.

Neither the #178 product nor this imagery slice establishes a layout win.
Revisit this ADR with those artifacts and choose adopt, revise, or reject. Until
then there is no permanent polar/global join and no removal of either baseline.

[qsc]: https://proj.org/en/stable/operations/projections/qsc.html
