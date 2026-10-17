# Cube-sphere Surface Appearance — issue #260

Surface Appearance now supports Cosmolabe's known planetary cube product in
MoonFall/Shackleton and the cube imagery experiments. It reuses the existing
`SurfaceAppearance` shaders, settings and per-body controls. Generic 3D Tiles
and unknown references remain excluded. #182 stays open for its other surface
visualization and polar-quality work; contours remain under #183.

## Eligibility and coordinates

The capability waits for the existing CPU-grid manifest and root tileset. It
requires `cosmolabe-cube-height-grid-1`, the known `dem.py cube-tile`/`cube-error`
builder convention, matching nonempty product revisions, an explicit radial
reference-sphere datum matching the body, the known metre height encoding, and
validated finite product height bounds. Every styled mesh must have a valid
`surfaceTriangles` count, unit scale, and ground positions inside those bounds
(with 1 m allowance for float32 offsets). Missing metadata, generic generators,
revision disagreements, unsupported datums, unknown mesh topology and incorrect
units fail closed. This consumes metadata already fetched by the cube source;
styles add no source or analysis requests.

Vertex elevation is `length(localToBody * position) / 1000 - radiusKm`.
`localToBody` includes glTF's Y-up conversion, node translation and every tile
ancestor before `tiles.group`. It excludes the world origin, body attitude and
metre-to-scene scaling. Heights are computed in double precision then stored as
float32 shader attributes. The real product uses a 1737.4 km sphere. These are
heights of displayed vertices, not an accuracy claim about the underlying DEM.

The material setup leaves the builder's physical normals intact. Position,
normal and index buffers, datum/frame definitions, CPU grids, sampling and
measurement data remain independent of style settings.

## Imagery, visibility and skirts

- Source meshes attach to the shared style after cube imagery installs its
  hooks. Imagery blocks clone the existing material chain and receive one style
  wrapper. Heights and relief normals are clipped barycentrically with each
  source triangle, rather than recomputed from the clipped mesh. This preserves
  the shader color field and physical reference through imagery refinements.
- Source attribute identity/version changes invalidate cached blocks. Uniform
  edits retain blocks; skirt toggles rebuild them. Dynamic upstream program keys
  and fade defines follow the source, while the existing fade uniforms, shadows,
  atmosphere hooks and imagery debug modes compose normally.
- The source tile scene owns normal-field visibility, even while imagery hides
  its original drawing mesh. Detached or hidden cached parents stop contributing;
  showing them restores their contribution. Clipped blocks never add normals to
  the shared field. Disposal releases their style records.
- Cube meshes have ungrouped surface triangles followed by skirt triangles.
  `surfaceTriangles` excludes the walls from relief calculations; indexed wall
  topology connects lower skirt copies to their ground edge, tolerating float32
  angular roundoff. Skirts inherit ground corrections without contributing wall
  slopes. Existing unmatched mixed-LOD geometry and source imagery artifacts
  remain visible; this styling change does not repair them.
- Picking recognizes an original source hidden only because its imagery blocks
  are drawn, while still rejecting hidden ancestors. Range picks interpolate the
  source height attribute, matching the displayed tint. Hover preview uses the
  existing rendered surface discovery with CPU sampling disabled, so visual
  range picking does not request grids. Point Probe and measurement exclusion
  and Escape cancellation continue through the existing pointer-tool lifecycle.
- Controls become available after asynchronous metadata validation. Disabled
  styles remove their attributes and shader additions. The normal frame path
  skips preparation, normal reconciliation and imagery-field invalidation.

## Real GPU acceptance

The reproducible harness uses normal viewer mode, actual local built products,
and hardware ANGLE Metal on **Apple M4 Max**. All initial assets loaded, and
there were no page or shader errors. Captures use existing explicit body-fixed
Shackleton and south-pole overview poses, paused playback, and a 1440 × 1000
viewport. The NAC experiment deliberately caps geometry at `maxDepth = 5` to
exercise coarse terrain split into finer imagery blocks; its faceting reflects
that displayed geometry. MoonFall uses its normal geometry refinement.

| Product / view | Imagery | Hillshade | Elevation + hillshade |
| --- | --- | --- | --- |
| MoonFall close | [capture](moonfall-close-imagery.png) | [capture](moonfall-close-hillshade.png) | [capture](moonfall-close-elevation.png) |
| MoonFall far | [capture](moonfall-far-imagery.png) | [capture](moonfall-far-hillshade.png) | [capture](moonfall-far-elevation.png) |
| NAC close, coarse geometry | [capture](nac-close-imagery.png) | [capture](nac-close-hillshade.png) | [capture](nac-close-elevation.png) |
| NAC far | [capture](nac-far-imagery.png) | [capture](nac-far-hillshade.png) | [capture](nac-far-elevation.png) |

[MoonFall phone layout](moonfall-mobile.png) and [NAC phone layout](nac-mobile.png)
use 390 × 844. Document width stays 390 px, controls occupy 346 px, the panel
body scrolls, and the enclosing dock stays at scrollTop 0. This is Chromium
viewport verification, not a physical-phone or low-end mobile GPU benchmark.

