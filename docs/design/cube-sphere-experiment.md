# Cube-sphere terrain experiment (ADR)

**Status:** open; experimental, not a production layout or a measured verdict
**Issue:** #149 (remains open)
**Recorded:** 2026-10-04 (foundation); 2026-10-13 (lunar builder and viewer demo)

## Decision

Keep the geographic and polar products as the production baselines. Continue a
cube-sphere experiment using the gnomonic mapping below, but do not migrate or
publish a global product yet. This record is not the layout decision, which
waits for the evidence still listed as remaining at the end.

Delivered so far: deterministic addressing and a renderer-independent CPU height
payload (foundation), then a bounded lunar builder over the authoritative fused
field, an opt-in viewer demo with CPU readout, picking and clearance through the
#148 port, numerical validation of the real product, and software-rendered
captures from the same camera poses as the #145 polar cap. Independent imagery
refinement, a hardware-GPU performance comparison and the geographic(-plus-polar)
side of the comparison remain; see *Remaining for #149*.

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
and material/overlay facilities before adding custom split logic.

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

## Reproducible checks delivered

The unit fixture creates all six root faces from one analytic height function.
It exercises poles, the longitude wrap, face edges/corners, deterministic tile
ownership, finer resident geometry selection with parent fallback, unloaded
behavior, provenance, equivalent longitudes and both poles at level 1, rejection
of unsupported datums, and a strongly flattened oblate ellipsoid where the
geodetic normal and geocentric ray select different faces. Tests reconstruct a direction after
every forward/inverse operation because the same edge has valid coordinates on
two faces.

These checks are intentionally small and source-independent. They establish the
addressing and CPU contract, but are not substitutes for the authoritative fused
lunar field or GPU evidence.

## Required evidence before adoption

1. ✅ A bounded builder over the authoritative fused field: six coarse faces,
   Shackleton and edge/corner detail, GLB/3D Tiles, immutable datum/source metadata.
2. ✅ (without skirts) REPLACE coverage, subtree bounds, edge/corner agreement,
   mixed-LOD cracks, control points, picking, camera clearance and absent CPU
   data. Repeat with skirts only as a mitigation, after this record.
3. ⬜ Register an independently refined controlled imagery pyramid and demonstrate
   geometry/image LOD combinations along all selected paths.
4. ◐ Compare cube, geographic, and geographic-plus-polar products with the same
   physical source, viewport, lighting, cache budgets and camera paths. Done:
   cube vs polar cap at Shackleton and the pole from one script and pose set.
5. ◐ Record requests/bytes, tiles, memory, generation time/product bytes,
   CPU-grid/triangle discrepancy, seam error and control-point error (done), and
   cold time to target surface error and warm frame-time distribution on a
   hardware GPU with its driver and display recorded (not available here).

### Remaining for #149

- **Imagery.** The cube faces need an independently refined imagery pyramid
  draped by the `MapImageLayer` contract. The installed overlay plugin derives
  UVs from vertex longitude, which breaks on tiles that contain a pole or cross
  the antimeridian (every `nz`/`pz` tile, the `nx` face), so this needs a
  face-aware projection adapter rather than configuration.
- **Geographic side of the comparison.** Build `fused.sh` (~45 min, ~11 GB) and run
  `capture-cube-terrain.mjs --product geographic` over the same poses; compare
  against a geographic-plus-polar composite only once one exists (there is no
  permanent join, by decision).
- **Hardware GPU.** Re-run the captures on a GPU host with warm-cache frame-time
  distributions, at matched far-field coverage (the polar cap needs a global
  product underneath to compare horizon cost).
- **Mixed-LOD cracks.** Decide between skirts, constrained parent edges and
  geomorphing using the crack table above; prefilter coarse base levels first.

Revisit this ADR with those artifacts and choose adopt, revise, or reject. Until
then there is no permanent polar/global join and no removal of either baseline.

[qsc]: https://proj.org/en/stable/operations/projections/qsc.html
