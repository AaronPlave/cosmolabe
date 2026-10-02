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
node scripts/validate-terrain.mjs --preset mars-jezero-local   # after scripts/build-mars-terrain
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
| `mars-jezero-local` | the self-built `scripts/build-mars-terrain` pyramid (as `ingenuity-jezero.json`) | same | same |
| `moon-shackleton` | Mars Hub `moon_v14` (as `moonfall-shackleton.json`) | Shackleton rim, z8/9 (`moon_v14` stops at z9 there) | 36 MoonFall waypoints (LOLA LDEM 118 m) |

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
  buffers of every loaded tile, including ones cached out of view, and the
  real materials the debug plugin holds aside while a debug mode is on
  (textures counted once per shared `Source`).

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
validate it with `mars-jezero-local`.)

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
discontinuities #48 has to remove.

### Runtime (headless Chromium, SwiftShader)

MoonFall, Shackleton Overview, ~45 s after load, no debug mode: 8–56 visible
tiles, `tiles.update()` 1.8–30 ms mean per frame (SwiftShader; GPU-backed
browsers are far lower), mesh parse 1.1–1.7 ms and CPU decode 0.4–1.1 ms per
tile, 180–370 requests, geometry ≈ 0.15–6 MB, textures 8 MB (one shared
2048×1024 normal map). FPS under SwiftShader (1–2) is not a meaningful
baseline; record FPS on real hardware when comparing renderer changes.

CLI sampling cost (Node 22): 0.4–2.0 µs per query on Mars tiles of 4–432
vertices; 1.3–1.5 µs on Moon tiles of 19–284 vertices.

## Not yet covered

- Base/residual/coverage-boundary debug views — with the fused products (#50, #48).
- Renderer-level tests for LOD transitions, camera clamp, picking and
  imagery-overlay continuity need a GL-capable harness; the CPU-side pieces
  (sampling, coordinates, seams, pyramid, residual taper detection) are unit
  tested in `TerrainValidation.test.ts` and `TerrainManagerSampling.test.ts`.
- An "after" performance comparison belongs to the renderer-cleanup slice.
