# Terrain-cast solar shadows and horizon occlusion (#205)

**Status: implemented, opt-in, visual only.** A ridge, crater wall or massif that blocks the Sun from a point on
streamed terrain shades that point, from the actual Sun direction and epoch, including terrain beyond the screen and
across tile and LOD boundaries. It is not a certified illumination, permanently-shadowed-region or solar-power product.

Builds on #204 ([surface-illumination.md](surface-illumination.md): Sun direction at the receiver, the direct term this
attenuates, imagery provenance). Not in scope: #182 hillshade, #134 scattering, #242 camera→Sun-disk visibility, #217
numeric site→target geometry.

## Use it

**Viewer: Display panel → Terrain shadows → Off / Low / Medium / High.** It appears whenever a loaded body has terrain
with heights a shadow can be built from (cube-sphere grids, quantized mesh), and works on any such terrain with no
catalog change. It follows the catalog until you choose (Off, unless the catalog sets `solarShadows`), then remembers
your choice. A line under it says what is happening: building (only until every level has data), some terrain not
loaded, terrain here too coarse to cast shadows, on, or "Off in Flood lighting" (`flood` has no Sun).

Catalog: `"terrain": { …, "solarShadows": true }` ([catalog-format.md](catalog-format.md#solarshadows)), default `high`.
Fixture: `apps/viewer/test-catalogs/experiments/moon-terrain-cube-solar-shadow.json`.

Renderer (`UniverseRenderer`): `setTerrainShadowMode('off' | 'low' | 'medium' | 'high' | null)`, `terrainShadowSummary()`,
`terrainShadowStatus(body)`, `setTerrainShadowDebug(mode)`. Debug views: `1` Sun fraction (white lit, black shadowed);
`2` the same with terrain no level holds, or too coarse to cast shadows, tinted magenta; `3` frame/data alignment (green: drawn surface within 10 m of the
clipmap); `4` **neutral grey albedo** lit by the Sun with terrain shadows (no imagery, no baked light); `5` the same
without terrain shadows; `6` the normal image with shadows bypassed while the clipmap keeps updating (A/B "off").

What it touches: the **direct** diffuse/specular term of relit surfaces (`reflectance` and `unknown` imagery), and the
light on **vehicles** (any body with a model whose parent has terrain shadows: landed or flying, see step 6). Ambient
and eclipse terms on terrain are untouched. A vehicle's own shadow on the ground keeps its shadow map.

## How it works

**A height clipmap filled from source terrain, a horizon map per clipmap texel computed on the GPU, and one filtered
fetch per terrain fragment.** Not a shadow map, and no per-pixel ray march.

1. **Clipmap** (`SolarShadowClipmap.ts`). Up to four nested squares (default 8 / 24 / 80 / 320 km half-width at 256²:
   62 m / 0.19 km / 0.62 km / 2.5 km texels), each holding the terrain's radius minus the anchor radius in a **gnomonic** projection about
   one anchor frame, so the sphere is exact at any range. Levels re-centre on the orbit target (or camera) in whole
   texels after the focus moves 25 % of their half-width. A re-centre **keeps every known texel it shares with the
   current square** (the same anchor grid, so the same samples) and samples only the newly exposed strip (~24 % of the
   level), a few ms per frame; the current data keep drawing meanwhile, and the swap changes nothing in the overlap.
   Newly resident source tiles refill only the unknown texels. The anchor resets only after the focus moves 10° (the
   gnomonic texel then stretches by 3 %).
2. **One consistent source level per clipmap level.** Texels come from the cube-sphere CPU grids at one product level (the
   coarsest whose cell is no wider than the texel), never a mix of resident LODs, whose seams would be walls at a low Sun.
   Other sources go through `ClipmapSource` (`clipmapSourceFromSurface` adapts any `PhysicalSurface`, incl. meshes).
   **Terrain whose source is coarser than 1 km** (`MAX_SOURCE_CELL_KM`; the product's finest spacing there) is left out:
   it neither casts nor receives terrain shadows and is drawn lit, shaded by slope, and flagged like unknown terrain.
   Its shadows would be projections of its triangles (see "Coarse terrain" below).
3. **Horizon pass** (`renderHorizons`, `ssMarch`). For each texel centre, on the GPU: march toward the Sun and keep the
   largest angle by which terrain stands above the Sun ray. Each tap reads the finest level holding terrain there,
   **bilinearly at that level's own resolution**, and the next step is 0.75 of that level's texel (`high`): the march
   reads every texel it crosses and sees a ridge exactly as the data have it. Levels cross-fade over the outer 20 % of a
   level, and the receiver stands on that same cross-faded surface. The march ends when the Sun's **lower limb** clears
   the highest terrain (terrain just under the ray still hides part of the disk), or at the outer level's edge.
4. **Terrain shader** (`injectSolarShadowIntoShader`). The fragment's horizon angle is the bilinear horizon map of the
   finest level holding it (cross-faded the same way), converted to the visible fraction of the Sun's disk (linear across
   its diameter, so edges move continuously with time). That is one filtered fetch per fragment.
5. **When it re-renders.** A level whose own data or placement changed re-renders that frame (its map must match its
   texels). Others are stale when the Sun has moved more than 1/16 of its radius since their map (an edge 30 km from its
   ridge moves 9 m) or another level's data changed. Up to two stale levels re-render per frame, the Sun-stalest first,
   so under fast playback each level re-renders every other frame and none starves (the earlier "first stale level"
   rule let the finest level starve the coarser ones). After a seek (Sun > 1° from a map) every level re-renders at
   once. With a paused or 1× clock and a still camera, nothing re-renders.
6. **Vehicles** (`sunFractionAt`). Each frame, for every body with a model whose parent has terrain shadows, the CPU runs
   the same march from the vehicle's own position (any altitude; from the clipmap surface if the point is below it)
   through the same clipmap data, and scales the vehicle's light by the visible fraction of the Sun's disk, through the
   eclipse term models already have. One point per vehicle: a vehicle is lit or shadowed as a whole.

**Why this shape, after review.** The first version marched per fragment with max-reduced mips and per-pixel jitter. That
had three problems. It was **stippled**, because the jitter keyed to `gl_FragCoord` made it shimmer in screen space. It
was **expensive**, at 3 ms per megapixel. And the conservative max-mips **dilated rough terrain**, more where the data were
finer, so the 8 km level's box acted as a raised plateau and cast straight shadow bars from its edges after a re-centre.
Marching per *texel* moves the cost off the screen, so the march can afford native resolution with plain bilinear taps:
there is no dilation and nothing to jitter. The shadow is a texture on the terrain, so camera motion cannot change it.

**Unknown is never authoritative.** Where a level is still waiting for source tiles (a strip just exposed by a
re-centre), the next coarser level answers, so the shadow there sharpens when the data arrive instead of popping from lit
to shadowed. Terrain that **no** level holds is drawn lit (the #204 term) and flagged: debug view `2` tints it, and
`terrainShadowStatus` reports each level's `unknownFraction`. While any level has unknown texels a ray is not called
clear until it rises above `unknownReliefKm` (default 10 km).

**Diagnostics** (`terrainShadowStatus(body)`): per level `offsetKm`, `builds`, `lastReason` (`initial` / `recenter` /
`new-data`), `lastSampledTexels`, `unknownFraction`, `coarseFraction`, `lastBuildMs`, `horizonSunLagDeg` (the Sun its
horizon map was rendered for vs the current Sun); plus `anchorResets` and `horizonRenders`.

## Evidence

**CPU ground truth** (`TerrainSunVisibility.ts`, vitest): the horizon march agrees with an independently derived analytic
ray for a synthetic ridge from 0.5° to 8° Sun elevation; unknown coverage is never lit or shadowed. Required coverage
(`occluderRangeKm`): Moon 1° / 10 km relief → 158 km, Mars → 208 km; the default 320 km outer level covers both.
`sunFractionAt` (vehicles) is checked against a synthetic ridge: shadowed behind it, lit above its shadow and beyond it.

**The real shader against the CPU reference** (`npm run test:terrain-shadow:webgl`, real WebGL, SwiftShader). A synthetic
2 km-wide, 1.5 km-high ridge with vertical walls in a realistic scene (scale 1e-6, rotated and offset body,
camera-relative geometry), 1930 receivers per body, Sun 1.5–12° at azimuths 90°/125°, each receiver compared at its own
horizon.

| | Moon | Mars |
| --- | --- | --- |
| Frame/data alignment (view 3 green) | 791 / 800 px | 791 / 800 px |
| Mean \|GPU − reference\| (Sun fraction), `high` | 0.005 | 0.005 |
| `medium` / `low` | 0.006 / 0.006 | 0.006 / 0.006 |
| Hand-filtered path (no float-linear) | 0.005 | 0.005 |
| Light leaks / false shadow beyond the edge tolerance (every preset) | 0 / 0 | 0 / 0 |
| Largest shadow-edge shift (0.4 km measurement grain), `high` | 0.4 km | 0.4 km |

The first version scored 0.019 / 0.024, with 2 km edge shifts and 6–13 km edge shifts for `medium`/`low`. Edge
tolerance is `max(1 km, 12 % of the distance)` plus one texel of the level whose horizon map holds the receiver. The
clipmap holds the ridge's vertical walls as one-texel slopes, and horizons are interpolated between texel centres. With
the source ending before the ridge, the receiver is lit (1.0) and tinted in view `2`, not black.

**Real terrain**, hardware GPU. The #149 fused LOLA cube-sphere Moon, `scripts/capture-terrain-solar-shadow.mjs --gpu`
(Apple M4 Max, Metal, vsync off), same pose and epoch per mode. Files are in
[validation/terrain-solar-shadow/](validation/terrain-solar-shadow/) (`*-gpu.png`, raw JSON in `captures-gpu*.json`).
This catalog drapes no photo imagery, so `on` and `neutral` show computed lighting only. The ephemeris is the catalog's
Keplerian fallback, so the geometry is consistent but the calendar dates are not real.

| View | Sun at site | off | on | Sun fraction | neutral, no shadows | neutral, shadows | unknown / too coarse | Source spacing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shackleton rim (89.67°S) | 0.74°, az 21.7° | [img](validation/terrain-solar-shadow/shackleton-rim-off-gpu.png) | [img](validation/terrain-solar-shadow/shackleton-rim-on-gpu.png) | [img](validation/terrain-solar-shadow/shackleton-rim-visibility-gpu.png) | [img](validation/terrain-solar-shadow/shackleton-rim-neutral-off-gpu.png) | [img](validation/terrain-solar-shadow/shackleton-rim-neutral-gpu.png) | [img](validation/terrain-solar-shadow/shackleton-rim-unknown-gpu.png) | 10–50 m |
| Polar ridge field (88.4°S) | 1.80°, az 4.0° | [img](validation/terrain-solar-shadow/polar-ridge-off-gpu.png) | [img](validation/terrain-solar-shadow/polar-ridge-on-gpu.png) | [img](validation/terrain-solar-shadow/polar-ridge-visibility-gpu.png) | [img](validation/terrain-solar-shadow/polar-ridge-neutral-off-gpu.png) | [img](validation/terrain-solar-shadow/polar-ridge-neutral-gpu.png) | [img](validation/terrain-solar-shadow/polar-ridge-unknown-gpu.png) | ≤ 0.2 km |
| Polar outer ring (85.8°S), from 30 km | 3.01°, az 313° | [img](validation/terrain-solar-shadow/polar-coarse-off-gpu.png) | [img](validation/terrain-solar-shadow/polar-coarse-on-gpu.png) | [img](validation/terrain-solar-shadow/polar-coarse-visibility-gpu.png) | [img](validation/terrain-solar-shadow/polar-coarse-neutral-off-gpu.png) | [img](validation/terrain-solar-shadow/polar-coarse-neutral-gpu.png) | [img](validation/terrain-solar-shadow/polar-coarse-unknown-gpu.png) | 0.85 km; foreground 1.7 km (left out) |
| Harkhebi J/H (38°N), from 90 km | 4.14°, az 267° | [img](validation/terrain-solar-shadow/harkhebi-off-gpu.png) | [img](validation/terrain-solar-shadow/harkhebi-on-gpu.png) | [img](validation/terrain-solar-shadow/harkhebi-visibility-gpu.png) | [img](validation/terrain-solar-shadow/harkhebi-neutral-off-gpu.png) | [img](validation/terrain-solar-shadow/harkhebi-neutral-gpu.png) | [img](validation/terrain-solar-shadow/harkhebi-unknown-gpu.png) | 6.8 km: left out |
| Equatorial crater (9.6°N) | 2.86°, az 91° | [img](validation/terrain-solar-shadow/equatorial-crater-off-gpu.png) | [img](validation/terrain-solar-shadow/equatorial-crater-on-gpu.png) | [img](validation/terrain-solar-shadow/equatorial-crater-visibility-gpu.png) | [img](validation/terrain-solar-shadow/equatorial-crater-neutral-off-gpu.png) | [img](validation/terrain-solar-shadow/equatorial-crater-neutral-gpu.png) | [img](validation/terrain-solar-shadow/equatorial-crater-unknown-gpu.png) | 6.8 km: left out |

**Coarse terrain (Harkhebi).** The review's low-resolution screenshot showed hard polygonal shadows where the imagery is
smooth. Each candidate was isolated at that pose: a finer clipmap (0.5 → 0.19 km texels around the focus) changed
nothing visible, and nor did marching per pixel along shadow edges. The cause is the source: the demo product's heights
there are 6.8 km apart (global level 3), so the shadows were projections of 6.8 km triangles, while the WAC/normal-map
shading drawn over them is ~100 m. Such terrain is now left out (step 2) rather than blurred. The 0.85 km polar ring
(`polar-coarse`) is the coarsest that still casts shadows; its edges show facets of that size from 30 km up.

**Motion stability** (`--sequence`). Each frame is captured at one pose as off (view 6) | Sun fraction | neutral | on, and
assembled as a 2×2 MP4, with a per-frame trace of every level (`captures-gpu-sequences.json`).

- **Camera, time frozen.** The camera pans 20 km, yaws 12° and zooms in, then returns along the same path.
- **Time, camera fixed.** 2 min per frame. **Fast**: 24 min per frame (1 day/s at 60 fps), each frame settled.

| View | Camera: first vs last frame (mean diff / pixels > 8 of 255) | Time: change max / median | Fast: max / median |
| --- | --- | --- | --- |
| Shackleton rim ([camera](validation/terrain-solar-shadow/shackleton-rim-camera.mp4), [time](validation/terrain-solar-shadow/shackleton-rim-time.mp4), [fast](validation/terrain-solar-shadow/shackleton-rim-fast.mp4)) | 0.17 / 0.25 % | 1.18 | 1.62 |
| Polar ridge ([camera](validation/terrain-solar-shadow/polar-ridge-camera.mp4), [time](validation/terrain-solar-shadow/polar-ridge-time.mp4), [fast](validation/terrain-solar-shadow/polar-ridge-fast.mp4)) | 0.07 / 0.07 % | 1.15 | 1.88 |
| Polar outer ring ([camera](validation/terrain-solar-shadow/polar-coarse-camera.mp4), [time](validation/terrain-solar-shadow/polar-coarse-time.mp4), [fast](validation/terrain-solar-shadow/polar-coarse-fast.mp4)) | **identical** | 1.27 | 1.24 |

States seen: `ready` and `partial` only; no anchor reset. The round trips are no longer all pixel-identical: where a
level re-centred during the pan and its hysteresis left it at a different centre on return, the band in which it blends
into the next level sits elsewhere, and the two levels' answers differ slightly there (distant terrain near the horizon
only). A max/median near 1 means the edges advance evenly with time.

**Real playback** (`--playback`, `--playback-video`). The clock runs at 1 day/s for 290 frames with the camera held in
the body frame; each frame records every level's `horizonSunLagDeg`. Then seeks of ±1 h to 5 days. Real-time screen
recordings, Sun fraction | on: [Shackleton](validation/terrain-solar-shadow/shackleton-rim-playback.mp4), [polar ridge](validation/terrain-solar-shadow/polar-ridge-playback.mp4),
[polar outer ring](validation/terrain-solar-shadow/polar-coarse-playback.mp4), [Harkhebi](validation/terrain-solar-shadow/harkhebi-playback.mp4) (no terrain shadows: too coarse).

| View | Frame p50 / p95, off → on | Max horizon lag behind the Sun | After seeks |
| --- | --- | --- | --- |
| Shackleton rim | 2.8 / 3.5 → 8.1 / 25.8 ms (a noisy run; 1.2 / 1.8 → 6.1 / 12 ms in a quiet one) | 0.27° | 0 |
| Polar ridge | 1.1 / 2.2 → 4.8 / 11 ms | 0.20° | 0 |
| Polar outer ring | 1.5 / 2.1 → 4.9 / 8.4 ms | 0.36° | 0 |

Before the scheduling fix the coarser levels could stay on an old Sun indefinitely; re-rendering every level every
frame instead cost 13–15 ms p50 / 32–34 ms p95 at the pole.

### The shipped WAC+NAC scene and baked illumination

`moonfall-shackleton` drapes the LROC WAC + NAC composite. Its pixels contain the illumination of the original images
(the NAC polar mosaics are assembled for uniform lighting, and permanently shadowed floors are black), but the layer
declares no provenance, so it is relit as `unknown`. Same Shackleton pose, `--catalog test-catalogs/moonfall-shackleton
--tag wac-nac`:
[off](validation/terrain-solar-shadow/shackleton-rim-off-gpu-wac-nac.png),
[on](validation/terrain-solar-shadow/shackleton-rim-on-gpu-wac-nac.png),
[neutral, no shadows](validation/terrain-solar-shadow/shackleton-rim-neutral-off-gpu-wac-nac.png),
[neutral, shadows](validation/terrain-solar-shadow/shackleton-rim-neutral-gpu-wac-nac.png),
[Sun fraction](validation/terrain-solar-shadow/shackleton-rim-visibility-gpu-wac-nac.png).

What that scene can honestly support:

- **Supported:** where the Sun is blocked at this epoch. The Sun-fraction and neutral views show it, and they depend only
  on terrain and geometry.
- **Not supported:** the composited image as a picture of the lighting at that epoch. Computed shadows only *darken* the
  direct term, so the photo's baked shadows stay where they were, and the image is the union of baked and computed
  shadows.

We did not declare the layer `baked` (that hides the effect), and we did not swap in the nodata-filled WAC_EMP mosaic.
A relightable albedo product for the pole is the data needed for a trustworthy changing-illumination picture.

**Vehicles** (`scripts/check-terrain-shadow-vehicles.mjs`, `moonfall-shackleton`, High). Every hop of Polaris-A–D, every
10 s: the renderer's Sun fraction for the hopper against an independent CPU march of resident source terrain from its
position. 679 samples, Sun −0.8° to 1.4°, up to 0.31 km above ground, lit and shadowed both landed and flying: max
difference 0.05 (one penumbra sample), all others 0. Before this change a hopper in a terrain shadow was fully sunlit.
Polaris-D on 2028-12-15, landed in shadow then flying into sunlight, shadows off / on:
[landed off](validation/terrain-solar-shadow/vehicles/Polaris-D-2028-12-15-landed-off.png),
[landed on](validation/terrain-solar-shadow/vehicles/Polaris-D-2028-12-15-landed-on.png),
[flying off](validation/terrain-solar-shadow/vehicles/Polaris-D-2028-12-15-flying-off.png),
[flying on](validation/terrain-solar-shadow/vehicles/Polaris-D-2028-12-15-flying-on.png); Polaris-C likewise; all samples
in `vehicles/vehicles.json`.

## Cost

Mean frame time on the hardware GPU (Apple M4 Max, Metal, vsync and frame limit off), same poses and epochs. Off → on is
steady state. "Horizon pass" re-renders two levels every frame (`on-rehorizon`, the per-frame budget), which is the cost
while the Sun moves fast; at 1× it re-renders about once every 2 minutes on the Moon.

| View | 1280×720 off → on | Horizon pass | 3840×2160 off → on | Horizon pass |
| --- | --- | --- | --- | --- |
| Shackleton rim | 1.8 → 1.6 ms | 7.3 ms | 2.4 → 3.2 ms | 8.2 ms |
| Polar ridge | 1.3 → 1.3 ms | 5.7 ms | 1.4 → 1.6 ms | 6.9 ms |
| Polar outer ring | 1.2 → 1.3 ms | 4.9 ms | 1.9 → 2.2 ms | 5.4 ms |

- **Steady state** costs 0–0.8 ms even at 4K: the per-pixel part is a level lookup and one filtered fetch.
- **Horizon pass**: one level, 256² texels, about 1–3 ms on this GPU, at most two levels per frame (all after a seek),
  only when the data or the Sun changed. It does not grow with screen resolution. `medium` and `low` take one-texel
  steps instead of 0.75; `low` stops after 420 steps, which still reaches the outer level.
- **Vehicles**: one CPU march per vehicle per frame (a few hundred bilinear taps).
- **CPU fill**: a re-centre samples the newly exposed strip; an initial level 64k texels at 20–110 ms, spread over
  frames at `budgetMs` (3 ms).
- **Memory**: four RG32F height levels (2 MB) and four RGBA16F horizon maps (2 MB). No draw calls are added.

There is no phone or integrated-GPU measurement. The open question there is the horizon pass, likely 5–20× slower than on
an M4 Max; `low`, smaller levels (`size: 128`) and the per-frame budget are the levers. The default stays off until that
is measured.

## Limits

- **Visual only.** No PSR certification, illumination duration or power products.
- **Resolution.** A receiver's shadow is interpolated between texel centres of its level: 62 m within 8 km of the focus,
  0.19 km to 24 km, 0.62 km to 80 km, 2.5 km beyond. Occluders are seen at their level's resolution, so a ridge narrower than a texel there
  is under-represented. The 62 m inner level resolves what LOLA 118 m (10 m polar) can show.
- **Range.** Terrain beyond the outer level (default 320 km) is unknown. The default covers a 1° Sun and 10 km relief.
- **Streaming.** Until fine source tiles arrive, the coarser level answers, and the shadow sharpens when they do. Terrain
  no level holds is drawn lit.
- **Time warp.** At 1 day/s each level's map lags the Sun by at most two frames (measured max 0.16–0.35° on the M4 Max;
  about 0.4° at 60 fps), costing 4.8–6.1 ms p50 / 8.5–12 ms p95 per frame against 1.1–1.4 ms off. After a seek, 0.
- **Coarse source terrain.** Terrain whose finest source spacing is over 1 km casts and receives no terrain shadows (the
  demo Moon product outside its polar and regional detail is 6.8 km apart; its shadows were projections of those
  triangles). Within the limit, shadows show facets up to the source spacing.
- **Vehicles** are lit or shadowed as a whole from one point, and the factor dims their ambient light too (as eclipses do).
- **Baked imagery** (see above). Imagery declared `baked` shows no terrain shadows, and the viewer says so.
- **Quantized-mesh terrain** mixes LODs in its CPU samples. Cube-sphere terrain is the supported low-Sun path.
- **Overhangs.** A radial height field cannot represent overhangs. `clipmapSourceFromSurface` keeps the highest surface.

## Acceptance

| Issue requirement | Where |
| --- | --- |
| Synthetic ridge with known occlusion; sweeps move the edge predictably | CPU test + WebGL parity, 2 azimuths × 5 elevations, 3 presets, 2 filter paths |
| Shackleton-like rim/floor, equatorial Moon, representative Mars | Real Moon captures (equatorial terrain in the demo product is too coarse and is left out, labelled); Mars synthetic only (no Mars terrain product locally) |
| Vehicles shadowed by terrain, landed and flying | `sunFractionAt`; MoonFall hop check against the CPU reference |
| Tracks the Sun under fast playback and seeks | Fair horizon scheduling; measured lag ≤ 0.36° at 1 day/s, 0 after seeks |
| Offscreen / adjacent-tile occluders within a documented radius | `occluderRangeKm`; outer level 320 km |
| No toggling across LOD; no acne/peter-panning; stable under motion | One source level per clipmap level; receiver on the same surface; round-trip-identical camera sequences; even time sequences |
| Neutral-albedo isolation and honest treatment of baked imagery | Debug views 4/5; WAC+NAC section |
| No regression: spacecraft shadows, eclipses, imagery overlays | Opt-in; direct term only; existing suites pass |
| Desktop cost | Hardware-GPU table at 720p and 4K, steady, horizon pass and 1 day/s playback |

## Next

1. **Phone / integrated-GPU run** of the horizon pass, then a per-device default `quality` / level `size`.
2. **Relightable polar albedo** so the shipped Shackleton scene can show changing illumination honestly.
3. **Numeric visibility query (#217)**: the same clipmap answers "is the Sun above the local horizon at this site";
   `solarVisibility` in `TerrainSunVisibility.ts` is that function over a height source. A separate issue.
