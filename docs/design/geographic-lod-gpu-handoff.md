# Geographic vectors: LOD correctness and broad-area GPU cost (handoff)

Status of the work the #278 review asked for (comment 6371187907), on the
integration branch `claude/geographic-integration`: the #278 stack
(#273 → #277 → #278) merged with `claude/geographic-vector-gpu`. The
correctness part is done here, under SwiftShader. The performance part needs
real GPU timings, so it continues on hardware.

## 1. Filled shapes patchy during terrain LOD changes: root cause and fix

**Cause.** The terrain's `TilesFadePlugin` cross-fades LOD changes (300 ms by
default). During a fade the parent tile and its children both draw, each
discarding complementary pixels of a 4×4 Bayer pattern (`wrapFadeMaterial`).
The vector pass drew a proxy of *every* visible tile mesh with no dither, so
both the parent's and the children's proxies drew the fill. Wherever the
child surface lies at or above the coarser parent (depth `LessEqual`, no depth
write), both passed and the translucent fill was blended twice: angular
patches following the parent's triangles, gone once the fade completed. This
is the "settles once LOD stops changing" behaviour in the review videos.

**Fix.** Each proxy now applies its source tile's dither: `TileFade.ts` reads
the fade the plugin set on the tile material, the proxy's `onBeforeRender`
copies it to `vectorFadeIn` / `vectorFadeOut`, and the vector shader discards
exactly the pixels the tile discarded (same Bayer pattern), so every pixel is
filled once. A settled tile (1, 0) never discards. No depth offset was added.

**Evidence** (`docs/validation/geographic-streamed-lod/{before,after}`):

| | Before | After |
| --- | --- | --- |
| Streamed Mars, zooming through LOD (worst step) | 84% of fill pixels blended twice | 0% |
| Streamed Mars, end of zoom | 51% | 0.6% (dark line casings, not fill) |
| Analytic parent + 4 children, mid-fade | 72,700 of 144,426 pixels doubled | 0 of 144,300 |

**Regressions.**
- `scripts/test-geographic-streamed-lod.mjs`: the real viewer on streamed Mars
  terrain (marshub `mars_v14`, network), zooming from a regional to a close view
  while tiles refine. Each step renders the same frame twice, with vectors on
  and off; nothing can load in between. From the difference it estimates each
  covered pixel's fill opacity (0.4 single, 0.64 double). The fade is
  stretched (`CL_FADE_MS`, default 6000) because software frames are slower
  than 300 ms. It asserts that fades happened and that under 1% of pixels are
  doubled.
- `scripts/test-geographic-vectors.mjs` (offline): a parent fading out under
  four relief-bearing children fading in, dithered by the library's own
  `wrapFadeMaterial`, under one translucent fill. Fails without the fix.
- `tile-fade.test.ts`: reading the fade from the real `wrapFadeMaterial`.

**Hardware check (M4 Max, Chrome/Metal, 300 ms fade):** `CL_GPU=hardware
CL_FADE_MS=300` passes, worst step 0.01% doubled
(`docs/validation/geographic-streamed-lod/m4max-300ms`). Only 2 of 40 steps
caught a fade in progress, so the stretched software run remains the stronger
regression.

**Still to check on hardware.** Outline only, opaque fill, holes, seams and
multiple overlay pages through a live zoom at the normal 300 ms fade. The
streamed script covers translucent fills, lines and a hole; run it with
`CL_FADE_MS=300` on a GPU. Separately, look for terrain or imagery LOD
artifacts with vectors off: the script's off frames are the baseline.

## 1b. Speckled fills and staircased edges at very close range

**Cause.** The shader derived latitude/longitude from absolute body-fixed
float32 positions, which step by ~0.25 m at Mars radius (~1 m in degrees):
below ~100 m range neighbouring pixels got equal or jumping coordinates, and
fills and strokes turned to speckle (review screenshot, 2026-10-24).

