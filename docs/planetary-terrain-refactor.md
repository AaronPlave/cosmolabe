# Planetary Surface / Terrain Refactor — implementation record

## Status

This document is the durable implementation checklist for the planetary-terrain
refactor. It preserves the scope of the source plan supplied on 2026-09-08;
execution issues and pull requests must link here rather than narrowing or
silently replacing its requirements.

The source plan remains the normative detailed specification. Its phased
sequence is deliberately retained: foundation and instrumentation first, Mars
fusion second, renderer cleanup after validation, Moon work afterward, then
legacy cleanup.

## Non-negotiable architecture

```text
body shape / datum -> canonical terrain -> regional residual detail -> rendered terrain

georeferenced imagery (separate, sharing geographic/body-fixed coordinates)
```

Terrain rendering consumes terrain data. It does not interpret source datums,
hide source-registration errors, fuse DEMs, or scan its rendered meshes to
answer physical-surface queries.

## Complete requirement index

### Audit and preservation

- Audit `TerrainManager`, `BodyMesh`, `UniverseRenderer`, camera modes and
  controller, Surface Explorer, all Mars scripts, MoonFall/Mars/Jezero/Ingenuity
  catalogs and flight builders before changing behavior.
- Record body and terrain radii, `referenceRadiusOffsetKm`, terrain elevation
  sampling, quantized-mesh local coordinates, Z-up/Y-up and body-fixed/world
  transforms, visibility thresholds, imagery overlays, LOD/multiple cameras.
- Preserve orbital and SPICE behavior, static/low-detail visual fallback, and
  current UX until an equivalent replacement is verified.
- Audit the newest compatible `3d-tiles-renderer` before retaining private API
  patches; every surviving patch needs a reason, upstream reference, and public
  API rationale.

### Domain model and sampler

- Add explicit terrain datum, source metadata, and sample semantics: reference
  shape/radius or ellipsoid, vertical datum, radial/geodetic convention,
  body-fixed position, elevation, normal, source and uncertainty.
- Do not use `referenceRadiusOffsetKm` as datum conversion or
  `BodyMesh.displayRadius` as physical terrain reference. Any legacy support is
  a documented source-specific compatibility adapter.
- Provide a renderer-independent CPU `TerrainSampler` by lat/lon and
  body-fixed position. It finds data/tile, bilinearly interpolates a decoded
  height field, derives position and optionally normal, and reports provenance.
- It must not traverse scenes, scan vertices, or choose nearest rendered
  vertices. A bounded decoded-tile cache is acceptable initially.
- Make this sampler the shared primitive for collision/clamp, above-terrain
  readouts, picking refinement, waypoints, vehicle placement, LOS and masking.

### Offline data fusion and quantized mesh

- Create reusable offline `inspect`, `fuse`, `validate`, and `tile` DEM tools;
  runtime remains browser TypeScript, while geospatial build tooling may use
  GDAL/Python/Node.
- Fuse detail as a residual over a canonical base, not as a source replacement.
  Fit and disclose a planar registration bias before residual computation;
  generate canonical/fused DEM, residual, coverage mask, metadata, and a
  validation report with offset/slopes and overlap statistics.
- Produce one continuous terrain pyramid from that field. Shared same-LOD edges
  must have equivalent samples/heights; normal LOD mechanisms, skirts or
  geomorphing handle differing parent/child topology.
- Tile-center coordinate rewriting remains useful but becomes generic writer
  behavior, not a Mars seam fix.
- Validate edge and dyadic parent/child errors, registration, residual blend,
  and mission control points with max/RMS/p95 metrics.

### Mars

- Retain USGS MOLA/HRSC as canonical global terrain; use USGS Mars 2020 Jezero
  HiRISE DTM as regional detail, leaving future MADNet evaluation source-agnostic.
- Fuse MOLA/HRSC plus HiRISE with a smooth residual taper to zero at the coverage
  boundary; never leave a hard source boundary.
- Keep old Mars generation available until the fused terrain passes numerical
  and visual comparison at Wright Brothers Field/Jezero control points.
- Only then retire source-overwrite, outside-HiRISE deletion, parent-edge sync,
  and special seam repair where fusion makes them obsolete; first classify any
  remaining issue as same-LOD, LOD, or renderer behavior.

### Moon

- Define explicit global/mid-latitude LOLA/SLDEM-derived canonical source.
- Use a LOLA-derived south-pole control surface and optionally image-derived
  residual detail; preserve the existing authoritative LOLA waypoint path.
- Build/validate a continuous Shackleton surface and verify several polar
  control points before switching MoonFall.
- The existing `wip/planetary-terrain-moon` branch is prototype evidence, not a
  merge base: retain useful data/build findings but resolve its first-pass
  calibration, mesh-based sampler, fallback behavior, and seam machinery.

### Navigation, cameras, rendering, and imagery

- Keep imagery independent of terrain correctness; imagery and terrain have
  common georeferencing but neither is moved to hide the other's error.
- Surface navigation moves in local ENU/body-fixed space and converts back to
  geodetic coordinates; remove polar `1 / cos(latitude)` and arbitrary
  `safeCos` behavior.
- Surface up is geodetic ellipsoid normal (or terrain normal when applicable),
  not universally radial.
- Wheel/dolly motion follows the camera view ray, samples terrain, and enforces
  clearance rather than independently altering latitude/longitude/altitude.
- Simplify streaming to an authoritative main terrain camera plus optional
  bounded preload camera. Benchmark rather than retain the 178-degree coverage
  camera by habit.
- Keep terrain and imagery LOD independent. Loading thresholds express visual
  policy, not physical accuracy.

### Debugging, tests, and acceptance

- Add optional base/residual/source-boundary/coverage/tile-LOD/source/datum and
  seam debug views.
- Test coordinate and ellipsoid round trips, polar ENU motion, interpolation,
  normals, residual/taper generation, tile/LOD continuity, loading, camera
  clamp, picking, imagery continuity, Earth/Mars/Moon locations, Jezero and
  Shackleton.
- Measure FPS, main-thread and terrain update/sample time, tile count, memory,
  network, and parsing. Sampling cost must be independent of rendered vertex
  count.
- Completion requires explicit datum, renderer-independent CPU sampling, one
  continuous Mars surface, continuous/controlled Moon south-pole surface,
  acceptable LOD transitions without source-specific hacks, maintained mission
  alignment, and automated numerical reports.

## Delivery slices

1. Foundation: audit, datum/source/sample types, CPU sampler, existing data and
   rendering unchanged, unit tests and instrumentation.
2. Mars: reusable fusion tooling, fused Jezero pyramid, validation and catalog
   swap; retain old pipeline.
3. Renderer cleanup: only validated superseded seam logic, camera traversal and
   upstream patches are removed.
4. Moon: canonical/control/detail source work, Shackleton validation, switch,
   then ENU navigation and camera/waypoint validation.
5. Cleanup: deprecate legacy offsets and document supported source conventions.

## Explicit non-goals

Do not replace Three.js or the terrain renderer without evidence, build a new
planetary renderer, promise scientific-grade centimetre accuracy globally,
invent DEMs, couple imagery and terrain, or redesign camera UX.
