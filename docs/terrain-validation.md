# Terrain validation, debug views and performance baseline

Issue #52, part of the [planetary terrain refactor](planetary-terrain-refactor.md)
(#47). The goal is to make terrain correctness measurable — and cheap to check —
before expensive full dataset builds (#50 Mars, #48 Moon) or renderer cleanup.
None of these numbers come from looking at the screen.

Everything below reads the **same decoded data the viewer's CPU sampler uses**:
`packages/three/src/TerrainValidation.ts` decodes quantized-mesh with the
runtime decoder, applies a tileset's `referenceRadiusOffsetKm` exactly as
`TerrainManager` does (`toTerrainMeshTile`), and samples through
`TerrainSampler`. It imports nothing from Three.js, so it runs in Node, in the
browser and in tests alike.

## Small-area validation: `npm run validate:terrain`

```bash
npm run build                                     # the CLI imports packages/three/dist
node scripts/validate-terrain.mjs --list
node scripts/validate-terrain.mjs --preset mars-jezero
node scripts/validate-terrain.mjs --preset moon-shackleton --out moon.json
node scripts/validate-terrain.mjs --preset mars-jezero-fused   # after scripts/build-mars-terrain/fused.sh
node scripts/validate-terrain.mjs --preset moon-shackleton-fused  # after scripts/build-moon-terrain/fused.sh
```

A run fetches tens of tiles, not a pyramid. `--max-tiles` (default 256) is one
budget of unique tiles for the whole run — region, registration, boundary and
control-point loads alike — and a batch that would exceed it is refused before
any of its requests start. Tiles are cached under
the OS temp dir (`--cache-dir`), and prints a Markdown summary. `--out` writes
the full JSON report, every control point included.

| Preset | Tileset | Region | Control points |
|---|---|---|---|
| `mars-jezero` | Mars Hub `mars_v14`, offset 8.765 km (as `msl-dingo-gap.json`) | ~2 km box on Wright Brothers Field, z13/14 | 73 Ingenuity landing sites (MMGIS `Elev_Geoid`) |
| `mars-jezero-fused` | the fused `scripts/build-mars-terrain/fused.sh` pyramid (as `ingenuity-jezero.json`) | same | same |
| `moon-shackleton` | Mars Hub `moon_v14` (as `moonfall-shackleton.json` configures it) | Shackleton rim, z8/9 (`moon_v14` stops at z9 there) | 36 MoonFall waypoints (LOLA LDEM 118 m) |
| `moon-shackleton-fused` | the fused `scripts/build-moon-terrain/fused.sh` pyramid (local; no catalog streams it until it is hosted, #137) | Shackleton rim, 1° × 0.1°, z11/12 | same |

Any field can be overridden: `--url` (http(s) or a local directory, gzip
handled), `--offset-km`, `--bounds w,s,e,n`, `--levels 13,14`,
`--canonical-level 9`, `--boundary w,s,e,n|auto`, `--control-points file.json`
(an array of `ControlPoint`). `--max-edge-m`, `--max-parent-child-m` and
`--max-control-delta-m` turn the run into a gate (exit status 1 when exceeded).
A gate passes only on complete data: it also fails when its comparison is
missing anything — region tiles `layer.json` lists but the server does not
return, unanswered edge or parent/child samples, control points with an
expected value but no sample — unless `--allow-missing N` tolerates up to N of
them. The report's *Missing data* section (and `missing` in the JSON) lists
what was absent either way.

There is no Earth preset: no Earth quantized-mesh source is configured in this
repo without a Cesium ion token. Earth is covered by the coordinate tests
(equator, mid and high latitude on WGS84).

### What each report measures

All statistics are over signed differences: count, mean, RMS, nearest-rank
p95 of |d| and max |d|. An empty comparison reports NaN (`—`), never 0.
Aggregates pool mean/RMS/max exactly; the pooled p95 is the worst
per-comparison p95, which is conservative.

- **Same-LOD shared edges** — heights sampled from each side of every edge two
  same-level tiles share (b − a, east or north). A continuous pyramid has
  equivalent samples on both sides; anything here is a crack skirts must hide.
- **Parent/child** — the child's 17×17 grid, which lands on the parent's own
  dyadic positions, sampled in both (child − parent). This is the detail a
  level adds plus any level-to-level bias; a bias is what makes LOD swaps pop.
- **Registration** — a 33×33 grid over the region, deepest-detail layer minus
  canonical layer, with a least-squares plane fitted in local east/north km:
  the offset (at the centroid), slopes and tilt are what a fusion step must
  disclose and remove (#50); `plane.residual` is what remains.
- **Coverage boundary continuity** — transects across each edge of a boundary
  (`auto`: the `layer.json` availability rectangle at `--boundary-level`
  containing the region) compare height curvature *at* the boundary with
  curvature *away* from it. Ratio ≈ 1: the boundary is invisible in the height
  field (a residual tapered to zero). Ratio ≫ 1: a hard source switch.
- **Control points** — every point sampled from the canonical layer (deepest
  tile ≤ `--canonical-level`) and the detail layer (deepest available), with
  Δ = sampled − expected, the expected value's datum stated, and the source
  and tile id that answered.
- **Sampling cost** — µs per CPU query for each decoded tile. Bounded per tile
  by the sampler's triangle binning; it has no relationship to rendered vertex
  count because the sampler never touches rendered geometry.

## Debug surface views

Diagnostics panel → Terrain → *Debug view*, or
`renderer.setTerrainDebugMode(mode, bodyName?)`. Every mode swaps tile
materials for flat unlit colours and restores them on `none`; *Tile bounds*
still toggles the bounding volumes independently.

| Mode | Colour |
|---|---|
| `lod` | tile depth, shallow dark → deep bright |
| `geometric-error` | the tileset's declared error |
| `screen-error` | the screen-space error computed for this frame — what drives refinement |
| `cpu-coverage` | green: the CPU sampler holds this tile's own heights · amber: synthesized by splitting a parent (CPU queries answer from the parent, one level coarser) |
| `datum-height` | mean tile height vs the terrain datum, blue below · red above (below-reference terrain such as Jezero is explicit) |
| `seam-error` | max shared-edge mismatch with cached same-level neighbours, green 0 → red ≥ `seamErrorScaleKm` (5 m) · grey: no neighbour cached. The same computation as the offline seam report |

Base terrain, regional residual and source/coverage-boundary views need the
coverage mask and residual metadata the fused products will emit (#50, #48);
they are added with those products rather than faked from today's data.

## Performance metrics

`BodyMesh.terrainMetrics` / `TerrainManager.metrics`
(`TerrainPerformanceMetrics`), shown in the Diagnostics panel's Terrain
section for the selected body (or the first body with streamed terrain):

- `update` — `tiles.update()` wall time per frame, mean/max over 120 frames;
- `parse` — renderer mesh construction per tile; `cpuDecode` — CPU decode and
  triangle binning per tile;
- `sample` — CPU query count and last/mean cost;
- `tiles` — active, visible, LRU-cached and CPU-decoded tile counts;
- `network` — requests issued, queued/downloading/parsing, failed;
- `memory` — LRU cache bytes, and a geometry/texture estimate from the
  buffers of every loaded tile, including ones cached out of view, imagery
  overlay textures, and the real materials the debug plugin holds aside while
  a debug mode is on. Textures are counted once per shared `Source` and sized
  with upstream's `MemoryUtils.getTextureByteLength` (format and mipmaps), so
  geometry + textures tracks the LRU cache bytes.

`resetMetrics()` restarts the windows for a before/after comparison. In the
browser, `performance.now()` is coarsened to ~0.1 ms without cross-origin
isolation, so in-page per-sample µs are noisy; use the CLI's sampling-cost
table for the per-query cost.

## Baseline — 2026-10-02

Numbers from the current `main` data products, before any fusion or renderer
cleanup. Re-run the presets to compare.

### `mars-jezero` (mars_v14, offset 8.765 km)

| | n | mean (m) | RMS (m) | p95 \|d\| (m) | max \|d\| (m) |
|---|---|---|---|---|---|
| Same-LOD edges (16), z13/14 | 1040 | −0.02 | 0.17 | 1.20 | 1.75 |
| Parent/child (9), child z14 | 2601 | −0.08 | 1.17 | 2.72 | 4.16 |
| Registration z≤14 − z≤9, raw | 1089 | 2.81 | 9.21 | 15.01 | 24.08 |
| Registration, after planar fit | 1089 | 0.00 | 3.74 | 7.63 | 13.57 |

Fitted offset 2.8 m, slopes 8.6 m/km east and −20.7 m/km north (tilt 1.28°).
Coverage-boundary curvature ratio at the z14 availability edge: 0.65 (no
hard boundary in the composite height field there).

**Control points: with `referenceRadiusOffsetKm: 8.765`, mars_v14 sits
549.6–556.6 m below the MMGIS `Elev_Geoid` value at all 73 Ingenuity landing
sites** (canonical z≤9: 516–569 m). The tight 7 m spread says this is a single
vertical bias, not spatial drift: the 8.765 km constant was calibrated at Gale
(`msl-dingo-gap.json`) and does not carry to Jezero, or the areoid-vs-ellipsoid
datum differs between the two places. Either way it is exactly the kind of
correction #47 says must be explicit datum metadata rather than a renderer
constant. (`ingenuity-jezero.json` uses the self-built pyramid, not mars_v14;
validate it with `mars-jezero-fused`.)

### Retired CTB pyramid (was `mars-jezero-local`, removed in #50)

| | n | mean (m) | RMS (m) | p95 \|d\| (m) | max \|d\| (m) |
|---|---|---|---|---|---|
| Same-LOD edges (16), z13/14 | 1040 | 0.03 | 0.17 | 1.21 | 1.39 |
| Parent/child (9), child z14 | 2601 | −0.17 | 1.62 | 5.97 | 9.46 |
| Registration z≤14 − z≤9, raw | 1089 | 2.57 | 6.37 | 14.03 | 25.84 |
| Registration, after planar fit | 1089 | 0.00 | 5.34 | 11.57 | 19.33 |

Fitted offset 2.6 m, slopes −6.4 m/km east and 0.1 m/km north (tilt 0.36°).
Coverage-boundary curvature ratio at the z14 HiRISE availability edge: 1.04.
**Control points: the detail layer is within 1.6 m of MMGIS `Elev_Geoid` at
all 73 Ingenuity sites** (mean +0.57 m, RMS 0.84 m); the z≤9 MOLA/HRSC
canonical layer differs by up to 81 m. This is the pyramid the Ingenuity demo
streams, and the reason its mission alignment holds where mars_v14's does not.

### `mars-jezero-fused` (#50, `scripts/build-mars-terrain/fused.sh`)

One pyramid from height = MOLA/HRSC(lon, lat) + tapered HiRISE residual,
written by `scripts/terrain/dem.py`: Catmull-Rom base, RTIN mesh with every tile
edge at full 65-vertex resolution and chord sag counted as error (so low-zoom
tiles keep the globe round), and oct-encoded normals from the same field (no
per-tile shading seams). Same Wright Brothers Field box as above:

| | n | mean (m) | RMS (m) | p95 \|d\| (m) | max \|d\| (m) |
|---|---|---|---|---|---|
| Same-LOD edges (16), z13/14 | 1040 | 0.00 | 0.00 | 0.00 | 0.00 |
| Parent/child (9), child z14 | 2601 | −0.02 | 0.61 | 1.83 | 2.84 |
| Control points, detail layer (73) | 73 | 0.05 | 0.16 | 0.31 | 0.41 |

Across the HiRISE coverage edge (box 77.235–77.257 E, 18.478–18.498 N), old →
fused: same-LOD edges max 0.51 → 0.01 m, parent/child RMS 2.98 → 0.45 m (max
19.4 → 2.1 m). At the raster level (`fusion.json` → `boundary`, 96 680 pixel
pairs straddling the coverage edge) a hard source switch would step up to
79 m (RMS 18.8 m); the fused field steps exactly as much as MOLA/HRSC itself
does between neighbouring pixels (max 0.35 m).

Registration (whole HiRISE footprint, 4.7 M samples): HiRISE − MOLA/HRSC
mean −7.9 m, RMS 18.9 m; fitted plane offset −8.66 m, slopes +1.01 m/km east,
−0.69 m/km north. The plane is **disclosed but not removed** (`--bias none`):
removing it would move the surface 3.8–13.6 m off the Ingenuity airfield
elevations, which live in the HiRISE frame. The 1 km taper carries the bias
back to MOLA/HRSC instead.

### `moon-shackleton` (moon_v14)

| | n | mean (m) | RMS (m) | p95 \|d\| (m) | max \|d\| (m) |
|---|---|---|---|---|---|
| Same-LOD edges (16), z8/9 | 1040 | −0.16 | 6.87 | 59.94 | 69.43 |
| Parent/child (12), child z9 | 3468 | −17.57 | 34.41 | 80.10 | 81.55 |
| Registration z≤9 − z≤7, raw | 1089 | 8.33 | 50.62 | 108.92 | 165.62 |
| Registration, after planar fit | 1089 | 0.00 | 38.11 | 70.57 | 144.51 |

Against the 36 LOLA 118 m waypoint elevations the deepest moon_v14 tiles
(z9 at the pole) differ by −48 to +67 m (RMS 22.5 m). Tens-of-metres polar
seams and level-to-level bias are the quantified version of the Shackleton
discontinuities #48 removes (next section).

### `moon-shackleton-fused` (#48, `scripts/build-moon-terrain/fused.sh`)

One pyramid from LOLA LDEM 118 m plus the LOLA 87°S mosaic (Barker et al.
2021, 10 m) as a residual tapered over 2 km, with the polar-stereographic
residual path of `dem.py` (the surface is the mosaic wherever its weight is 1,
and single-valued at the pole). Global z0–9, regional z10 over the mosaic,
z11 south of 87°S, z12 south of 88.5°S. Shackleton rim box −45.5…−44.5 E,
−89.6…−89.5 N:

| | n | mean (m) | RMS (m) | p95 \|d\| (m) | max \|d\| (m) |
|---|---|---|---|---|---|
| Same-LOD edges (151), z11/12 | 9815 | −0.00 | 0.00 | 0.01 | 0.01 |
| Parent/child (72), child z12 | 20808 | 0.01 | 0.87 | 4.52 | 6.25 |
| Registration z≤12 − z≤9, raw | 1089 | 1.63 | 5.47 | 9.98 | 13.66 |
| Registration, after planar fit | 1089 | 0.00 | 4.88 | 9.48 | 13.38 |
| Control points, detail layer (36) | 36 | −0.03 | 6.95 | 16.82 | 17.51 |

The registration tilt here (0.63°) is local relief — 10 m terrain against the
118 m canonical layer over a 3 km box — not a source misregistration: over the
whole mosaic (`fusion.json`, 5.0 M samples) polar − global is −0.24 m mean,
3.6 m RMS, with a fitted plane of −0.24 m and slopes under 0.002 m/km.

At the pole (0…3 E, −90…−89.95 N, z11/12): same-LOD edges max 0.02 m,
parent/child RMS 1.79 m (max 6.84 m). Decoding every tile that touches the
pole, the pole vertex is single-valued at every level — the spread across all
2^(z+1) tiles of a row is below one height quantum (9 mm across 532 480 pole
vertices at z12). Across the mosaic's taper band (40…44 E, −86.9…−86.4 N,
z9/10): same-LOD edges max 0.07 m; parent/child RMS 4.4 m is the ordinary
z9→z10 change over 118 m terrain. At the raster level a hard source switch
would step up to 42 m across the coverage edge; the fused field steps exactly
as much as LOLA 118 m itself does between neighbouring pixels (max 35 m on
crater walls, RMS 1.9 m).

The 36 MoonFall waypoint elevations (nearest-pixel LOLA 118 m) differ from the
fused surface by RMS 6.95 m, max 17.5 m (moon_v14: RMS 22.5 m, max 67 m). The
waypoints are authoritative and unchanged, so the finer surface moves some
authored heights above ground: of the 1–5 m touchdown and perch points, the
largest are Polaris-B's landing at (−89.30, 120) 12.9 m and Polaris-C's perch at
(−89.73, 50) 10.8 m *below* the fused surface; the rest are within ±3 m or
above it.

`fusion.json` reports residual maxima of ~3.9 km: isolated ±8 km spike clusters
in the LOLA 118 m source near the pole (a few hundred pixels, mostly 88–89°S).
All lie in the mosaic's full-weight region, so none reach the pyramid.

#### MoonFall in the viewer near 89°S (headless Chromium, SwiftShader — container)

Surface Explorer stations at the Polaris-A base (−89.55, −45), the rim at
30°E, 10 km above Shackleton's centre and 4.5 km from the pole, each run
against the fused pyramid (MoonFall pointed at the local build) and against
`moon_v14`:

- **Picking.** On the fused pyramid every centre-screen pick hits the Moon and
  equals the CPU sampler at the picked point (Δ 0 m; e.g. Shackleton's floor at
  −2.75 km). On `moon_v14` none of the picks had a sampler answer, the camera
  placed 300 m above the Polaris-A base ended up under the `moon_v14` surface
  (the pick passed through the Moon, 1178 km away), and the crater floor
  picked at +0.76 km.
- **Sampler cache.** A view near the pole holds 400–3200 decoded sliver tiles,
  so the default 256-tile CPU sampler cache evicted the tiles under the camera
  before picking and dolly clearance could sample them. MoonFall sets
  `samplerMaxTiles: 4096`.
- **Pole crossing.** Holding W due south from (−89.9, 0) at 1.8 km crosses the
  pole and comes out on the 180° meridian heading north at the same height: a
  7.4 km path whose length equals its chord, cross-track < 1e-12 km, no
  backward step. Identical on `moon_v14`: navigation does not depend on the
  terrain.
- **Hoppers.** The CPU sampler only answers where decoded tiles exist, so
  hopper clearance is checked offline against the pyramid instead (control
  points above).

Not covered here: a visual pass at full detail. SwiftShader in the container
renders ~1.2–1.4 fps (at the equator as at the pole) and the tile parse queue
advances per frame, so no view finishes refining — frames show z1–z3 facets
however long they settle. Imagery is also unreachable from the container
(trek.nasa.gov) and the Sun is within ~1.5° of the horizon at the catalog
epoch. The numbers above come from the CPU-side data the renderer consumes;
the look of the refined Shackleton surface still needs a GPU run.

### Runtime (Chromium, Apple M4 Max, ANGLE Metal)

Headless Chromium against the dev server, 30 s after load, default viewpoints:

| Scene | FPS | visible / cached / CPU tiles | `tiles.update()` mean | parse / CPU decode per tile | LRU | geometry / textures |
|---|---|---|---|---|---|---|
| `ingenuity-jezero` | 120 | 77 / 102 / 102 | 0.27 ms | 0.24 / 0.09 ms | 30.8 MB | 3.8 / 27.0 MB |
| `moonfall-shackleton`, streaming | 120 | 11 / ~900 / 256 | 1.5 ms | 0.20 / 0.09 ms | 74 MB | — |
| `moonfall-shackleton`, settled (~60 s) | 72–84 | 1073 / 1430 / 256 | 3.2–3.8 ms | — | 371 MB | 3.7 / 368 MB |

MoonFall's drop from 120 to ~80 FPS is the scene settling to 1073 visible
tiles (~2160 draw calls), confirmed by a control run with no debug modes; it
is the renderer-cleanup slice's number to beat. Debug modes cost nothing
measurable on Jezero (118–120 FPS in every mode); returning to `none`
recompiles every tile's shaders once (a sub-second dip on MoonFall), after
which FPS and update time match the control because the plugin is
unregistered whenever no view and no bounds are on.

CPU query cost on the local Mars pyramid (Node 22, M4 Max): 0.14–0.42 µs on
tiles of 6–1692 vertices.

### Runtime (headless Chromium, SwiftShader — container)

MoonFall, Shackleton Overview, ~45 s after load, no debug mode: 8–56 visible
tiles, `tiles.update()` 1.8–30 ms mean per frame (SwiftShader; GPU-backed
browsers are far lower), mesh parse 1.1–1.7 ms and CPU decode 0.4–1.1 ms per
tile, 180–370 requests, geometry ≈ 0.15–6 MB, textures 8 MB (one shared
2048×1024 normal map). FPS under SwiftShader (1–2) is not a meaningful
baseline; record FPS on real hardware when comparing renderer changes.

CLI sampling cost (Node 22): 0.4–2.0 µs per query on Mars tiles of 4–432
vertices; 1.3–1.5 µs on Moon tiles of 19–284 vertices.

## Not yet covered

- Base/residual/coverage-boundary debug views — the fused Mars product now ships `residual.tif`, `coverage.tif` and `weight.tif` (in `scripts/build-mars-terrain/data/fused/`); the views themselves are tracked in #135.
- Renderer-level tests for LOD transitions, camera clamp, picking and
  imagery-overlay continuity need a GL-capable harness; the CPU-side pieces
  (sampling, coordinates, seams, pyramid, residual taper detection) are unit
  tested in `TerrainValidation.test.ts` and `TerrainManagerSampling.test.ts`.
- An "after" performance comparison belongs to the renderer-cleanup slice.
