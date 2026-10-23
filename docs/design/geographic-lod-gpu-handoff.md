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

**Still to check on hardware.** Outline only, opaque fill, holes, seams and
multiple overlay pages through a live zoom at the normal 300 ms fade. The
streamed script covers translucent fills, lines and a hole; run it with
`CL_FADE_MS=300` on a GPU. Separately, look for terrain or imagery LOD
artifacts with vectors off: the script's off frames are the baseline.

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

## Checks run here

Unit tests for renderer, footprint and fade (45); the viewer catalog list;
lint; purity lint; test typecheck; the analytic-relief smoke (all checks); and
the streamed LOD script, before and after the fix.
