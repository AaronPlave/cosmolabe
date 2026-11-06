# Physical Sun illumination for streamed terrain (#204)

In **natural** lighting mode, sunlight on streamed planetary terrain follows the
simulated Sun direction and epoch. This page states what is physical, what is
not, and how a catalog tells the renderer which imagery may be relit.

Code: `packages/three/src/SurfaceIllumination.ts`. Tests:
`SurfaceIllumination`, `TerrainIllumination`, `UniverseRenderer.illumination`.

## Which scene lights which surface

| Surface | Scene | Lit by |
| --- | --- | --- |
| Fallback globe (`baseMap`) and body spheres | main | Sun `DirectionalLight` + ambient |
| Streamed terrain / imagery-only ellipsoid / cube terrain (`TerrainManager`) | main | the same Sun light + ambient |
| `surfaceTiles` mission-site photogrammetry | camera-relative `tileScene` | full ambient only, in every mode: `baked`, shown as-is |

`tileScene`'s ambient-only lighting is intentional and is **not** the streamed
terrain path. Streamed terrain is never drawn in `tileScene`, so it cannot fall
back to ambient-only brightness at the sphere/streamed switch.

## Sun direction

One scene-wide Sun light serves every body. It used to be aimed at the scene
origin, which is the Sun direction *at the camera's origin body* only. It is now
aimed at the streamed-surface body nearest the camera (within 20 radii), so its
direction is the Sun direction at the surface being viewed. With no such body
the origin aim is unchanged. A flagged shadow-caster still takes precedence.

`UniverseRenderer.solarGeometryAt(body, latDeg, lonDeg)` returns the Sun's
elevation, azimuth and `cos(incidence)` at a planetocentric point for the
current epoch, for diagnostics and screenshot captions. It reads the body's
current orientation each call, so rotation, a moving Sun and time seeks need no
special handling.

## Imagery illumination provenance

`imagery[].illumination` (and `terrain.illumination` for a tileset's own
textures) declares what the pixels mean:

| Value | Meaning | Behaviour |
| --- | --- | --- |
| `reflectance` | approximately photometrically normalized albedo | relit by the Sun: `albedo × sun × cos(incidence)` |
| `baked` | shading/shadows already in the pixels | shown as-is; **never relit**, so not double-lit |
| `unknown` (default) | nothing declared | **legacy**: relit as before, *not* asserted physically relightable |

A mixed stack takes the most conservative value (baked > unknown >
reflectance), over declared layers whether or not currently visible. An
untextured quantized mesh is neutral albedo (`reflectance`). Only
`reflectance` in `natural` mode is a physical claim.

Baked imagery still composes with imagery overlays, eclipse shadow and aerial
perspective; only the Sun, ambient and environment lighting are bypassed.

## Lighting modes

`natural` is physical. `shadow` (brighter ambient, softer Sun) and `flood` (full
ambient, no Sun) are **nonphysical visualization aids**. All three are one
definition (`LIGHTING_MODES`) applied to every surface in the main scene.

`directTerm` (`intensity × cos(incidence)`) is the unshadowed direct solar
contribution. Terrain-cast shadows and horizon occlusion (#205) should attenuate
this term; it is kept separate from ambient and baked terms.

## Normals

`TerrainManager.blendSphereNormals(…, 0.6)` rewrites only the `normal`
attribute of quantized-mesh surfaces. Positions, picking, elevation sampling and
slope data are untouched. The blend flattens real slope in the direct term;
cube terrain keeps its physical normals instead.

## Not photometrically accurate

- No terrain self-shadowing or horizon occlusion (#205).
- Lambertian response only: no regolith BRDF, opposition effect or Hapke
  photometry.
- No indirect bounce or Earthshine; `natural` ambient is a flat 3%.
- Sun is a point direction; no penumbra on terrain.
- `unknown` imagery is relit but may already contain shading.
