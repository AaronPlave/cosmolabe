# Geographic vector drawing

Imported geographic layers draw automatically in the Three.js viewer. Points
and multipoints use 7 CSS pixel circular marks; linework and every polygon ring
use 2 CSS pixel strokes. Polygon fills are translucent and preserve holes.
Selection uses a gold mark/stroke and hover uses white. Emphasis does not grow
polygon fill silhouettes.

Open `apps/viewer/test-catalogs/geographic-vectors.json` for a self-contained
reference-globe example with Mars and lunar viewpoints. Its features are clearly
labelled synthetic validation fixtures. Loading them with a terrain-enabled
catalog uses that body's displayed terrain automatically.

## Open the validation scenes yourself

The original `geographic-vectors.json` is a small reference-globe example. The
measured-terrain and dense-layer tests also have regular catalogs you can open
interactively. With the local viewer on port 5188:

- [Dense Jezero: 1,600 targets and a detailed polygon](http://127.0.0.1:5188/?catalog=test-catalogs/geographic-vectors-jezero-dense)
- [Jezero: points, traverse and polygon with a hole](http://127.0.0.1:5188/?catalog=test-catalogs/geographic-vectors-jezero-terrain)
- [Shackleton: points, traverse and polygon with a hole](http://127.0.0.1:5188/?catalog=test-catalogs/geographic-vectors-shackleton-terrain)

Each starts at the **detail** viewpoint. In **Display** (gear icon), use
**Viewpoint** to switch between detail, close, regional and orbit. Click cyan
features to select them in gold. **Lighting → Shadow** makes relief easier to
see. The vector features are synthetic; the underlying terrain is measured.

Jezero requires the local `test-catalogs/data/mars-terrain-fused/` pyramid;
Shackleton requires `test-catalogs/data/moon-terrain-cube/`. This checkout has
the Jezero product and a local link to the measured lunar product. These large
generated terrain products are ignored by Git and are not bundled with the
catalog JSON. If your viewer uses a different port, change `5188` in the links.

## Coordinates and surfaces

Two-dimensional geometry clamps to the **currently displayed surface triangles**.
The vector pass reuses their position/index buffers, transform, camera and depth
buffer. It evaluates the feature in body-fixed geographic coordinates per
fragment. It does not build a second sampled terrain mesh, request terrain,
change terrain LOD, or use the imagery texture resolution as vector detail.
New, removed, replaced and hidden tiles are reconciled each frame. Local surface
tiles participate in their camera-relative pass with the same camera and depth.
Skirt/cap geometry groups are excluded from the vector drawing.

Ordinary edges are linear in unwrapped longitude/geodetic latitude, taking the
short longitude interval at each edge. Split exactly 180 degree ambiguous edges.
Concave and wide regions are triangulated in that plane with independent holes;
triangles are tested in geographic space, not drawn as chords through the planet.
A closed ring winding once around a pole uses an azimuthal equidistant polar
plane for both import topology and rendering. Its edges are straight in that
plane. Polar holes share the exterior's plane. Source winding does not choose an
antipodal complement. These are documented drawing conventions, not geodesic
survey/analysis operations. Original input coordinates remain available.

Only globe datums (spherical or oblate geodetic) are supported. A datum mismatch
is diagnosed rather than silently reprojected. Meshes and DSKs are explicitly
unsupported: a future surface renderer can supply its own projection and 3D
attachment path without adding a fictitious lat/lon height sampler to
`PhysicalSurface`. Body attitude comes from `bodyToWorldQuaternion`; local
transforms cancel scene translation in double precision before GPU upload.
Distances/placement offsets are kilometres throughout. No display radius enters
a physical coordinate conversion.

A reference globe can be drawn when terrain is unavailable. The viewer's small
surface-status readout identifies each body's rendering mode and reports
limitations. This is body-wide context: terrain coverage at individual features
is **not assessed**, even while terrain is streaming elsewhere on the body.
The readout avoids host UI rectangles and hides when no free space remains. `renderer.geographicVectors.status` and `.diagnostics` provide the
same information to embed hosts. A feature's appearance is **not a terrain
measurement**: source uncertainty and displayed mesh deviation may be unknown.
Surface tools still return the existing `SurfacePoint` with its own hit source,
height datum, terrain sample and accuracy information.

## Placement and selection API

```ts
renderer.geographicVectors.setVisible('science', false);
renderer.geographicVectors.setPlacement('science', { mode: 'clamp' });
renderer.geographicVectors.setPlacement('science', {
  mode: 'terrain-relative', offsetKm: 0.002, // 2 m along the geodetic normal
});
renderer.geographicVectors.setSelected({
  layerId: 'science', featureId: 'string:target', bodyName: 'Mars',
});
renderer.geographicVectors.setSelected(null);
```

Default imported Z is an absolute datum height, **never** a terrain offset.
All imported Z values, including zero and small positive heights, are diagnosed
and omitted by default. `body-fixed-height` is reserved but unavailable: an
absolute-height drawing surface needs a bounded height error before it can be
enabled. The former 192 by 96 shell could lie hundreds of metres below its
declared height on Mars and disappear beneath detailed terrain. No shell or
pick target is allocated for this mode.

An explicit `clamp` or `terrain-relative` placement opts those features into
draping while retaining their original Z coordinates. Varying/mixed heights
and arbitrary Cartesian 3D require an unattached 3D path; attachment to irregular
shapes is also unsupported. Terrain-relative offsets reuse active terrain
triangle vertices displaced along the datum normal; their detail follows
terrain, not imagery. Negative offsets may be occluded by the surface as expected.

`pickScene(x, y, 'select')` returns
`{ kind: 'geographic-feature', layerId, featureId, bodyName }`. Events and entity
labels retain priority; a feature wins over its parent body. Geographic hits
are tested only on the nearest visible surface (or a terrain-relative surface
in front of it). The same spatial index, projection and local pixel differential
serve CPU picking and fragment rendering. Points win over strokes, then fills;
source order breaks equal ties. `geographic:click` and `geographic:hover` expose
stable references. Selecting another feature replaces the highlight; selecting
an event, measurement, body/label or empty space clears it. Probe and active
tool gestures preserve it. Body mesh hover remains available when no higher
priority glyph, label or geographic feature is hit. Hover is revalidated during
rotation/camera motion. Probe,
pivot, measurement endpoints and active pointer tools retain their existing
paths and do not acquire geographic features.

## Bounds and lifetime

Features share spatial indices/textures and surface draw calls within each
body/datum/placement batch. There is no Three.js object per feature and no
per-frame worker job. At most 16 batches, 100,000 primitives per batch, 1,000,000
spatial references per batch, 256 candidates per cell **per draw**, 2,048 visible surface
proxies and 250,000 terrain-offset vertices are retained. Cell padding covers
screen-width strokes around cell boundaries; extremely distant/subpixel globe
and grazing views can clip a mark at the index padding boundary. Dense cells use overflow pages rather than rejecting valid features. Each draw
still scans at most 256 candidates. Sparse batches keep a single pass; overflow
batches draw fills, then strokes, then points, with earlier source pages last.
Translucent overlaps across pages composite with normal alpha blending (rather
than the single winner within a page). CPU picking searches all admitted
candidates and retains point/stroke/fill and nearest/source tie precedence.
Rendering admits at most **16 pages per body/datum/placement group**, independently
of the 100,000-primitive and 1,000,000-reference storage caps. A group requiring
more pages is omitted as a whole, with a `vector-render-budget` diagnostic,
no GPU textures/proxies and no pick targets. Source features stay intact;
filter or simplify an overloaded source to bring it within the drawing budget.
The nine-page localized Jezero fixture is retained in full.

All main, overlay and camera-relative passes share a **2,048 surface-draw budget
per frame**. Before allocating proxies, each group is checked against its
visible mesh count times page count. If it would exceed the remaining budget,
its remaining passes and picking are suppressed for that frame, its proxies
are released and `vector-draw-budget` explains the limit. Earlier passes may
already have drawn part of that group; it cannot acquire invisible pick targets.
The next frame retries with a fresh budget, so reduced visible detail recovers
automatically. `metrics.drawPages` and `metrics.drawCalls` expose both costs.
One surface proxy is reused across pages, without allocating an object per
feature. The limits diagnose overload rather than silently dropping
individual polygon rings.

Hidden layers have no textures/proxies and trigger no geographic surface pick.
Source changes rebuild immutable batches; highlights only update uniforms.
Proxy eviction/teardown disposes vector-owned materials/textures and offset
geometry, preserving the source terrain's buffers and material/shader ownership.
The pass composes over existing imagery, elevation color, hillshade, atmospheric
and shadow rendering without replacing their shaders.

Static globe displacement maps are repeated in the vector vertex shader so the
two passes agree visually. The existing CPU surface hit still describes that
globe's reference shape; a GPU displacement image is not promoted to measured
terrain. Float32 geographic projection at planetary radii also limits sub-metre
display accuracy. Use the shared physical surface queries for scientific data.

## Reproducible validation

Run `npm run build`, then start the viewer and run:

```sh
CL_CHROMIUM=/usr/bin/chromium node scripts/test-geographic-vectors.mjs
CL_CHROMIUM=/usr/bin/chromium node scripts/test-geographic-vectors-viewer.mjs
```

The test saves images and timings under
[`validation/geographic-vectors`](validation/geographic-vectors). It uses the
Jezero science/traverse/multipart fixture on a deterministic, densely tessellated
**analytic relief test surface**, a lunar seam/polar cap with a hole, selection,
mobile pixel ratio, terrain replacement, rotation/floating origin, backside
occlusion and a 4,900-point synthetic layer. Timings include synchronous GPU
finish and readback on Chromium SwiftShader, not a hardware-GPU performance
claim. These fixtures do not validate registration against measured Jezero or
Shackleton terrain products. Unit tests cover import topology, concavity, wide
regions, seam/polar picking, multipart geometry, budgets, placement and lifetime.

The second browser check exercises the real viewer/catalog loader, an explicit
fixed frame on an oblate Mars globe, automatic vector drawing, stable scene-hit
identity, selection and the reference-globe readout. It also captures the full
viewer chrome at desktop and mobile sizes and asserts that the status is clear
of host UI. Artifacts are `viewer-reference.png`, `viewer-chrome-desktop.png`,
`viewer-chrome-mobile.png` and `viewer.json`.

The review follow-up also exercises absolute Z=0 and Z=2 m against a detailed
10 m tessellated Mars patch: these values and explicit absolute placement must
produce diagnostics, no GPU resources and no hits until an explicit draping
choice is made. The patch is analytic, not measured elevation.

## Physical GPU and measured terrain follow-up (2026-10-17)

The local run uses Chrome with `ANGLE Metal Renderer: Apple M4 Max` (40 GPU
cores). It rejects SwiftShader/software renderer identification. Artifacts are
in [the M4 Max validation directory](validation/geographic-vectors/m4-max).
The earlier cloud/software results above remain separate evidence.

The localized fixture contains a **160-vertex polygon and 1,600 points within
about 8 km of Jezero**, rather than spreading points around a planet. Unit tests
pick every point and verify every primitive is packed into a page of at most
256 candidates. Hardware checks render the full fixture, verify selection in
both the first and last point pages, and exercise the existing seams, polar
holes, LOD replacement, floating origin, occlusion and hidden-resource checks.
The localized batch uses nine bounded fallback pages. With multiscale close-view
indices enabled it uses 2,637,824 texture bytes.

The [runtime profile](validation/geographic-vectors/m4-max/metrics.json) records
120 animation frames after 20 warm-up frames for each baseline/vector view.
It excludes `finish` and readback. At 640 x 480 DPR 1 and 390 x 844 DPR 2,
frame intervals stayed around 16.7 ms (60 Hz), with CPU submission around
0.1 ms median. These are whole-frame cadence and CPU submission measurements,
not isolated GPU execution time. Both views use the desktop M4 Max;
**physical mobile GPU profiling was waived for this PR by the owner on
2026-10-17**; no mobile-hardware performance claim is made.

The [measured-terrain run](validation/geographic-vectors/m4-max/measured-terrain.json)
uses the local MOLA/HRSC plus Jezero HiRISE 1 m residual quantized-mesh pyramid
and the LOLA 118 m plus south-pole LOLA 10 m residual cube pyramid. Source
metadata text and SHA-256 are retained. The terrain is measured; the overlaid
registration points, traverse and polygon with a hole are synthetic fixtures.
The Jezero product declares MOLA areoid heights placed as ellipsoid heights;
this check does not establish absolute height or survey/geology accuracy.

Each body zooms from 1,000 to 100 to 15 to 3 km above the reference datum and
back to 100 km. The script records tile/load changes, waits for quiescence,
asserts the center ray hits terrain and selects the same feature, and captures
loading, settled relief and LOD-color states. Representative relief captures:
[Jezero](validation/geographic-vectors/m4-max/mars-3-settled.png) and
[Shackleton](validation/geographic-vectors/m4-max/moon-15-settled.png).
The full viewer loader, body status, selection and desktop/mobile chrome checks
also pass on Metal. Reproduce after starting this checkout's viewer:

```sh
export CL_CHROMIUM='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export CL_VIEWER_URL='http://127.0.0.1:5188/'
export CL_OUTPUT='docs/validation/geographic-vectors/m4-max'
CL_GPU=hardware node scripts/test-geographic-vectors.mjs
CL_GPU=hardware node scripts/test-geographic-vectors-viewer.mjs
CL_MOON_TERRAIN=/path/to/measured/moon-terrain-cube node scripts/test-geographic-measured-terrain.mjs
```

The measured script also requires the Jezero pyramid at
`apps/viewer/test-catalogs/data/mars-terrain-fused/`. It fails on missing terrain;
there is no analytic replacement for this check.

## Real viewer dense-layer performance regression

The original 640 x 480 analytic-relief timing did **not** establish performance
for the actual dense catalog at desktop drawing resolutions. A user reproduced
severe lag in `geographic-vectors-jezero-dense`. The normal viewer at 1920 x
1080 CSS pixels, DPR 2 (3840 x 2160 drawing buffer), with the pointer over the
terrain reproduces a 466.6 ms median frame interval on the M4 Max when the dense
vectors are enabled. CPU rendering stays around 2.2 ms and picking around 0.2 ms;
the bottleneck is the repeated fragment scans of the entire localized cluster.

Localized non-polar batches now also pack six padded spatial grids, from 64 x
64 down to 5 x 5. Fragment derivatives select a scale whose one-cell padding
covers the CSS-pixel stroke/marker footprint. Close views test nearby primitives;
zoomed-out views use coarser local bins and paging. The existing global index is
retained for wider footprints and seam/polar cases. No source features or
polygon rings are simplified or removed. Every bin still scans at most 256
candidates; the combined global/local references share the existing 1,000,000
reference limit, and the 16-page/2,048-draw limits remain in force.

The [before](validation/geographic-vectors/m4-max/viewer-performance-before.json)
and [after](validation/geographic-vectors/m4-max/viewer-performance-after.json)
profiles use the actual catalog, measured terrain, normal antialiasing/effects,
the same 4K drawing resolution, and a resting pointer. Over 90 measured frames:

| Scene | Median before | Median after | After p95 |
| --- | ---: | ---: | ---: |
| Sparse Jezero, 15 features | 16.7 ms | 16.7 ms | 33.4 ms |
| Dense Jezero, 1,601 features | 466.6 ms | 16.7 ms | 33.3 ms |

The dense scene retains every feature and passes a visible-cyan-pixel check
(276,609 pixels), drag interaction, and close/regional/orbit viewpoint checks;
those viewpoints have 16.7 ms median and at most 33.4 ms p95 intervals. Pixel
readback occurs **after** the timing samples. These are full viewer frame
intervals on a desktop M4 Max, not isolated GPU execution or mobile benchmarks.
The [actual 4K viewer capture](validation/geographic-vectors/m4-max/viewer-dense-4k.png)
shows the retained markers. GPU regression also covers a detailed polygon with
an independent hole and selection. Unit tests check every target in every
spatial scale, padding across bin boundaries, reference/candidate caps, and the
seam-aware fallback.

```sh
CL_OUTPUT=/tmp/geographic-viewer-performance node scripts/test-geographic-viewer-performance.mjs
```

This separate manual hardware check asserts a 50 ms p95 frame budget for the
reported dense catalog and its close/regional/orbit viewpoints. It uses the
running viewer at port 5188 and the existing local measured Mars pyramid.

## Deferred absolute-height capability

PR #262 is **part of [#197](https://github.com/AaronPlave/cosmolabe/issues/197)**;
it does not complete that issue's body-fixed-height scope. Clamp and explicit
terrain-relative placement are the delivered modes. Absolute datum-height
rendering remains disabled, including imported Z=0 and Z=2 m. The follow-up is
tracked in [the absolute-height implementation checklist](design/geographic-absolute-height.md).
Keep #197 open until the deferred absolute-height capability is delivered.
Physical mobile profiling is not a merge gate for this PR per the owner; CI
and the bounded desktop rendering checks remain required.

Latest local verification after the approved main merge: full `npm run typecheck`
passes (Svelte: zero errors/warnings), 123 focused rendering/interaction,
surface-plan and catalog-availability tests pass, and ESLint plus `lint:purity`
pass. The full suite run completed with 2,252 passed, seven skipped and one
failure in the unchanged CSPICE `gf-reporting.test.ts` test “keeps the first pass
inside the first half while it runs” (no intermediate progress callback was
observed). Two additional polar estimator regressions subsequently pass in the
focused run. The same CSPICE test failed in isolation before this follow-up.
The local full suite is therefore not reported as green; current CI is tracked
separately on PR #262.

The final review adds a pathological **100,000 coincident-point** CPU stress
case: its 391-page group is diagnosed and omitted before GPU allocation. A
second test reaches exactly 2,048 draws with a 16-page/128-mesh group, then
verifies overlay/local passes cannot exceed the shared frame cap, suppressed
picking is empty, and the next frame recovers. Metal validation also exercises
7,000 coincident targets: overload produces no partial marks or GPU resources.

The new interactive catalogs are included in the explicit SPICE-free test
inventory. The main-branch surface-plan integration now preserves its existing
non-polar estimator boundary explicitly: shared import/rendering supports polar
charts, while planar area/clipping reports `unsupported-shape` and a clear
Pole-enclosing diagnostic during resolution and estimation. Rendering support
does not silently expand scientific area-estimation capabilities.
