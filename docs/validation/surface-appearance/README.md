# Surface appearance MVP — issue #182

Select a terrain body and open its info panel. **Surface appearance** provides
Normal imagery, Hillshade, and Elevation tint. Elevation tint can also use
hillshade; the imagery blend and tint opacity keep the existing imagery useful.
Artificial light azimuth is clockwise from geographic north, elevation is above
the local tangent plane, and contrast affects displayed shading only. Three
palettes share a fixed, editable kilometre range and a compact clipping legend.

## Rendering contract

- Operates on loaded quantized-mesh terrain. Imagery-only surfaces, generic
  3D Tiles/ion models, unknown/areoid references, and unsupported normal-height
  triaxial references explicitly have no relief styles.
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
  Hillshade uses existing smoothed mesh normals, ignoring imagery normal maps.
  Local east/north/up uses the reference ellipsoid normal, with a finite polar
  fallback. Existing tile-edge normal/source-LOD limitations remain visible.
- Tint composes after imagery and before lighting. Hillshade replaces displayed
  outgoing radiance before eclipse shadows and aerial perspective, retains
  shadow-map receiving, and preserves opacity/fade/output hooks. Debug materials
  take precedence and restore styled materials when disabled. No lights,
  simulation state, physical position/normal/index buffers, picking, sampling,
  clearance, refinement settings, or source requests are changed by a style.
- The normal variant adds no shader instructions or height attributes. Elevation
  attributes are lazy; disabling tint invalidates GPU uploads before removing
  them so repeated toggling does not strand WebGL buffers. Materials and imagery
  are retained. Uniform-only edits do not recompile shaders.
- Settings belong to each body mesh for the current scene, survive panel closure,
  and reset with a new scene. The fallback globe remains natural imagery when
  streamed tiles are not displayed.

## Upstream evaluation and scope

Inspected the installed `3d-tiles-renderer@0.4.27` plugin implementations and
exports. They provide imagery overlay, fade, and debug material wrappers, but no
hillshade or elevation-tint utility. This change chains those existing material
callbacks and program keys rather than registering another terrain streamer or
replacing materials. Contours and the upstream `TopoLinesPlugin` evaluation
remain in #183. Multidirectional hillshade, automatic local range fitting,
slope/aspect, and further relief effects are deferred.

## Reproduce

```sh
npm run build
npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5182 --strictPort
# In another terminal:
SURFACE_VIEWER_URL=http://127.0.0.1:5182 node scripts/test-surface-appearance.mjs
```

The browser harness supplies small fixed catalogs using the existing live Mars
and Moon terrain and NASA Trek imagery sources. Mars includes atmosphere and
two composited imagery layers; both scenes use tile fades. It checks actual UI
interactions, decoded source coverage, imagery download/overlay readiness,
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

## Validation

- 21 focused surface/terrain tests pass, including lazy buffers, physical datum
  and offset handling, poles, program-key composition, per-body isolation,
  streamed tile lifecycle, and world-origin independence.
- Final package + viewer suite: **1,699 tests pass, 7 skip**. Type checks,
  changed-file lint, and viewer production build pass.
- The existing timing-sensitive
  `gf-reporting.test.ts` / `keeps the first pass inside the first half while it runs`
  failed in two earlier runs, in the package suite and alone. Its search finished in roughly 77–79 ms,
  before the reporter's 100 ms throttle yields an intermediate event. The
  final combined suite passed it. The CSPICE implementation/test is unchanged.
- [metrics.json](metrics.json) records median/p95 frame intervals, source requests,
  estimated height-attribute bytes, renderer geometry/texture counts, decoded
  source diagnostics, physical-buffer preservation, and normal restoration.
  Chromium uses **SwiftShader software rendering**. Phone results change the
  viewport on the same machine; these timings are wall-frame comparisons, not
  isolated GPU timings or hardware/mobile FPS guarantees.

| Scene | Normal ms | Hillshade ms | Combined ms | Restored ms | Tint attribute KiB | Terrain requests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Mars, desktop, atmosphere + 2 imagery layers | 142.2 | 136.8 | 137.6 | 139.8 | 35.7 | 46 throughout |
| Moon, desktop | 12.8 | 11.5 | 12.3 | 14.0 | 97.1 | 122 throughout |
| Mars, phone viewport | — | — | 40.7 | 44.2 | 32.9 | 46 throughout |
| Moon, phone viewport | — | — | 8.3 | 8.3 | 91.8 | 122 throughout |

Values are median frame intervals, with noise from software rendering and
compilation. Both normal-restoration canvas comparisons changed **0 pixels**;
physical buffers remained identical, no shader errors occurred, and tint
attribute bytes returned to zero. Texture counts were unchanged by styling.
The `scrolling` entries in metrics and the `*-mobile-legend.png` captures show
that the legend is reachable through internal panel scrolling (166 px) while
the dock remains at scrollTop zero. The center samples were answered by decoded
source level 3 for Mars and level 4 for Moon; the legend describes rendered
geometry, including coarser/finer surrounding tiles, rather than those samples.
