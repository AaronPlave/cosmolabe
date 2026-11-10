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
loaded, terrain heights here farther apart than the shadow detail (shadows softened), on, or "Off in Flood lighting"
(`flood` has no Sun).

Catalog: `"terrain": { …, "solarShadows": true }` ([catalog-format.md](catalog-format.md#solarshadows)), default `high`.
Fixture: `apps/viewer/test-catalogs/experiments/moon-terrain-cube-solar-shadow.json`.

Renderer (`UniverseRenderer`): `setTerrainShadowMode('off' | 'low' | 'medium' | 'high' | null)`, `terrainShadowSummary()`,
`terrainShadowStatus(body)`, `setTerrainShadowDebug(mode)`. Debug views: `1` Sun fraction (white lit, black shadowed);
`2` the same with terrain no level holds tinted magenta (a fragment is tinted only where such terrain could change its
answer: one already fully shadowed by known terrain is not), and answers the source spacing cannot decide tinted orange. Views 1 and 2 show the fraction on every
fragment, including slopes facing away from the Sun, which the lit image leaves dark whatever the fraction; `3` frame/data alignment (green: drawn surface within 10 m of the
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
   one anchor frame, so the sphere is exact at any range. The **focus** is the ground under the camera, moved toward what
   it looks at (the orbit target when that is a surface point, else where the view ray meets the body) by at most four
   camera altitudes: an orbit view keeps its target at the centre, and an orbit target left on the far horizon (or
   inside the body) cannot pull the fine levels off the terrain in front of the camera. **Every level is centred on one
   terrain point, the site**, so a ground point's level (and so its shadow) depends only on its distance from the site,
   never on where the camera is. The site is the focus when it was set, and moves to the focus only when the focus is
   more than four camera altitudes above the terrain under it (and 4 km) from it: an orbit or pan keeps it, a view moved
   well away or zoomed low elsewhere gets fine levels again (`siteMoves` counts them). A move changes the answer of
   points whose level changes, so it is **never swapped in at once**: what was drawn (the horizon maps, copied into one
   atlas, at their old centres) keeps drawing until every level is rebuilt and re-rendered at the new site, then
   cross-fades into it over 0.8 s (`SITE_FADE_MS`; vehicles fade the same way). Levels re-centre in whole texels. A re-centre **keeps every known texel it shares with the
   current square** (the same anchor grid, so the same samples) and samples only the newly exposed strip (~24 % of the
   level), a few ms per frame; the current data keep drawing meanwhile, and the swap changes nothing in the overlap.
   Newly resident source tiles refill only the unknown texels. The anchor resets only after the focus moves 10° (the
   gnomonic texel then stretches by 3 %).
2. **One consistent source level per clipmap level.** Texels come from the cube-sphere CPU grids at one product level (the
   coarsest whose cell is no wider than the texel), never a mix of resident LODs, whose seams would be walls at a low Sun.
   Other sources go through `ClipmapSource` (`clipmapSourceFromSurface` adapts any `PhysicalSurface`, incl. meshes).
   **Shadows only as sharp as the source spacing supports.** Each texel also stores the product's finest spacing there,
   `c`. Between samples the relief is interpolated, not known: two points `t` apart may differ by about
   `SLOPE_UNCERTAINTY · min(t, c)` more than the samples say (0.05, a typical lunar slope at the km scale: the one
   calibration knob). The march widens the Sun's disk at each step by that angle, `0.05 · min(1, c / t)` (combining the
   receiver's and the occluder's spacing), so a 6.8 km product casts and receives soft shadows of its large forms, not
   projections of its triangles; a well-resolved ridge still shades coarse ground beyond it, sharply where it is far;
   and 10–50 m polar data are unchanged (the widening there is a few metres). Nothing is switched off by spacing, so
   there is no band where a product level changes, only a change in edge softness. Where that uncertainty could change
   the answer (it exceeds the Sun's radius at a step that could hide part of the Sun) debug view 2 tints the fragment
   orange: approximate, not a determined visibility. Unknown (missing) terrain stays magenta and is drawn lit.
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
(Apple M4 Max, Metal, vsync off), same pose and epoch per mode. The script regenerates every view and mode below; the
PR keeps one still set per behaviour. This catalog drapes no photo imagery, so `on` and `neutral` show computed lighting
only. The ephemeris is the catalog's Keplerian fallback, so the geometry is consistent but the dates are not real.

| View | Sun at site | Source spacing | Kept |
| --- | --- | --- | --- |
| Shackleton rim (89.67°S) | 0.74°, az 21.7° | 10–50 m | [off](validation/terrain-solar-shadow/shackleton-rim-off-gpu.png), [on](validation/terrain-solar-shadow/shackleton-rim-on-gpu.png), [Sun fraction](validation/terrain-solar-shadow/shackleton-rim-visibility-gpu.png), [neutral](validation/terrain-solar-shadow/shackleton-rim-neutral-gpu.png) |
| Polar ridge field (88.4°S) | 1.80°, az 4.0° | ≤ 0.2 km | (script `--views polar-ridge`) |
| Polar outer ring (85.8°S), from 30 km | 3.01°, az 313° | 0.85 km; foreground 1.7 km | (`--views polar-coarse`) |
| Harkhebi J/H (38°N), from 90 km | 4.14°, az 267° | 6.8 km: soft, approximate | [off](validation/terrain-solar-shadow/harkhebi-off-gpu.png), [on](validation/terrain-solar-shadow/harkhebi-on-gpu.png), [unknown / approximate](validation/terrain-solar-shadow/harkhebi-unknown-gpu.png) |
| Equatorial crater (9.6°N) | 2.86°, az 91° | 6.8 km: soft, approximate | (`--views equatorial-crater`) |

**Coarse terrain (Harkhebi).** The review's low-resolution screenshot showed hard polygonal shadows where the imagery is
smooth. Each candidate was isolated at that pose: a finer clipmap (0.5 → 0.19 km texels around the focus) changed
nothing visible, and nor did marching per pixel along shadow edges. The cause is the source: the demo product's heights
there are 6.8 km apart (global level 3), so the shadows were projections of 6.8 km triangles, while the WAC/normal-map
shading drawn over them is ~100 m. That terrain was then left out (drawn lit) above a 1 km spacing, which made a
lighting edge wherever the product changed level. Now (step 2) it casts and receives shadows only as sharp as its
spacing supports: Harkhebi's craters keep their large shadows with soft edges and no triangles, and debug view 2 marks
them approximate (orange).

**Time, camera fixed** (`--sequence time,fast`): 2 min and 24 min (1 day/s at 60 fps) per frame. The frame-to-frame
change max / median is 1.15–1.27 and 1.24–1.88 over the three polar views: the edges advance evenly, with no pops.

**Camera navigation at a fixed epoch** (`scripts/check-terrain-shadow-camera.mjs`; [camera/](validation/terrain-solar-shadow/camera/)). The review's
screen recording: MoonFall Shackleton (WAC+NAC), 2028-12-27 18:15:07 UTC, Moon tracked, shadows High. `--path drag
--view-url <the shared link>` restores that view and orbits it with real mouse drags through the viewer's own controls
(81 frames, 15 px each: right, left past the start, back, up, down), recorded four times: Off | On / Sun fraction |
unknown ([drag.mp4](validation/terrain-solar-shadow/camera/drag.mp4)). 80 ground points are pinned 3–30 km from Shackleton; each frame logs the level holding
each point, the CPU march from it, its pixels and resident source tile, the level centres, rebuild reasons and source
revision ([drag.json](validation/terrain-solar-shadow/camera/drag.json)). The Sun is 0.28° up at Shackleton: about one solar radius.

- **Terrain shadows are a small part of what changes.** Per frame, On and Off differ on 0.4–6.5 % of pixels (by more
  than 24 of 255); with shadows Off the image itself changes on 5–18 % of pixels per frame as the view moves. The large
  dark regions that come and go in the recording are mostly the view, the drawn LOD and the WAC+NAC's own shading.
- **Fixed: the shadow at a fixed point depended on where the camera was.** At an elevation of one solar radius a
  point's visible fraction depends on tens of metres of relief kilometres away, so the data resolution of its level
  decides it. The levels used to follow the focus (in this mode the controls orbit a pivot deep inside the Moon, so the
  focus travelled up to 55 km), points changed level, and their answer changed: one point 12 km from Shackleton read 0
  at level 0 (62 m), 0.10 at level 1 (0.19 km) and 1 at level 2 (0.62 km), and flipped 0 ↔ 1 ten times in the drag.
  Now every level is centred on the site (step 1). In the same drag the site never moves: each of the 80 points stays
  on one level, and its CPU fraction is constant (that point: level 1, 0.12, every frame); no level re-centres (one
  rebuild: the outer level's data finishing loading; before: 110 rebuilds and 404 horizon renders); every frame draws
  complete levels (before: 25 of 81). The hoppers' terrain Sun visibility (Polaris-A 0, B 1, C 0) is the same in every frame.
- **Same camera, only the clipmap focus moved** ([Sun fraction: own focus | 50 km | 150 km](validation/terrain-solar-shadow/camera/focus-moved-same-camera.png)):
  10, 25 and 50 km leave the site, every pinned point's level and fraction, and the image unchanged (0 pixels);
  150 km (beyond four altitudes) moves the site, and once faded in the image differs as levels change (13 % of
  Sun-fraction pixels, 1.4 % of the lit image); returning restores it exactly. The hoppers do not change.
- **Remaining pixel changes are not the shadow data.** 31 changes of a pinned point's pixel by more than a quarter
  remain, at constant level and CPU fraction: 9 change the Off image as much (labels, trails, the drawn LOD), the rest
  are points at a shadow edge, where the drawn mesh's LOD moves which ground the pixel shows by up to a few hundred
  metres.
- **Site moves fade instead of popping** (`--path site [--no-fade]`; [site-move.mp4](validation/terrain-solar-shadow/camera/site-move.mp4): Sun fraction, without | with
  the fade; series in [site-boundary.json](validation/terrain-solar-shadow/camera/site-boundary.json)). 2.5 km above Shackleton's sunward rim, the camera jumps 1.5 km at a
  time toward the Sun and holds still for 15 frames after each jump; it moves the site three times. Any change while
  the camera holds still is the shadow's own. Without the fade, a move changes up to 2.5 % of the Sun-fraction view's
  pixels in one frame; with it, no held frame changes more than 0.04 %. At this Sun (0.28°) the lit image changes on
  no held frame in either case: there is too little direct light for the level change to show.
- **No lighting edge where the source gets coarser** (`--path boundary`; [boundary.mp4](validation/terrain-solar-shadow/camera/boundary.mp4): lit and Sun fraction,
  previous | this revision; [still](validation/terrain-solar-shadow/camera/boundary-before-after.png) with debug view 2). 40 km up at 115°E, the view moves 90 km from
  84.5°S to 80.5°S across the product's 0.85 → 1.7 km change, while the clock runs 5 min per frame (Sun ~2° up).
  Before, the 1.7 km side had no terrain shadows: a hard edge, with Idel'son crater drawn lit (magenta in view 2).
  Now its shadows continue, softer, marked approximate (orange). Frame-to-frame change, max / median: Sun fraction 1.19
  (before 1.49), lit 2.15 (Off 2.20): no frame stands out.
- **Fixed: re-centres swapped in terrain still loading.** A re-centred level used to swap in at once, with its new
  strip unknown until the source tiles arrived; unknown is drawn lit, so shadows there vanished and came back as the
  camera moved. A re-centred level now keeps its current, complete data until the strip's tiles load (at most 2 s).
  It still applies when the site moves.
- **Fixed: a far orbit target pulled the clipmap away** (see step 1): [before / after](validation/terrain-solar-shadow/camera/far-orbit-target-before-after.png),
  level-0 too-coarse 100 % → 0 % in a view across Shackleton.
- **Fixed: debug views 1–2 changed with the camera** while the lit image did not (back-facing slopes drawn white; marches
  flagged after known terrain had already hidden the Sun). They now show the fraction everywhere and flag only answers
  unknown terrain could change.
- **Scripted paths, earlier epoch** (`--path` default and `user`): zoom past the 320 km cut-off and back, a full orbit
  and grazing views about a surface target leave the image identical on return (0.00 % of pixels) and every pinned
  point's fraction unchanged: an orbit about a surface point keeps the clipmap still.

**Real playback** (`--playback`, `--playback-video`). The clock runs at 1 day/s for 290 frames with the camera held in
the body frame; each frame records every level's `horizonSunLagDeg`. Then seeks of ±1 h to 5 days. Real-time recording,
Sun fraction | on: [Shackleton](validation/terrain-solar-shadow/shackleton-rim-playback.mp4).

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
[off](validation/terrain-solar-shadow/shackleton-rim-off-gpu-wac-nac.png), [on](validation/terrain-solar-shadow/shackleton-rim-on-gpu-wac-nac.png) (neutral and Sun-fraction
views: `--modes`).

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
difference 0.09 (two penumbra samples, where the source-spacing widening applies), all others 0. Each sample is read
once any site fade has finished: during one a vehicle blends from the old site's answer as the terrain does. Before this change a hopper in a terrain shadow was fully sunlit.
Polaris-C on 2028-12-15, shadows off / on:
[landed off](validation/terrain-solar-shadow/vehicles/Polaris-C-2028-12-15-landed-off.png), [landed on](validation/terrain-solar-shadow/vehicles/Polaris-C-2028-12-15-landed-on.png),
[flying off](validation/terrain-solar-shadow/vehicles/Polaris-C-2028-12-15-flying-off.png), [flying on](validation/terrain-solar-shadow/vehicles/Polaris-C-2028-12-15-flying-on.png);
per-hop results in `vehicles/vehicles.json` (the per-sample series is regenerated by the script).

## Cost

Mean frame time on the hardware GPU (Apple M4 Max, Metal, vsync and frame limit off), same poses and epochs. Off → on is
steady state. "Horizon pass" re-renders two levels every frame (`on-rehorizon`, the per-frame budget), which is the cost
while the Sun moves fast; at 1× it re-renders about once every 2 minutes on the Moon.

| View | 1280×720 off → on | Horizon pass | 3840×2160 off → on (previous revision) | Horizon pass (previous revision) |
| --- | --- | --- | --- | --- |
| Shackleton rim | 1.3 → 1.3 ms | 5.3 ms | 2.4 → 3.2 ms | 8.2 ms |
| Polar ridge | 1.2 → 1.2 ms | 5.1 ms | 1.4 → 1.6 ms | 6.9 ms |
| Polar outer ring | 1.3 → 1.3 ms | 4.5 ms | 1.9 → 2.2 ms | 5.4 ms |

- **Steady state** costs 0–0.8 ms even at 4K: the per-pixel part is a level lookup and one filtered fetch.
- **Horizon pass**: one level, 256² texels, about 1–3 ms on this GPU (the source-spacing widening adds one square root
  per step; this revision measures 4.5–5.3 ms mean for two levels per frame at 1280×720, as before), at most two levels per frame (all after a seek),
  only when the data or the Sun changed. It does not grow with screen resolution. `medium` and `low` take one-texel
  steps instead of 0.75; `low` stops after 420 steps, which still reaches the outer level.
- **Vehicles**: one CPU march per vehicle per frame (a few hundred bilinear taps).
- **CPU fill**: a re-centre samples the newly exposed strip; an initial level 64k texels at 20–110 ms, spread over
  frames at `budgetMs` (3 ms). Orbiting and panning no longer re-centre anything (the review's drag: 0 rebuilds and 0
  horizon renders, from 110 and 404); only a site move does.
- **Memory**: four RGBA32F height levels (height, validity, source spacing: 4 MB), four RGBA16F horizon maps (2 MB)
  and, after the first site move, one 512² RGBA16F atlas of the previous maps (2 MB). A site move adds four small copy
  draws once, and the terrain fragments read the atlas only during its 0.8 s fade. No draw calls are added otherwise.

There is no phone or integrated-GPU measurement. The open question there is the horizon pass, likely 5–20× slower than on
an M4 Max; `low`, smaller levels (`size: 128`) and the per-frame budget are the levers. The default stays off until that
is measured.

## Limits

- **Visual only.** No PSR certification, illumination duration or power products.
- **Resolution.** A receiver's shadow is interpolated between texel centres of its level: 62 m within 8 km of the site,
  0.19 km to 24 km, 0.62 km to 80 km, 2.5 km beyond. Occluders are seen at their level's resolution, so a ridge narrower than a texel there
  is under-represented. The 62 m inner level resolves what LOLA 118 m (10 m polar) can show. With the Sun within about
  a degree of the horizon small relief decides the fraction, so a point's answer is that of its level's resolution: the
  same however the camera moves, but it changes when the site moves (see "Camera navigation").
- **Range.** Terrain beyond the outer level (default 320 km) is unknown. The default covers a 1° Sun and 10 km relief.
- **Streaming.** Until fine source tiles arrive, the coarser level answers, and the shadow sharpens when they do. Terrain
  no level holds is drawn lit.
- **Time warp.** At 1 day/s each level's map lags the Sun by at most two frames (measured max 0.16–0.35° on the M4 Max;
  about 0.4° at 60 fps), costing 4.8–6.1 ms p50 / 8.5–12 ms p95 per frame against 1.1–1.4 ms off. After a seek, 0.
- **Coarse source terrain.** Shadows on and from terrain whose heights are kilometres apart are soft and approximate
  (debug view 2: orange): they show what the spacing supports, not a determined visibility. The softening uses one
  typical slope (0.05) for every terrain; rougher terrain would warrant more.
- **Vehicles** are lit or shadowed as a whole from one point, and the factor dims their ambient light too (as eclipses do).
- **Baked imagery** (see above). Imagery declared `baked` shows no terrain shadows, and the viewer says so.
- **Quantized-mesh terrain** mixes LODs in its CPU samples. Cube-sphere terrain is the supported low-Sun path.
- **Overhangs.** A radial height field cannot represent overhangs. `clipmapSourceFromSurface` keeps the highest surface.

## Acceptance

| Issue requirement | Where |
| --- | --- |
| Synthetic ridge with known occlusion; sweeps move the edge predictably | CPU test + WebGL parity, 2 azimuths × 5 elevations, 3 presets, 2 filter paths |
| Shackleton-like rim/floor, equatorial Moon, representative Mars | Real Moon captures (equatorial terrain in the demo product is 6.8 km apart: soft, approximate shadows, labelled); Mars synthetic only (no Mars terrain product locally) |
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
