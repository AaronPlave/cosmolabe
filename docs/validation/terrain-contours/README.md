# Terrain contours: issue #183 progress

Client-side contours for quantized-mesh terrain and validated planetary cube
products, including MoonFall. This is **not final acceptance of #183**: broader
scientific-source, rendering-combination and GPU performance checks remain.
Generic 3D Tiles do not acquire elevation styling.

## Controls and behavior

In a body's **Surface appearance**, enable **Contours**, then **Elevation labels**.
Labels work with **Automatic** and with the fixed 10–5000 m interval choices.
Switching interval modes preserves the label toggle. Automatic mode also exposes
**Density**. A readout shows the actual minor and index intervals.

Every fifth contour is an emphasized index contour, following the
[USGS index-contour convention](https://www.usgs.gov/ngp-standards-and-specifications/us-topo-cartographic-specifications-elevation).
Each connected visible index path gets one label where a readable span fits.
Labels align to that span, remain upright, and show signed metres relative to
the same body reference and height convention as the contour shader. Separate
loops at the same elevation remain separate. There is no global label-count
limit or per-tile candidate reservoir. Short, crowded, sharply bending or
occluded spans may have no readable label.

Text is a straight word aligned along a locally smooth part of the contour;
individual glyphs do not bend around sharp curves. Labels avoid one another,
body names, callouts and viewer panels. Depth testing hides them behind terrain.
Color follows the line color, and opacity increases relative to faint lines for
legibility. Contours and labels are off by default.

## Elevation and rendering contracts

Heights are computed once from source vertices with float64 body-fixed
transforms and the body's true reference shape, then stored in kilometres.
Labels intersect the exact linearly interpolated `surfaceHeightKm` field used
by the shader, including negative heights. Recomputing radial height at a coarse
triangle's chord midpoint would disagree with that field and is avoided.
Metre labels do not imply metre-level source accuracy.

Contour lines compose as unlit annotations after physical lighting, hillshade,
eclipses and aerial perspective, before output conversion and existing
fog/fade/debug hooks. Underlying terrain lighting, authored geometry/normals,
CPU elevation sampling, measurement behavior, imagery and terrain LOD remain
unchanged. No DEM query, new terrain product or contour geometry draw is added.
Label sprites add their own draw calls.

Skirts remain for physical crack hiding, but cannot supply contours or label
paths. The ground-mask derivative rejects their shared top edges as well as
their walls. Terrain debug modes override contours and hide labels. Disabling
contours removes their shader additions and releases unused style attributes;
disabling labels clears their candidate/topology caches and hides the reusable
sprite pool. Disposing terrain releases label textures and materials.

The shader adapts derivative antialiasing from the pinned
[3d-tiles-renderer v0.4.27 example](https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/v0.4.27/example/three/src/plugins/topolines/wrapTopoLineMaterial.js),
with Apache-2.0 attribution in `NOTICE`. These example files are not exported
from the installed npm package. Its planar/grid machinery and ellipsoid/world
height reconstruction are not used.

## Automatic spacing and dense lines

Automatic spacing uses one shared minor interval across all tiles and labels.
It samples visible source triangles, estimates their projected elevation
gradients, and chooses a screen-area-weighted 1–2–5 step, with hysteresis and
Density adjustment. The automatic interval ranges from 1 m to 1 km. Weighting
by screen area prevents tiny, distant horizon triangles from dominating the
surface view. The actual interval updates at most every 250 ms.

There is no line-count budget: fragments evaluate the height field directly.
Earlier missing coverage had two causes: an absolute footprint cutoff, and
unbounded spacing that selected 10 km intervals over a basin wholly between
those levels. Neither rule remains.

At a fixed 10 m interval or at grazing angles, many minor lines can fall within
one pixel. The former shared anti-alias fade then extinguished all lines on a
slope. Minor and index bands now filter independently, retaining nested
coarser index levels (multiples of five) where finer bands cannot resolve.
Filtering finishes before the AA support overlaps an entire period, avoiding
a solid contour-color wash. This deliberately preserves a readable index
skeleton rather than claiming every 10 m line is resolvable from any distance.
Loaded coarse triangles can still produce angular contours; styling does not
invent higher-resolution topography. A static sphere has no terrain contours.

## Path extraction and placement

Only original visible source geometry is scanned. Cube imagery's clipped
children reuse the source fields and never duplicate contour paths. Hidden
cached ancestors and retired tiles leave the topology.

Triangle intersection, path construction and label layout each use cooperative
frame work with a 2 ms target; construction/layout yield every 128 operations. These limit work
per frame, not the number of admitted contours. Extraction excludes offscreen
and back-facing triangles and unresolved index levels. View changes refresh
that filtered extraction, reusing segment objects on unchanged triangles so
existing label anchors retain priority. Nearby tiles and paths close to the
look direction are processed first. Labels beyond six times the nearest visible
surface distance are omitted; this is a relative distance gate, so globe views
still support labels. The distance scale has 25% hysteresis. No elevation
requests are made.

Shared triangle endpoints and tile borders are stitched before labeling.
Mixed-LOD dangling ends may join within three pixels, with equal elevations,
compatible tangents and a 3D-distance check. Distinct loops and overlapping
front/back hemispheres cannot merge simply because they share screen pixels.
Visible path spans are projected, checked for enough room and low curvature,
then placed with rotated text bounds and collision checks. Projection updates
every frame; placement starts a new cooperative pass 250 ms after the last one
finishes. Layout snapshots the camera and source matrices in the body frame,
so body motion/floating-origin updates cannot mix coordinate frames during a
pass. New labels publish path by path instead of waiting for the entire view.
Existing anchors survive temporary occlusion and small camera moves; refinement
can replace them when source triangles retire. Extraction refresh has a wider
motion threshold to avoid constant work cancellation while navigating.

Labels use opaque warm-white semibold text with a black halo, independently of
contour color and opacity (including zero line opacity). Text scales smoothly
from 14 px to a minimum of about 12 px with relative distance. Rotated collision
bounds follow the actual scaled size.

Glyph fragment depth follows the source triangle plane with a 0.15-pixel
camera-directed bias in the logarithmic viewer, reduced from two pixels to avoid pulling text through
nearby relief. A source-mesh line-of-sight check additionally hides anchors
behind foreground terrain, including fading tiles that do not write depth.
These checks use a 2 ms frame target, cache successful checks for up to one
second at a stationary view, and invalidate on camera/anchor movement or source
changes. Unchecked anchors stay hidden while waiting their turn. Labels render
after transparent terrain and retain per-fragment depth testing.
Ordinary perspective depth additionally allows one depth-buffer quantum when a
very small near plane reduces precision. Perspective/orthographic cameras and
normal/log buffers are covered by the GPU regression. Geometry, material depth flags, and terrain render passes are unchanged.

## Reproducible validation

```sh
npm ci
npm run typecheck
npm run lint
npx vitest run packages/three/src/__tests__
npm --prefix apps/viewer run build
node scripts/test-terrain-contours.mjs
node scripts/test-cube-terrain-contours.mjs
node scripts/test-terrain-contour-labels.mjs
# With this checkout's viewer running on 5174:
SURFACE_VIEWER_URL=http://localhost:5174 node scripts/test-terrain-contour-controls.mjs
# Real local MoonFall cube terrain + WAC/NAC imagery and physical GPU:
CONTOUR_LABELS=1 SURFACE_VIEWER_URL=http://localhost:5174 node scripts/test-terrain-contours-live.mjs
```

372 renderer tests across 37 files pass, with typecheck, lint and viewer
production build. Tests cover transformed/mixed-LOD border stitching, separate
same-height loops, cooperative construction without path caps, automatic
spacing/density/hysteresis, source visibility, skirts, cleanup, and rotated
placement. A fixture labels **each of 19 visible index paths**, confirming the
former 16-label limit is gone.

The [offline contour metrics](metrics.json) use real Mars TIN geometry with
**procedural imagery**, plus analytic lunar polar/global fixtures. They are not
mission imagery/scientific lunar observations. Contours remain visible without
incident light, including the synthetic negative-height global basin. All
fixtures restore byte-identical original pixels when disabled, retain zero
unused height attributes, and add zero skirt contour pixels. See
[Mars parent](mars-parent.png), [Mars children](mars-children.png), and
[synthetic pole](synthetic-pole.png).

The [cube metrics](cube-metrics.json) use an explicitly synthetic cube polar
crater loaded through `GLTFLoader` and production imagery clipping. Four imagery
blocks retain the style fields, split/unsplit pixels are identical, debug
precedence and disabled restoration hold, and no unused height fields remain.
See [cube contours](cube-contours.png) and [tilted cube](cube-tilted.png).

The [label/depth regression](label-depth-metrics.json) preserves all 120/114 lit
glyph pixels with perspective/orthographic cameras and normal/log depth.
A flat-billboard negative control retains only 58. Both ordinary foreground
occlusion and a non-depth-writing foreground plane leave zero text pixels;
without the anchor LOS check, the latter exposes all 120/114 pixels. Changing
the contours to almost transparent black retains the same readable label pixels.
Disabled contours leave zero text pixels. Its dense 10 m scalar-field fixture
retains 57,344 contour pixels over 112 rows, below half the plane's area; the
old shared-band fade retains zero. This verifies coverage without a full-plane
tint. The scalar field is a synthetic rendering test, not scientific terrain.

The [Svelte controls regression](label-ui-metrics.json) checks automatic labels,
fixed interval persistence, per-body isolation, density restoration, labels
retained when returning to Automatic, and control collapse when disabled.

## Real MoonFall captures and limits

The [live metrics](label-live-metrics.json) use Apple M4 Max ANGLE Metal, actual
local LOLA cube terrain and WAC/NAC imagery, 1440×1000 desktop and 390×844 mobile
viewport. All eight initial assets load; there are no HTTP/page/shader errors.
The run checks automatic close/regional/polar/globe views, a fixed 10 m oblique
view at approximately 22 km terrain altitude, camera motion, settled placement,
and independent contour/label toggles.

- [Automatic surface labels](moonfall-labels-close.png)
- [Dense 10 m contours and index labels](moonfall-labels-dense.png)
- [Automatic regional labels](moonfall-labels-far.png)
- [Automatic globe labels](moonfall-labels-globe.png)
- [Mobile automatic labels and controls](moonfall-labels-mobile.png)

Per-view warm CPU label-update timings are recorded over 120 frames, including
cooperative layout and the additional LOS checks. Label count follows readable,
visible paths, not a global cap. Hidden labels retain their anchors for reuse.

| View | Minor interval | Labels | Median CPU | P95 CPU | Maximum CPU |
| --- | --- | --- | --- | --- | --- |
| Surface, automatic | 100 m | 12 | 0.3 ms | 2.2 ms | 2.7 ms |
| Oblique, fixed | 10 m | 97 | 2.1 ms | 3.6 ms | 6.2 ms |
| Regional, automatic | 500 m | 26 | 0.2 ms | 2.2 ms | 2.6 ms |
| Polar, automatic | 1000 m | 23 | 0.1 ms | 2.2 ms | 2.7 ms |
| Globe, automatic | 1000 m | 20 | 0.1 ms | 2.1 ms | 3.3 ms |

An initial synchronous LOS pass peaked around 44 ms in the dense view; the
cooperative cached version above avoids that burst. Individual mesh raycasts
can still exceed the 2 ms target. These timings measure label CPU updates, not
GPU sprite drawing, terrain/style activation, whole-frame performance or
physical-phone behavior. Labels may still replace anchors when terrain LOD or
automatic intervals change; this is not a guarantee of flicker-free navigation.

Remaining before closing #183: real textured Mars captures; broader mixed-LOD,
moving-camera/fade/flicker review; full imagery/Sun/eclipse/atmosphere
combinations; whole-frame GPU and first-enable measurements. The full repository
suite is left to CI because the local initial run encountered missing LFS SPICE
kernels and sandbox subprocess restrictions. Issue #183 remains open.
