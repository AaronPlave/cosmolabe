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
surface-status readout identifies that fallback and reports rendering
limitations. `renderer.geographicVectors.status` and `.diagnostics` provide the
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
renderer.geographicVectors.setPlacement('science', {
  mode: 'body-fixed-height', heightKm: 1.2, // above the layer's declared datum
});
renderer.geographicVectors.setSelected({
  layerId: 'science', featureId: 'string:target', bodyName: 'Mars',
});
renderer.geographicVectors.setSelected(null);
```

Default imported Z is an absolute datum height, **never** a terrain offset.
Features whose vertices all have the same Z use a fixed-height reference shell.
Varying or mixed 2D/3D heights require an unattached 3D path and are diagnosed and
omitted by default. An explicit layer placement opts those features into the
chosen projection while retaining their original data. Arbitrary Cartesian 3D
and attachment to irregular shapes are not supported. Fixed-height shells use a
192 by 96 globe tessellation; their chord error is a display limitation, not
height accuracy. Terrain-relative offsets reuse each active terrain triangle's
vertices displaced along the datum normal; their detail follows terrain, not
imagery. Negative offsets may be occluded by the surface as expected.

`pickScene(x, y, 'select')` returns
`{ kind: 'geographic-feature', layerId, featureId, bodyName }`. Events and entity
labels retain priority; a feature wins over its parent body. Geographic hits
are tested only on the nearest visible surface (or an explicit-height surface
in front of it). The same spatial index, projection and local pixel differential
serve CPU picking and fragment rendering. Points win over strokes, then fills;
source order breaks equal ties. `geographic:click` and `geographic:hover` expose
stable references. Hover is revalidated during rotation/camera motion. Probe,
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
identity, selection and the reference-globe accuracy readout. Its screenshot and
machine-readable result are `viewer-reference.png` and `viewer.json`.
