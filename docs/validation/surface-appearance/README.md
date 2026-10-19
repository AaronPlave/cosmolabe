# Surface appearance MVP — issue #182

Select a terrain body and open its info panel. **Surface appearance** provides
a base color (Imagery, Elevation colors, or Neutral gray) and one independent
Hillshade effect. There is one Imagery amount control for elevation/gray: 0%
shows that base color and 100% shows imagery. Hillshade lights the resulting
color, so there is no second opacity/blend operation.
Artificial light azimuth is clockwise from geographic north, elevation is above
the local tangent plane, and contrast affects displayed shading only. Three
palettes share a fixed, editable kilometre range and a compact clipping legend.
Pick minimum and Pick maximum independently set one range bound from a clicked
colored terrain point. A crossing bound or a miss leaves the pick armed with
feedback; Escape/Cancel ends it. Point Probe, measurement picks and appearance picks are mutually exclusive.
Starting any one ends the others. Appearance owns shared hover/click/touch input
without depending on measurement input setup; Escape cancels it first, and
scene/panel replacement clears it. Invalid manual bounds are marked and rejected
using the same validation as picked bounds; neither silently moves the other bound.

## Rendering contract

- Operates on loaded quantized-mesh terrain and validated Cosmolabe cube-sphere
  products. See [cube-sphere integration and GPU evidence](../cube-surface-appearance/README.md)
  for #260. Imagery-only surfaces, generic 3D Tiles/ion models, unknown/areoid
  references, and unsupported normal-height triaxial references remain excluded.
- Elevation colors interpolate per-vertex heights computed from the existing
  positions, in double precision, relative to the sampler's body reference shape.
  Radial and axisymmetric geodetic-normal conventions are supported. The Mars
  scene uses `[3396.19, 3396.19, 3376.2] km` and the existing `8.765 km` decode
  offset; Moon uses the `1737.4 km` reference sphere. These are rendered-reference
  heights, not a new areoid/geoid product or certified measurements. Skirts and
  coarse approximations are part of the loaded geometry.
- Tile coordinates are metres in ECEF, Z north. Each material retains its
  float64 local-to-ECEF transform before the tiles group's metre-to-kilometre
  scaling, `-π/2` axis conversion, body attitude, and camera-relative origin.
  Hillshade subtracts each triangle's reference-ellipsoid normal from its terrain
  normal, averages the area-weighted corrections, and reconstructs the displayed
  normal from analytic local up after interpolation. This removes coarse mesh
  curvature bias without flattening real relief. It shares boundary contributions by geographic position (0.00001 degree
  keys). Small height differences do not split the normal field. Longitude
  wrapping and coincident polar vertices use one key. Only boundary references
  are retained across tiles; only currently visible tiles contribute. Hidden
  cached parents leave the shared field on the next visibility update and
  rejoin when shown again, without rebuilding attributes. Changes in ancestor
  visibility are included. Interiors keep their complete local triangle
  neighbourhood. Skirts inherit ground shading normals without contributing
  vertical-wall slopes. Physical vertex normals and imagery normal maps are
  unchanged. Local east/north/up uses the reference ellipsoid normal, with a
  finite polar fallback. Unmatched mixed-LOD edges and physical geometry/source
  discontinuities are not repaired by this shading-only change.
- Tint composes after imagery and before lighting. Hillshade replaces displayed
  outgoing radiance before eclipse shadows and aerial perspective, retains
  shadow-map receiving, and preserves opacity/fade/output hooks. Debug materials
  take precedence and restore styled materials when disabled. No lights,
  simulation state, physical position/normal/index buffers, sampling,
  clearance, refinement settings, or source requests are changed by a style.
- The normal variant adds no shader instructions or height attributes. Elevation
  attributes and the hillshade normal field are prepared only for visible tiles,
  with a 4 ms preparation budget per frame (one tile is atomic). Tiles keep their
  ordinary imagery shader until ready. Hidden cached tiles wait until visible. Disabling effects
  releases the normal references and invalidates GPU uploads before removing
  their attributes, so repeated toggling does not strand WebGL buffers. Materials and imagery
  are retained. Uniform-only edits do not recompile shaders.
- Settings belong to each body mesh for the current scene, survive panel closure,
  and reset with a new scene. The fallback globe remains natural imagery when
  streamed tiles are not displayed.

- Range picks barycentrically interpolate the rendered height attribute, matching
  the elevation colors rather than a separate CPU sample or triangle-chord
  altitude. Ray hits on inactive cached tiles are excluded; uncolored fallback
  globes and overlays cannot set an elevation-color range. Ordinary surface
  picks retain their existing physical height and body-fixed hit fields. Tint
  height stays on the internal ray result; a dedicated appearance query uses
  shared `_castSurfaces()`. Canonical `SurfacePoint` carries no style data.

## Upstream evaluation and scope

Inspected the installed `3d-tiles-renderer@0.4.27` plugin implementations and
exports. They provide imagery overlay, fade, and debug material wrappers, but no
hillshade or elevation-tint utility. This change chains those existing material
callbacks and program keys rather than registering another terrain streamer or
replacing materials. Contours and the upstream `TopoLinesPlugin` evaluation
remain in #183. Multidirectional hillshade, automatic local range fitting,
slope/aspect, and further relief effects are deferred.

