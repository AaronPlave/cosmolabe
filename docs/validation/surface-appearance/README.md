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
feedback; Escape/Cancel ends it. Measurement picks and appearance picks are
mutually exclusive, and scene/panel replacement clears the pending pick.

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
  Hillshade computes area-weighted smooth normals from loaded surface triangles
  and shares boundary contributions by geographic position (0.00001 degree
  keys). Small height differences do not split the normal field. Longitude
  wrapping and coincident polar vertices use one key. Only boundary references
  are retained across tiles; interiors keep their complete local triangle
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
  attributes and the hillshade normal field are lazy. Disabling effects
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
  picks retain their existing physical height and body-fixed hit fields.

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
SURFACE_VIEWER_URL=http://127.0.0.1:5182 node scripts/test-surface-shading-seams.mjs
SURFACE_VIEWER_URL=http://127.0.0.1:5182 node scripts/test-surface-shading-live.mjs
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

## Validation

- 27 focused appearance/pick/measurement tests pass, covering shared boundary
  normals and eviction, skirts, field-matching range picks, independent bounds,
  rejected misses/crossings/uncolored surfaces, and unchanged measurement input.
- Type checks, changed-file lint, and viewer production build pass.
- Final package + viewer suite: 1,706 tests passed, 7 skipped, with one failure
  in the existing CSPICE timing-sensitive progress test described below.
- The existing timing-sensitive `gf-reporting.test.ts` / `keeps the first pass
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
| Mars, desktop, atmosphere + 2 imagery layers | 173.0 | 145.1 | 135.3 | 138.1 | 35.7 | 46 throughout |
| Moon, desktop | 13.0 | 10.8 | 11.7 | 13.1 | 97.1 | 122 throughout |
| Mars, phone viewport | — | — | 41.7 | 42.4 | 32.9 | 46 throughout |
| Moon, phone viewport | — | — | 8.3 | 8.3 | 91.8 | 122 throughout |
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
