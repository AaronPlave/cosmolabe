# Physical Sun illumination for streamed terrain (#204)

In **natural** lighting mode, sunlight on streamed planetary terrain follows the
simulated Sun direction and epoch. This page states what is physical, what is
not, how a catalog tells the renderer which imagery may be relit, and the
evidence.

**Scope.** The work so far is a Sun-direction correctness fix and the
illumination-provenance contract that later work builds on. It is **not** a
general improvement to lunar or planetary imagery, and it does not add terrain
self-shadowing (#205). How real Moon imagery looks under directional light
(for example crater interiors already baked into a mosaic) is a product
question that stays open under #204 until catalogs declare provenance.

Code: `packages/three/src/SurfaceIllumination.ts`. Tests: `SurfaceIllumination`,
`TerrainIllumination`, `UniverseRenderer.illumination` (vitest) and
`scripts/test-surface-illumination-webgl.mjs` (real WebGL, `npm run test:illumination:webgl`).

## How each surface path is lit

Traced from `UniverseRenderer`, `BodyMesh` and `TerrainManager`.

| Surface path | Scene | Lit by | Provenance |
| --- | --- | --- | --- |
| Static globe (`baseMap`, normal/displacement/bump maps) | main | Sun `DirectionalLight` + ambient (Phong/Standard material) | n/a: a body texture, relit as before |
| Imagery-only ellipsoid (`Globe.imagery`) | main | same light; tiles swapped to `MeshStandardMaterial` | `imagery[].illumination` |
| Quantized-mesh / 3D Tiles terrain | main | same light | `imagery[].illumination`, else `terrain.illumination` |
| Multi-imagery overlays | main | composited into `diffuseColor`, then the same light | stack combined conservatively |
| Cube-sphere terrain and cube imagery | main | same light, physical normals | cube layers' `illumination` |
| DSK / mesh surfaces | main | same light (`MeshStandardMaterial`) | n/a |
| `surfaceTiles` mission-site photogrammetry | camera-relative `tileScene` | full ambient only, every mode | **baked**, always |

`tileScene`'s ambient-only lighting is intentional and is **not** the streamed
terrain path. `TerrainManager` tiles are never drawn in `tileScene`, so they
cannot fall back to ambient-only brightness at the sphere/streamed switch:
both are lit by the same main-scene light. Mixed terrain LOD changes geometry
and imagery level only; every tile shares one program and one light.

## Sun direction

One scene-wide Sun light serves every body. It used to be aimed at the scene
origin, which is the Sun direction *at the camera's origin body* only. It is now
aimed at the streamed-surface body nearest the camera (within 20 radii), so its
direction is the Sun direction at the surface being viewed. With no such body
the origin aim is unchanged. A flagged shadow-caster (`castShadow: true`) still
takes precedence and targets the caster, as before, so scenes with a caster (for
example Ingenuity at Jezero) look the same as on the base branch and do not
exercise this correction. Bodies far from the viewed surface keep the shared light (a single light cannot
be correct for two distant bodies at once).

`UniverseRenderer.solarGeometryAt(body, latDeg, lonDeg)` returns the Sun's
elevation, azimuth and `cos(incidence)` at a planetocentric point for the
current epoch. It reads the body-fixed (Z north) to world orientation from
`BodyMesh.bodyToWorldQuaternion()` each call, so rotation, a moving Sun and time
seeks need no special handling. (`mesh.quaternion` is not that frame: it also
carries the globe geometry's own axis rotation.) Tested on a real Globe
`BodyMesh`, with and without a rotation applied.

`UniverseRenderer.directSolarTermAt(body, latDeg, lonDeg, normal?)` returns the
**unshadowed direct term** a receiver gets in the current mode
(`sunIntensity × cos(incidence)`), for a local radial or a slope given in
east/north/up. It depends on the receiver and Sun only, never on the camera or
on what the camera can see: a Sun disk hidden behind a ridge (#242) says nothing
about a different, sunlit patch, and a receiver facing the Sun can still be
behind a ridge (#205). #205 should attenuate this term, which is kept separate
from ambient and baked terms, rather than darkening the composited image.

## Demonstration: the Sun-direction correction on streamed imagery

`scripts/demo-surface-sun-direction-gpu.mjs` renders one scene twice, with the
same camera, epoch and imagery and no shadow caster: scene origin Earth, camera
viewing Mars, streamed NASA Trek Viking MDIM 2.1 imagery tiles (fetched once, cached).
The fixture uses `geometry.imagery` without `geometry.terrain`: its streamed
surface is an imagery-only ellipsoid, **not displaced terrain with relief**.
"Before" is the old origin-aimed Sun; "after" is the receiver-aimed Sun. The
ephemeris is the Keplerian fallback (no SPICE kernels) and the imagery has no
declared provenance (`unknown`, legacy relit), so this shows the **aiming**, not
physical-accuracy of Mars imagery.

![Origin-aimed vs receiver-aimed Sun](validation/surface-illumination/sun-direction-before-after.png)

| | Sun direction (scene frame) | Light target | Angle to true Mars→Sun |
| --- | --- | --- | --- |
| Before (origin-aimed) | (−0.7230, −0.6909, −0.0000) | (0, 0, 0): the Earth origin | 59.37° |
| After (receiver-aimed) | (0.2258, −0.9738, −0.0260) | Mars (−161.3, 130.7, 6.2) | 0.00° |

Epoch 2026-11-06T12:00:00Z; Earth→Sun and Mars→Sun directions differ by 59.37°.
The camera is 70° from the true Sun, so about two thirds of the disk is lit
(Sun elevation 20.0°, azimuth 81.9° at the sub-camera point, from
`solarGeometryAt`): the "after" terminator is where that geometry puts it, and
the "before" image lights nearly the whole disk.

Checks the script asserts (raw values in
[`sun-direction-result.json`](validation/surface-illumination/sun-direction-result.json)):

- The surface is the streamed imagery-only ellipsoid path (`surfaceTransitionState`
  `streamed`, tile meshes in the terrain group), not the fallback sphere.
  This does not validate lighting on displaced 3D terrain.
- The "after" light is the true Mars→Sun direction (0.00°); the "before" light is
  the origin→Sun direction.
- **Albedo-free ratio.** The same imagery at the same pixel is lit by two Sun
  directions, so albedo cancels in `L_after / L_before`. Lambert predicts
  `cos(true Sun) / cos(origin Sun)`. Over 2254 pixels well above the terminator
  (log-ratio spread 0.46) measured vs predicted: r = 0.997, slope 1.035, median
  relative error 4.5% (ambient and a small specular term).
- **Base branch.** The "before" is forced in the new build, so it was checked
  against a real build of `main` (de0a04cd): the light direction, position and
  target and the rendered PNG are byte-identical, and `main`'s two captures are
  identical to each other
  ([`sun-direction-base-check.json`](validation/surface-illumination/sun-direction-base-check.json)).

Software WebGL, not a performance claim; the script needs network once for the
tiles and is not run in CI.

## Imagery illumination provenance

`imagery[].illumination` (and `terrain.illumination` for a tileset's own
textures) declares what the pixels mean:

| Value | Meaning | Behaviour |
| --- | --- | --- |
| `reflectance` | approximately photometrically normalized albedo | relit by the Sun: `albedo × sun × cos(incidence)` |
| `baked` | shading/shadows already in the pixels | shown as-is; **never relit**, so not double-lit |
| `unknown` (default) | nothing declared | **legacy**: relit as before, *not* asserted physically relightable |

A surface makes a claim only when **every contributing layer agrees**: all
`baked` is as-is, all `reflectance` is relit as a physical claim, and any mixture
(or an undeclared layer) is `unknown`, the legacy relit path. Contributing means
visible with opacity above zero, so hiding a layer or setting its opacity to 0
removes it from the decision. This is deliberate: one uniform per surface cannot
light two sources differently, and treating a small bounded baked overlay as
"the whole surface is baked" would switch the Sun off everywhere outside its
footprint. The cost of the mixed case is that the overlay's own pixels are
double-lit; correct per-pixel mixed lighting (weighting by each layer's
coverage and opacity in the compositor) is a follow-up. An untextured quantized
mesh is neutral albedo (`reflectance`). Only `reflectance` in `natural` mode is
a physical claim. The viewer's Imagery control lists each layer's provenance.

Provenance is a shared shader uniform (`uSurfaceAsIs`), so changing it is a
uniform write: no recompile, no material churn, one program for all tiles.
Baked imagery still composes with imagery overlays, eclipse shadow and aerial
perspective; only the Sun, ambient and environment lighting are bypassed.

`illumination` is accepted by the catalog schema on `imagery[]`, `terrain.imagery[]`
and `terrain`. No catalog in this repository declares it yet. Which products are
reflectance and which are baked is a #123/#147 decision; until a catalog says,
it stays `unknown` and renders exactly as before.

## Lighting modes

`natural` is physical. `shadow` (brighter ambient, softer Sun) and `flood` (full
ambient, no Sun) are **nonphysical visualization aids**. All three are one
definition (`LIGHTING_MODES`) applied to every surface in the main scene.
Baked photogrammetry in `tileScene` is mode-independent by design.

## Normals

`TerrainManager.blendSphereNormals(…, 0.6)` rewrites only the `normal`
attribute of quantized-mesh surfaces. Positions, picking, elevation sampling and
slope data are untouched (tested). The blend pulls every tile's normal toward
the same absolute sphere normal, so a seam between independently decoded tiles
shrinks to under half its source discontinuity (tested) at the cost of
flattening real slope in the direct term. Cube terrain keeps its physical
normals instead. Separate shading normals were not introduced; that is a
follow-up if the flattening matters for a product.

## Evidence

Real-WebGL run (`scripts/test-surface-illumination-webgl.mjs`, software
SwiftShader, so repeatable acceptance evidence and not a GPU benchmark),
[`docs/validation/surface-illumination/result.json`](validation/surface-illumination/result.json):

- Neutral-albedo sloped planes at 4 slopes × 3 Sun elevations match
  `cos(incidence)` within 0.004 (normalized to normal incidence); the back-facing
  and past-terminator cases are dark; facing > flat > away.
- Illumination-baked imagery reads back exactly its own albedo on every slope,
  Sun elevation and mode; relit imagery on the same back-facing slope is ~0.
- `flood` is identical across slopes and elevations.
- Relit, baked and flood tiles compile **one** program.
- Frame cost: the hook measured 1.02 ms against 1.25 ms for a plain Standard
  material per software-GL frame, i.e. no measurable cost above noise. This says
  nothing about desktop GPU or mobile-class hardware, which was not available.

![Ridge fixture under each lighting path](validation/surface-illumination/ridge-lighting-sheet.png)

Rows are the lighting paths, columns Sun elevations 8°, 25°, 60° at azimuth 90°.
The fixture is synthetic, so no mission epoch applies. The first row is the old
ambient-only look.

## Not photometrically accurate

- No terrain self-shadowing or horizon occlusion (#205).
- Lambertian response only: no regolith BRDF, opposition effect or Hapke
  photometry.
- No indirect bounce or Earthshine; `natural` ambient is a flat 3%.
- Sun is a point direction; no penumbra on terrain.
- `unknown` imagery is relit but may already contain shading.
- Real-body Shackleton, equatorial Moon and Mars captures were not made here (no
  catalog data or GPU in the authoring environment); the contract is verified on
  synthetic fixtures and on the production shader path.