## Cube-sphere integration (#260)

The follow-up to #187 now supports the known `cubeSphere` planetary product,
including MoonFall/Shackleton and the cube imagery experiments. Its stricter
capability checks, imagery block lifecycle, rendered-height picks, real hardware
GPU captures, timing results and remaining limits are documented in the
[cube-sphere validation record](../cube-surface-appearance/README.md).

#182 remains open for its other surface visualization and polar-quality work.
The original quantized-mesh evidence below remains specific to those sources.
Physical-phone acceptance remains separate from desktop Chromium mobile layout
checks; neither establishes low-end mobile GPU activation costs.

## Reproduce

```sh
npm run build
npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5182 --strictPort
# In another terminal:
SURFACE_VIEWER_URL=http://127.0.0.1:5182 node scripts/test-surface-appearance.mjs
SURFACE_VIEWER_URL=http://127.0.0.1:5182 node scripts/test-surface-shading-seams.mjs
SURFACE_VIEWER_URL=http://127.0.0.1:5182 node scripts/test-surface-shading-lod.mjs
SURFACE_VIEWER_URL=http://127.0.0.1:5182 node scripts/test-surface-shading-curvature.mjs
SURFACE_VIEWER_URL=http://127.0.0.1:5182 node scripts/test-surface-shading-live.mjs
SURFACE_VIEWER_URL=http://127.0.0.1:5182 node scripts/test-surface-style-activation.mjs
```

The browser harness supplies small fixed catalogs using the existing live Mars
and Moon terrain and NASA Trek imagery sources. Mars includes atmosphere and
two composited imagery layers; both scenes use tile fades. It checks actual UI
interactions (including each independent range pick and cancellation), decoded source coverage, imagery download/overlay readiness,
desktop and `390 × 844` layouts, debug round trips, untouched physical buffers,
shader errors, and a canvas pixel comparison after returning to normal. Fixed
body attitudes make the camera locations deterministic; assertions verify
body-fixed Mars `18° N, 133° W` and Moon `85° S, 0° E` before capture.

Screenshots include normal, hillshade, combined tint/hillshade, phone layout, and
restored states. Review [Mars](mars-combined.png) and the [lunar polar view](moon-combined.png).
The remote sources selected coarse decoded geometry in these scenes, even where
imagery resolved finer detail. These captures demonstrate loaded-mesh styling;
they do not establish fine DEM/crater detail, arbitrary source transitions, or
physical mobile-device acceptance.

**Remaining visual limitation:** the lunar polar source contains long fan
triangles and tile-edge discontinuities. They are visible in normal imagery and
become more prominent in hillshade/tint. The polar capture therefore does not
pass the issue's artifact-free visual acceptance. The MVP preserves those
physical tiles and makes their limitations explicit; further polar visual
polish remains before treating all of #182's acceptance as complete.

## Hillshade boundary regression

[seams/metrics.json](seams/metrics.json) records a GPU-rendered planar fixture
with deliberately inconsistent legacy vertex normals: the old path has a
118/255 brightness jump at the shared edge; the shared geometric normal field
has **0/255** difference. This is a controlled shading regression, not a source
terrain dataset. A separate live-streamed close/tilted Mars view uses azimuth
170 degrees, elevation 25 degrees and contrast 3, matching the supplied review
settings. Compare [legacy](seams/mars-close-legacy.png) and
[current](seams/mars-close-current.png). Those captures hold geometry and
camera fixed and change only the shading normal path.

## Zoomed-out curvature regression

The smooth-surface regression exposes a coarse-LOD error: a flat triangle's
approximation of planetary curvature was being treated as topographic slope. Hillshade
now subtracts the same triangle projected onto the reference ellipsoid before
averaging, then adds analytic local up in the fragment shader. A smooth reference
surface therefore has zero relief correction at every tested LOD. Geographic
boundary sharing and skirt exclusion operate on these weighted corrections;
physical positions, normals, indices and source heights remain unchanged.

The [GPU regression](curvature/metrics.json) compares commit `842cbea` with the
corrected shader on identical constant-height spheres. Brightness spread drops
from **98/255 to 0/255** on the coarse mesh and **8/255 to 0/255** on the finer
mesh, using the reported azimuth 100°, elevation 40°, contrast 3. Unit coverage
also checks oblate ellipsoids and that actual relief still affects shared normals.
The live harness compares both algorithms on identical streamed Mars tiles at
3,800, 5,600 and 9,000 km; [before](curvature/mars-5600-before.png) /
[current](curvature/mars-5600-current.png) captures use the southern Hellas region.
These are controlled review viewpoints, not an exact replay of the user's camera.
Source discontinuities and unmatched mixed-LOD geometry remain outside this
shading correction.

## Cached LOD regression after re-review

