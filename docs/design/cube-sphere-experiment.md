# Cube-sphere terrain experiment (ADR)

**Status:** revise; experimental, not a production layout
**Issue:** #149
**Decision date:** 2026-10-04

## Decision

Keep the geographic and polar products as the production baselines. Continue a
cube-sphere experiment using the gnomonic mapping below, but do not migrate or
publish a global product yet. The experiment now has deterministic addressing,
a renderer-independent CPU height payload, complete six-face synthetic coverage,
and a non-spherical ellipsoid fixture. It does **not** yet have the required lunar
reprojection, 3D Tiles renderer integration, GPU captures, or comparable runtime
and product-size measurements. Those missing results are decision gates, not
work that an implementation may silently infer.

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
ellipsoid test fixture. Generated vertices must reconstruct the declared
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

## Reproducible checks currently delivered

The unit fixture creates all six root faces from one analytic height function.
It exercises poles, the longitude wrap, face edges/corners, deterministic tile
ownership, finer resident geometry selection, unloaded behavior, provenance,
and a strongly flattened oblate ellipsoid. Tests reconstruct a direction after
every forward/inverse operation because the same edge has valid coordinates on
two faces.

These checks are intentionally small and source-independent. They establish the
addressing and CPU contract, but are not substitutes for the authoritative fused
lunar field or GPU evidence.

## Required evidence before adoption

1. Add a bounded builder mode that reads the authoritative lunar fused field,
   emits six coarse faces plus Shackleton and selected edge/corner detail through
   the existing GLB/3D Tiles path, and writes immutable datum/source metadata.
2. Validate complete REPLACE coverage, conservative subtree bounds, edge/corner
   agreement, mixed-LOD cracks, source control points, picking, camera clearance,
   and absent CPU data. Run the same validations without skirts before using
   skirts as a rendering mitigation.
3. Register an independently refined controlled imagery pyramid and demonstrate
   geometry/image LOD combinations along all selected paths.
4. Compare cube, geographic, and geographic-plus-polar products with the same
   physical source, viewport, lighting, cache budgets, and camera paths:
   Shackleton, pole crossing, orbit overview, face edge, and face corner.
5. Record requests/bytes, active and decoded tiles, CPU/GPU memory where APIs
   expose it, cold time to target surface error, warm frame-time distribution,
   generation time/product bytes, CPU-grid/triangle discrepancy, seam error, and
   control-point error. Record browser, renderer revision, GPU, driver, display
   resolution, viewport, pixel ratio, cache state, and imagery/geometry settings.

Revisit this ADR with those artifacts and choose adopt, revise, or reject. Until
then there is no permanent polar/global join and no removal of either baseline.

[qsc]: https://proj.org/en/stable/operations/projections/qsc.html
