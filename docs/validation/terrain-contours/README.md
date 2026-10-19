# Terrain contours: issue #183 progress

This is an implementation and offline evaluation, **not final visual acceptance
of #183**. The per-body **Surface appearance → Contours** toggle supports
quantized-mesh terrain and the known planetary cube-sphere path used by current
MoonFall catalogs. Color, opacity and relative density are available. Contours
are off by default. Cube contours reuse the validated cube surface appearance
capability on main (#263), preserving its elevation tint and hillshade controls.
Generic 3D Tiles models do not acquire terrain-height styling.

## Upstream evaluation and decision

Evaluated the exact version matching the pinned `3d-tiles-renderer@0.4.27`:

- [TopoLinesPlugin.js](https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/v0.4.27/example/three/src/plugins/topolines/TopoLinesPlugin.js)
- [wrapTopoLineMaterial.js](https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/v0.4.27/example/three/src/plugins/topolines/wrapTopoLineMaterial.js)

These are example files, absent from the npm package exports. The wrapper was
also compiled and rendered in the local WebGL harness, in ellipsoid mode with
cartographic opacity zero. This is a source/runtime evaluation, not a review
of the live Mars demo against streamed terrain.

**Decision: adapt narrowly.** `TerrainContours.ts` retains derivative-based
line antialiasing, two decade-spaced contour scales, a fading scale transition,
and emphasis on every tenth line. Apache-2.0 attribution is in `NOTICE`.
We omit the planar/cartographic components and the resolution-sampling mesh.
The existing `SurfaceAppearance` lifecycle owns attachment, visible-tile
preparation, cache keys, and eviction instead of installing another tile plugin.

Direct use would calculate normal height against the renderer's ellipsoid in
world space, conflicting with the existing radial/reference-offset conventions
and camera-relative globe transforms. We reuse the exact vertex heights used
by elevation tint instead: float64 body-fixed transforms and the body's true
reference shape, converted from tile metres to kilometres **once**. This also
retains negative heights. The terrain encoding offset is already in rendered
positions and must not be subtracted again.

The shader derives the screen footprint from tile-local positions transformed
by the body-fixed matrix's linear part, then scaled by 0.001. Translation is
excluded; rotation and any local scale are accounted for.
No absolute globe position is sent to the contour fragment shader. Spacing and
the distance fade use kilometres, not the example's metre constants. Density
is a relative visual control, not a scientifically fixed interval.

We use ordered `smoothstep` edges, suppress unresolved bands and flat plateaus,
and mask skirt/bottom geometry. We inject after imagery/tint composition and
before physical lighting, eclipses and aerial perspective. There is no extra
draw call, geometric displacement, depth offset, DEM request, or LOD change.
Color/opacity/density changes update uniforms without recompiling. Disabling
contours removes their shader code and releases height/ground attributes unless
another enabled surface style still needs them.

## Reproducible offline validation

```sh
npm ci
npm run typecheck
npm run lint
npx vitest run packages/three/src/__tests__/SurfaceAppearance.test.ts
# Optional: download the two upstream source files above into work/issue-183/
# to include the upstream wrapper smoke comparison (not shipped/vendored).
CHROMIUM_PATH=/usr/bin/chromium node scripts/test-terrain-contours.mjs
CHROMIUM_PATH=/usr/bin/chromium node scripts/test-cube-terrain-contours.mjs
# In another terminal: npm --prefix apps/viewer run dev -- --port 5182
CHROMIUM_PATH=/usr/bin/chromium node scripts/test-terrain-contour-controls.mjs
```

Omit `CHROMIUM_PATH` to use Playwright's installed browser. Captures default to
`work/issue-183/captures`; override with `CONTOUR_OUTPUT`.

The harness uses the checked-in real Mars Hub Jezero parent TIN and its four
child TINs through the pinned upstream `QuantizedMeshLoader`. The color texture
is **procedural test imagery**, not registered Mars imagery. See the
[parent capture](mars-parent.png) and [child capture](mars-children.png).
The [polar capture](synthetic-pole.png) is an **analytic crater fixture** at the
lunar south pole, not LOLA or MoonFall data. It tests coordinate/shader behavior.
Zoom captures exercise camera-aware spacing at three distances. Parent→children
activation exercises cached visibility and later-loaded geometry; it does not
certify streaming LOD fades or moving-camera flicker.

[Recorded metrics](metrics.json): Chromium used SwiftShader software WebGL.
No shader errors; contours changed 2,392 Mars pixels and 11,467 synthetic polar
pixels at the default view. On/off restored byte-identical original pixels on
both fixtures, and no contour height attribute remained after disabling.
The Mars fixture compiles and renders the real eclipse and aerial-perspective
material hooks with a directional Sun light. Atmospheric optical strength is
zero: this tests shader compatibility, not atmospheric transport accuracy.
No hardware frame-time or performance claim is made from these results.

### Cube-sphere integration

The second harness loads an analytic lunar polar crater through `GLTFLoader`,
including the production Y-up correction and primitive `surfaceTriangles`
metadata. It uses `TerrainManager`'s validated cube-imagery integration and bitmap
loader with routed local PNGs. This validates the current cube rendering path
without fetching a terrain product. It does **not** replace MoonFall/LOLA source
validation. See [contours](cube-contours.png), [disabled](cube-off.png), and the
[tilted view](cube-tilted.png); all three use synthetic geometry and imagery.

The source must be prepared before imagery clips its triangles. Newly clipped
vertices interpolate the source heights and skirt mask; recomputing height at
those vertices would turn the coarse mesh's chord sag into false relief. The existing derived-mesh lifecycle
attaches styling after imagery/lighting hooks and forgets evicted blocks. On/off rebuilds the attribute layout; color, opacity
and density changes still only update shared uniforms. CPU grids and physical
geometry are unchanged.

[Cube metrics](cube-metrics.json): four imagery blocks at level 9 all carried
the height field; the split and unsplit images were byte-identical. Contours
changed 9,211 pixels. Disabling restored the original pixels, the unlit imagery
debug view was unchanged by contours, repeated zoom/toggle cycles released all
height attributes, and there were no shader errors. This used SwiftShader,
with eclipse hooks enabled, and is not a hardware benchmark. The harness does
not invoke the terrain streamer's geometry LOD/fade selection.

The [viewer control check](ui-metrics.json) uses a local fixed-point Moon/Mars
catalog with no terrain bytes and blocks outside requests. It passes: preserved cube tint/hillshade
controls, contour toggling, density editing, per-body isolation,
selection persistence, and collapsing the styling controls when disabled.
[UI capture](controls.png) shows the cube controls in the actual Svelte viewer.
Set `SURFACE_VIEWER_URL` if its dev server uses a different address.

Unit tests cover callback composition with imagery/shadows/atmosphere, shared
height ownership with tint, deferred hidden tiles, per-body isolation, negative
Mars heights, matching adjacent tile heights, lunar pole coordinates, origin
shifts, and uniform-only style edits.

All 627 renderer and surface-picking tests (53 files) pass with runtime network
access, including the contour height, material and cube integration contracts.
`npm run typecheck`, `npm run lint`, and `npm run lint:purity` pass. The whole
repository test command also ran before integration with main: 2,044 passed, 135 failed, 85 skipped, with
38 failed files and 8 reported errors. That run includes missing SPICE kernels
(checked-in LFS pointers) and sandbox subprocess/loopback failures unrelated to
this feature; it is **not** a green full-suite result. Re-running the 27
data-hosting tests with runtime network access passes all 27.

## Remaining before closing #183

- Capture real textured MoonFall/cube terrain and Mars terrain, including a
  lunar polar view. Cube support is implemented; actual product review remains.
- Review mixed-LOD boundaries, skirts, moving-camera refinement/fades, horizon
  behavior, and density/flicker at useful surface zooms on real sources.
- Exercise the full imagery layering, terrain debug, physical Sun/eclipse and
  aerial-perspective combinations in the running viewer.
- Measure real-GPU frame cost and first-enable latency. Shader absence and
  resource cleanup when disabled are tested; hardware performance is pending.

These checks need the actual surface products and representative rendering
hardware. No additional backend or terrain product is needed for this feature.