The focused unit regression first failed on `4fd2a45`: a hidden cached coarse
parent biased the fine tile's shared boundary corrections. Shared nodes now own
only visible tile contributions. Cached local corrections remain available for
reactivation; eviction and hillshade toggling remove ownership cleanly.

`test-surface-shading-lod.mjs` compares direct coarse/fine loading with three
zoom-in/out cycles that hide tiles without disposing them, including ancestor
visibility and zero-budget updates of already-prepared tiles. All six rendered
comparisons have **zero changed pixels**; see [LOD metrics](lod/metrics.json),
[direct fine](lod/directFine.png) and [fine after refinement](lod/fine-0.png).
The existing shared-edge GPU fixture still reports a 0/255 boundary jump.
These controlled fixtures establish cache independence, not human acceptance of
the supplied live Mars view or mixed-LOD source geometry.

## Activation performance after review

[activation/metrics.json](activation/metrics.json) and the [close Mars capture](activation/mars-close.png)
use real streamed Mars terrain at a 3,430 km camera range, with `errorTarget: 0.25`.
The cache held 142 meshes / 62,228 vertices; only the 137 visible meshes / 60,105
vertices were prepared. Five inactive cached meshes received no attributes.
The script measures the setter, the next event-loop task, completion of visible
attributes, and per-frame/per-tile preparation. Every run removes attributes first.

| CPU execution | Style | Setter ms | Next task ms | Visible attributes ready ms | Preparation total ms | Largest batch / tile ms | Batches |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Native | Elevation | 0.2 | 164.1 | 165.5 | 2.3 | 2.3 / 0.2 | 1 |
| Native | Hillshade | 0.0 | 19.4 | 337.6 | 42.1 | 4.4 / 2.6 | 11 |
| 4x CPU throttle | Elevation | 0.2 | 27.0 | 33.9 | 5.3 | 4.2 / 0.8 | 2 |
| 4x CPU throttle | Hillshade | 0.3 | 26.5 | 690.4 | 134.6 | 7.1 / 6.1 | 29 |

The throttled runs follow native runs; shader cache state across browser launches
is not controlled. Native activation delayed the next task by 19–164 ms in this
run, including shader compilation/rendering; the frame budget limits CPU
attribute preparation, not driver compilation. Progressive hillshade took about
0.7 s under throttling. This is CPU emulation on the same desktop, not a physical
phone or a hard latency guarantee. An unusually large individual tile can exceed
the budget because tile preparation is atomic; broader source/device profiling
and shader warmup remain useful follow-ups.

## Validation

- 40 focused appearance/pick/measurement tests pass, covering shared boundary
  normals, cached LOD transitions, eviction, skirts, field-matching range picks, independent bounds,
  rejected misses/crossings/uncolored surfaces, and unchanged measurement input.
- Type checks, changed-file lint, and viewer production build pass.
- After merging current main, package + viewer suite: 2,100 tests passed, 7 skipped
  (before the additional bound/curvature/hidden-LOD regressions; the current
  focused run has 40 passing tests).
- Earlier branch validation encountered the existing timing-sensitive `gf-reporting.test.ts` / `keeps the first pass
  inside the first half while it runs` can finish in roughly 77 ms before its
  100 ms progress throttle produces an intermediate event. CSPICE is unchanged.
- [metrics.json](metrics.json) records median/p95 frame intervals, source requests,
  estimated height/normal/mask attribute bytes, renderer geometry/texture counts, decoded
  source diagnostics, physical-buffer preservation, and normal restoration.
  Chromium uses **SwiftShader software rendering**. Phone results change the
  viewport on the same machine; these timings are wall-frame comparisons, not
  isolated GPU timings or hardware/mobile FPS guarantees.

| Scene | Normal ms | Hillshade ms | Combined ms | Restored ms | Tint attribute KiB | Terrain requests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Mars, desktop, atmosphere + 2 imagery layers | 173.7 | 142.7 | 137.6 | 144.6 | 35.7 | 46 throughout |
| Moon, desktop | 13.3 | 11.1 | 21.2 | 23.3 | 97.1 | 122 throughout |
| Mars, phone viewport | — | — | 44.3 | 42.5 | 32.9 | 46 throughout |
| Moon, phone viewport | — | — | 11.0 | 14.4 | 91.8 | 122 throughout |
The final run used `SURFACE_FRAME_SAMPLES=30` (default 90).
Values are median frame intervals, with noise from software rendering and
compilation. Both normal-restoration canvas comparisons changed **0 pixels**;
physical buffers remained identical, no shader errors occurred, and tint
height/normal/mask attribute bytes returned to zero. The extra desktop normal
attributes occupy 107.1 KiB for Mars and 291.3 KiB for Moon; ground masks
occupy another 35.7/97.1 KiB of CPU attribute storage. Boundary references are
retained only while hillshade is enabled. Texture counts were unchanged by styling.
The `scrolling` entries in metrics and the `*-mobile-legend.png` captures show
that the legend is reachable through internal panel scrolling while
the dock remains at scrollTop zero. The center samples were answered by decoded
source level 3 for Mars and level 4 for Moon; the legend describes rendered
geometry, including coarser/finer surrounding tiles, rather than those samples.
