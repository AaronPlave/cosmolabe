# Issue 157: graticule implementation and validation

The production path is a procedural graticule in surface materials. Coordinates
come from physical body-fixed position and the declared reference shape, using
the same core conversions as terrain sampling, Point Probe and surface navigation.
The grid never uses display-radius fallbacks or a radius-inflated shell.

Spheres and rotational ellipsoids use geodetic latitude; triaxial globe reference
ellipsoids use planetocentric latitude. Longitude is east-positive and wrapped to
[−180°, 180°). Labels include E/W. The frame is the rotation model’s declared target frame when supplied (including
SPICE rotations), otherwise `BODY_FIXED:<name>`; this does not invent an IAU
frame for a catalog without one. Grid transforms use
`BodyMesh.bodyToWorldQuaternion`, including the no-rotation case, and do not
inherit model mesh pre-rotation. Placeholder bodies, stars, spacecraft,
barycenters, exaggerated minimum-pixel bodies and mesh bodies have no grid.

Density uses a fixed screen sampling lattice and local latitude/longitude
projection derivatives, rather than the whole-body diameter. Independent nice
steps range from 30° to 0.001°, with a 60–180 px hysteresis band around a tunable
100 px target. Level changes crossfade over 180 ms. Fragment derivatives provide
antialiasing, suppress subpixel lattices and congested polar meridians, and handle
the longitude seam by differentiating its unit vector. Equator and prime meridian
have stronger contrast. Minor lines are optional.

Coordinate labels stay 12 CSS px, with DPR-aware rasterization. Candidates come
from sampled visible line positions, prefer prior anchors, and are bounded at
96 per body and 24 pooled sprites. Labels use the existing LabelManager
reservations and yield to body labels, event callouts, and host measurement/probe
reservations. Point Probe reserves its visible panel. Surface normals and
reference intersections suppress the far side/horizon; terrain intersections
check the actual surface anchor and its association with the labelled line.
Billboard glyphs use the body-label overlay convention after CPU anchor occlusion;
surface/grid depth testing remains enabled. Terrain/other-body triangle queries
are limited to eight per body per frame; hits are cached at an unchanged view
for at most 150 ms. Camera/body transform changes invalidate that cache.

Display preferences, camera JSON and script snapshots carry scope, pinned bodies,
per-body visibility/labels, Auto/manual density, labels and minor lines. `G`
remains the master switch; tracked-body scope is the default. Explicit targets
are independent of selection. The optional-body renderer visibility path remains
available and stores configuration before a body mesh is loaded.

## Rendering comparison

The asset-free harness compares the original implementation at
`8d685f73f94cab63bca54d4d16c6eee909a2a89a` with the new path. It also builds a
bounded CPU-sampled draped-line prototype over a synthetic resident height grid:
0.5 px projected chord-error refinement, depth ≤10, ≤4096 segments, and no fetches.
The same synthetic rendered mesh is used for the shader and line captures.

Draped geometry needs resident elevation data, rebuilding/cache invalidation,
refinement budgets, and clearance between its sampled surface and rendered LOD.
The prototype remains naturally depth-tested and demonstrates gaps where CPU
samples differ from the rendered triangulation. The shader follows every
rendered fragment without extra line buffers, terrain queries for lines, or
additional tile requests. It composes with existing imagery, shadow and
atmosphere shader hooks. Shared tile materials get per-mesh transform uniforms;
local overlays preserve body-fixed semantics in the camera-relative pass. Labels
render in the final annotation scene after terrain/local overlays; density and
visibility update after the current camera and terrain updates.
Oblate latitude conversion has a bounded eight-iteration cost; spheres bypass
that conversion. Skirts and transitions inherit the rendered mesh's physical
coordinates. CPU elevations remain a separate analytical authority.

The shader is therefore the chosen production path. Reference-globe and
rendered-terrain semantics are explicit; no terrain conformity is claimed for
an unloaded reference globe or an irregular mesh. DSK draping and general
triaxial geodetic coordinates remain unavailable.