**Fix.** Positions are offsets from an anchor at the camera, and the shader
computes exact differences of longitude and (Bowring) latitude from the
anchor's, which goes up in whole degrees plus remainder. ANGLE's Metal
compiler reorders float sums, which folded the anchor's whole degrees back in
and left a ~1 m staircase along every edge; whole degrees are therefore
subtracted in integers. Candidates are rejected on coarse coordinates before
the exact arithmetic, which keeps the cost at its previous level (Rhine close
13.1 ms vector cost against 13.5–13.7 ms).

**Regression.** `scripts/test-geographic-close-precision.mjs` (streamed Mars,
network) dollies to ~10 m over the Gale floor and over a region vertex and
asserts no speckle (coverage flips < 1%) and a straight edge (row-to-row jump
≤ 6 px). Before: up to 85% flips; the reorderable float version: 91 px jumps;
now: ≤ 0.25% and 1 px (`docs/validation/geographic-close-precision`).

## 2. Broad-area GPU cost: to measure on hardware

**Scene.** `test-catalogs/geographic-vectors-mars-streamed.json` has six wide
regional polygons (one with a hole) and three long lines around Gale, over
streamed MOLA/HRSC terrain with Viking/CTX imagery. Views: *Gale regional*
(~420 km), *Gale close* (~45 km), *Mars disk*.

**Benchmark.** `scripts/benchmark-geographic-gpu.mjs` now includes
`Gale regional/close · vectors off / wide regions`. Each view settles first,
since residency depends on streaming.

```sh
npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5188 &
CL_GPU=hardware CL_LABEL=m4max-integration node scripts/benchmark-geographic-gpu.mjs
```

That run gives (c), the optimized shader. For (b), the existing shader, check out
`claude/issue-200-geographic-editing`, copy the catalog, its GeoJSON and the
benchmark script over, and run with `CL_LABEL=m4max-stack`. Vectors off is in
both runs.

**Expectation from the SwiftShader numbers.** Scissoring and closed-form
latitude help small, localized annotations a lot, but they help little when
regions cover most of the screen. Every covered pixel still runs the
per-fragment geographic lookup once per page. If hardware confirms the
regional case misses 60 fps at 4K, the review's direction applies: raster-
composited fills for broad static regions, keeping vector outlines, handles,
picking and selection in the shader (#266 `GeoJSONOverlay`, #267 polar/cube
raster correctness). Choose by measured screen coverage and cost, not
editability.

**Not yet added.**
- Zoom-motion traces: frame time and GPU time along a scripted dolly. The
  streamed LOD script's dolly loop is a starting point.
- Texture churn.
- A side-by-side (d) with the upstream raster prototype.

## Hardware results (M4 Max, 3840×2160)

