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
spatial references per batch, 256 candidates per cell, 2,048 visible surface
proxies and 250,000 terrain-offset vertices are retained. Cell padding covers
screen-width strokes around cell boundaries; extremely distant/subpixel globe
and grazing views can clip a mark at the index padding boundary. Dense
coincident data that exhaust a cell is diagnosed feature by feature; a polygon
and all its rings commit atomically. Split/simplify overloaded datasets rather
than increasing an unbounded fragment loop.

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

Measured Jezero/Shackleton zoom/LOD registration and physical desktop/mobile GPU
profiling remain pre-merge validation requirements. This cloud environment has
no `/dev/dri` or NVIDIA device and Chromium uses SwiftShader. On 2026-10-17,
requests to the USGS Jezero HiRISE DTM and a candidate lunar south-polar mirror
returned HTTP 403; the configured lunar S3 source is outside the environment's
network policy. Neither the synthetic fixture nor software timings substitute
for those checks; the PR remains a draft.