The final matched 0.5° synthetic line-only comparison has no labels in either
path. The shader uses one surface draw and zero extra grid geometry; the draped
prototype adds a draw, 192 segments / 4,608 bytes, and 1,080 resident CPU samples,
with 0.5 px refinement and maximum depth 4. Its one-time construction took
43.7 ms in this run; both steady frame medians were about 0.2 ms. This supports
the registration/memory decision, not a claim that every shader frame is faster.

| Fixture | Before calls | After calls | After step | After candidates / labels | After median update / frame |
| --- | ---: | ---: | --- | --- | --- |
| Whole Moon | 35 | 9 | 30° / 30° | 44 / 8 | 0.1 / 0.3 ms |
| Regional Mars | 22 | 13 | 0.2° / 0.2° | 96 / 12 | 0.2 / 0.5 ms |
| Synthetic terrain with labels | 22 | 15 | 0.5° / 0.5° | 96 / 14 | 0.2 / 0.4 ms |

All captures report zero grid-triggered requests. The raw metrics are the
source of truth for timings, geometry/texture counts and other views. The 24
PNGs include 11 comparable before/after pairs and two matched terrain prototypes.

## Reproduce

Run the viewer Vite server in one terminal:

```sh
npm --prefix apps/viewer run dev -- --host 0.0.0.0
```

Then run:

```sh
node scripts/graticule-validation.mjs
```

`CHROMIUM_PATH`, `GRID_VIEWER_URL`, `GRID_BASELINE_REF` and `GRID_CAPTURE_DIR`
can override defaults. The harness generates and removes a temporary baseline
module/HTML page. PNGs are comparable before/after views; `metrics.json` contains
draw calls, geometry/texture counts, candidate/label counts, chosen spacing,
CPU update and frame timings, plus draped-prototype memory/refinement statistics.
Timings use headless Chromium SwiftShader and `gl.finish`, and are development
fixture measurements, not hardware GPU or live terrain streaming claims.

## Coverage and limits

Captured: whole Moon/Earth, oblique hemisphere, away from prime meridian/equator,
south pole, antimeridian, Jezero-coordinate regional Mars, bright/dark surfaces,
a 390×844 DPR2 viewport, and synthetic rendered-terrain shader/draped comparison.
The harness finishes with no browser/shader errors.

Automated fixtures cover sphere/oblate/triaxial coordinate round trips,
east/west conversion, wrapping/formatting, frame/model rotation, density
hysteresis/bounds, regional refinement, per-body/master visibility and complete
saved-state script replay. Typecheck, lint and purity checks pass.

The initial full run failed because SPICE kernels were LFS pointers. Restoring
the existing cached objects resolved those failures:

```sh
git lfs pull --include='kernels/fixtures/**,packages/spice/test-kernels/**' --exclude=''
git lfs pull --include='apps/viewer/test-catalogs/kernels/**' --exclude=''
```

The changed renderer/control/viewer paths and core coordinate fixtures pass 713
tests. A main-viewer smoke capture with textured Earth and atmosphere also
confirms material composition and matching Point Probe coordinate metadata
(`viewer-earth-textured.png`). The browser's only resource error was a missing
favicon, with no shader or application errors.

The high-concurrency full run passed 1,555 tests and exposed one existing
100 ms progress-throttle timing assertion in `gf-reporting.test.ts`; its 24-test
suite passes in isolation. `npm test -- --maxWorkers=2` passes all 139 suites / 1,556 tests.

Actual streamed lunar/Mars terrain, Shackleton imagery, natural/flood-light
terrain, streamed mixed-LOD transitions, ground/tangent views and
selected-event/measurement collision screenshots still require the generated
terrain products (`moon-terrain-fused`, `mars-terrain-fused`, etc.), which are
absent from this workspace. The synthetic captures do not substitute for those
remaining acceptance checks. General mesh-body reference grids are explicitly
unavailable.