`docs/validation/geographic-gpu/m4max-stack` (existing shader, #278) and
`m4max-integration` (scissor + closed-form latitude). Vector cost = GPU median
minus the same view with vectors off; ranges are two runs of the integration
branch, so streamed scenes vary with what is resident.

| Scene | #278 shader | Integration |
| --- | --- | --- |
| Jezero close · one small polygon | 1.36 ms | 0.07–0.09 ms |
| Dense Jezero · 1,601 features | 7.45 ms | 2.78 ms |
| Jezero terrain · vectors on | 6.86 ms | 3.8–4.4 ms |
| Earth orbit · countries | 5.26 ms | 4.1–5.1 ms |
| Rhine close · countries (full screen, 6 pages) | 13.95 ms | 13.5–13.7 ms |
| Gale regional · wide regions | 1.7 ms (p95 10 ms) | 3.5–5.0 ms |
| Gale close · wide regions | 5.73 ms | 3.7–5.3 ms |

**Reading.** The optimizations remove most of the cost of small, local
annotations. Broad coverage is unchanged, as expected: it is per covered pixel
per page. The review's regional case (Gale, 9 wide features, 4 pages) costs
about 4–5 ms at 4K and holds 60 fps on this GPU. The case that nearly fills the
frame budget is global countries seen close (Rhine: full-screen coverage across
6 pages, ~15 ms total frame). That case, not Gale, is the one for raster-
composited fills of broad static regions; reducing pages drawn per pixel (only
pages whose features touch the tile) is the cheaper first step to try.

## 3. One draw per pass instead of one per page

A review trace (Gale floor, tens of metres up, contours on) showed the GPU
process busy most of the time at a steady frame rate: each page of features
re-drew every visible terrain tile, so 4 pages × 100–250 tiles made 400–830
vector draws a frame, and each re-ran the per-fragment set-up (Bowring
latitude, derivatives, grid choice). The shader now loops over a pass's pages
itself and composites them in order, so a pass is one draw per tile. Close up,
where a finer grid holds fewer pages, the loop stops at that grid's count,
which covers "skip pages close up" too.

Pages are composited in linear colour and converted to output once. Converting
inside the loop, which would match framebuffer blending exactly, made Rhine
close about twice as slow on Metal. The difference shows only where
anti-aliased fringes of two pages overlap: 16 pixels of 921,600 in Earth orbit,
none elsewhere; the offline smoke images are unchanged.

`docs/validation/geographic-gpu/m4max-one-pass`: two interleaved runs each,
whole-frame GPU ms (vector cost in brackets).

| Scene | Draws before → after | Before | After |
| --- | --- | --- | --- |
| Dense Jezero | 99 → 11 | 1.85–4.87 (1.1–3.2) | 0.73–0.99 (0.2–0.3) |
| Gale regional | 552 → 138 | 2.5–4.7 | 1.8–2.3 |
| Gale close | 828 → 207 | 7.0–7.2 (4.0–4.4) | 5.9–6.2 (4.4–5.0) |
| Gale very close | 396 → 99 | 5.0–6.5 | 4.2–4.3 |
| Earth orbit (one mesh) | 6 → 1 | 6.3–6.4 | 5.5–7.2 |
| Rhine close (one mesh) | 6 → 1 | 15.4–16.3 | 15.5–17.3 |

CPU time of the browser's processes while rendering Gale close at 60 fps
(`process-cpu.mjs`), vectors on minus off, in cores: GPU process 0.06–0.08 →
0.02–0.03, renderer 0.21–0.23 → 0.09–0.12. At tens of metres the vector share
is small either way. Terrain contours add little GPU time (~0.3 ms at 4K).

**Is raster-composited fill (the review's suggestion) needed?** Not for Gale:
after this change its vectors cost 3–5 ms at 4K, inside a 60 fps budget.
Broad fills seen close remain the expensive case: Rhine countries are 15 ms at
4K, every covered pixel testing its cell's fill triangles across 6 pages, and
one draw instead of six does not change that work. That is the case for
raster fills of broad static regions, or a cheaper first step: mark index cells
a polygon's interior covers entirely, so those pixels skip the triangle tests.

## 4. Highlight specks at grazing views

Selecting an outline at a low angle lit scattered pixels on distant terrain.
Strokes convert distances to pixels with screen derivatives, and a 2×2 quad
that straddles a silhouette (a ridge and the ground far behind it) differences
two surfaces, so its derivatives are far larger than a pixel's footprint. The
shader now bounds them by the footprint of the view ray's step on the
ellipsoid's tangent plane (the anchor is the camera, so the offset is the ray,
whose step is continuous), allowing twice that for real slopes.
`scripts/test-geographic-grazing-highlight.mjs` counts isolated highlight
pixels 120 m above the Gale floor: 86 before, 29 after (the rest are distant
stretches of the outline breaking up). Offline smoke images are unchanged but
for one limb pixel; GPU cost is unchanged.

## Checks run here

Unit tests for renderer, footprint and fade (45); the viewer catalog list;
lint; purity lint; test typecheck; the analytic-relief smoke (all checks); and
the streamed LOD script, before and after the fix.