Across all four views, the harness verifies:

- Adjustable artificial lighting changes visible relief; neutral/imagery and
  elevation/imagery blending, palette, fixed range and legend controls work.
- Enabling styles keeps source tile IDs and terrain, imagery and grid request
  counts unchanged. Physical position/normal/index buffers remain byte identical.
- Rendered height attributes agree with the reference calculation within
  0.5 mm, a float32 representation check, not source DEM accuracy. Controlled
  tests also verify axis rotation, translation, world scaling exclusion, metre
  conversion and barycentric interpolation of newly clipped vertices.
- Picks succeed with split imagery, change only the selected range bound, and
  request no grids during hover or click. Escape cancels the next bound pick.
- Skirt disable/enable rebuilds blocks with styling intact. LOD, imagery-level
  and imagery-unlit debug round trips restore identical styled canvas pixels.
- Disabling styles restores **zero changed canvas pixels** and removes height
  fields. For both real products, close–far–close navigation gives identical
  neutral hillshade pixels, source tiles, camera matrices and relief-normal
  fields. The navigation check isolates hillshade with imagery amount 0 because
  the imagery cache independently refines distant textures along that path.

The exact product revisions, requests, geometry counts, interpolation errors,
frame samples, activation preparation and navigation diagnostics are retained in
[results.json](results.json). The known cube revision is
`cube-fused-79895697c6b6-g3-m12-b6747ec9d`; imagery uses the real NAC and MoonFall
WAC/NAC composite revisions recorded there.

## Costs

The main run samples 60 animation frames per mode and view. Medians below are
CPU frame time / GPU timer-query time in milliseconds; measurements vary with
cache state and driver scheduling and should not be read as a speedup claim.

| Product / view | Imagery | Hillshade | Tint + hillshade | Disabled again |
| --- | ---: | ---: | ---: | ---: |
| nac close | 2.00 / 0.68 | 1.70 / 0.70 | 1.90 / 0.74 | 1.60 / 0.77 |
| nac far | 1.30 / 1.18 | 1.50 / 1.10 | 1.70 / 1.14 | 1.10 / 1.17 |
| moonfall close | 2.10 / 2.79 | 2.30 / 2.59 | 2.20 / 2.40 | 2.00 / 2.86 |
| moonfall far | 1.90 / 1.96 | 1.80 / 1.82 | 2.00 / 1.74 | 1.80 / 1.97 |

A separate first-use run stops the animation loop, fences each manually rendered
frame and records CPU submission/compilation plus GPU timer queries. It starts
from normal imagery and enables elevation plus hillshade together. The normal
and warm/disabled comparisons each contain 30 frames. Raw samples and per-tile
preparation are in [activation.json](activation.json).

| Product | Preparation frames / tiles | First frame CPU / GPU | Max activation CPU / GPU | Warm styled CPU / GPU median |
| --- | ---: | ---: | ---: | ---: |
| nac | 6 / 7 | 60.00 / 0.84 | 60.00 / 0.84 | 1.60 / 0.67 |
| moonfall | 24 / 48 | 61.40 / 1.28 | 61.40 / 6.47 | 2.20 / 1.37 |

First use is visibly more expensive than steady state: it prepares fields,
reclips imagery blocks, uploads attributes and compiles shader variants. The
4 ms preparation budget yields between tiles; each tile is atomic (about 7 ms
for the first tile here). Disabling also has a one-time program/upload cost;
warm disabled style-update time is below the browser timer's resolution.
These measurements establish the costs on this GPU, not smooth first activation
on slower hardware.

## Automated checks and reproduction

Focused surface, cube imagery, range-pick, shell and panel tests: **112 passed**.
These include hidden-parent visibility, cached LOD round trips, eviction,
source-normal sharing, skirt roundoff, material/fade key composition, actual
shadow/atmosphere shader injection and clipped height interpolation. Package
build, test/viewer TypeScript checks, Svelte checking, changed-file ESLint and
production viewer bundling pass.

The broad suite reports 2,171 passed, 7 skipped and two unrelated failures:
`gf-reporting.test.ts` expects a throttled intermediate progress event, and
`event-search-availability.test.ts` enumerates five pre-existing ignored local
MoonFall experiment catalogs absent from its expected list. Data-hosting tests
pass with localhost binding enabled; the restricted run also had eight bind
failures. No catalog files or CSPICE progress behavior changed in this issue.

```sh
npm run build
npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5196 --strictPort
# Another terminal, with the existing local cube terrain and imagery products:
CUBE_STYLE_URL=http://127.0.0.1:5196 node scripts/test-cube-surface-appearance.mjs
CUBE_STYLE_ACTIVATION_ONLY=1 CUBE_STYLE_OUT=work/cube-surface-appearance/activation \
  node scripts/test-cube-surface-appearance.mjs
```

Build data with `scripts/build-moon-terrain/cube.sh` and `cube-imagery.sh` if it
is absent. Runtime styling adds no data product, service or extra source fetch.
Scratch capture output is ignored under `work/cube-surface-appearance/`; the
review captures and JSON above are explicit snapshots.
