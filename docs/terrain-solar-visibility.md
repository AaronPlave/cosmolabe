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
loaded, on, or "Off in Flood lighting" (`flood` has no Sun).

Catalog: `"terrain": { …, "solarShadows": true }` ([catalog-format.md](catalog-format.md#solarshadows)), default `high`.
Fixture: `apps/viewer/test-catalogs/experiments/moon-terrain-cube-solar-shadow.json`.

Renderer (`UniverseRenderer`): `setTerrainShadowMode('off' | 'low' | 'medium' | 'high' | null)`, `terrainShadowSummary()`,
`terrainShadowStatus(body)`, `setTerrainShadowDebug(mode)`. Debug views: `1` Sun fraction (white lit, black shadowed);
`2` the same with terrain no level holds tinted magenta; `3` frame/data alignment (green: drawn surface within 10 m of the
clipmap); `4` **neutral grey albedo** lit by the Sun with terrain shadows (no imagery, no baked light); `5` the same
without terrain shadows; `6` the normal image with shadows bypassed while the clipmap keeps updating (A/B "off").

What it touches: only the **direct** diffuse/specular term of relit surfaces (`reflectance` and `unknown` imagery).
Ambient and eclipse terms are untouched. Spacecraft/lander shadows keep their own shadow map.

## How it works

**A height clipmap filled from source terrain, a horizon map per clipmap texel computed on the GPU, and one filtered
fetch per terrain fragment.** Not a shadow map, and no per-pixel ray march.

1. **Clipmap** (`SolarShadowClipmap.ts`). Up to three nested squares (default 8 / 64 / 320 km half-width at 256²: 62 m /
   0.5 km / 2.5 km texels), each holding the terrain's radius minus the anchor radius in a **gnomonic** projection about
   one anchor frame, so the sphere is exact at any range. Levels re-centre on the orbit target (or camera) in whole
   texels after the focus moves 25 % of their half-width. A re-centre **keeps every known texel it shares with the
   current square** (the same anchor grid, so the same samples) and samples only the newly exposed strip (~24 % of the
   level), a few ms per frame; the current data keep drawing meanwhile, and the swap changes nothing in the overlap.
   Newly resident source tiles refill only the unknown texels. The anchor resets only after the focus moves 10° (the
   gnomonic texel then stretches by 3 %).
2. **One consistent source level per clipmap level.** Texels come from the cube-sphere CPU grids at one product level (the
   coarsest whose cell is no wider than the texel), never a mix of resident LODs, whose seams would be walls at a low Sun.
   Other sources go through `ClipmapSource` (`clipmapSourceFromSurface` adapts any `PhysicalSurface`, incl. meshes).
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
   texels). Otherwise, at most one stale level per frame (finest first) re-renders when any level's data or the quality
   changed or the Sun moved by more than 1/16 of its radius, which moves an edge 30 km from its ridge by 9 m. With a
   paused or 1× clock and a still camera, nothing re-renders.

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
`new-data`), `lastSampledTexels`, `unknownFraction`, `lastBuildMs`; plus `anchorResets` and `horizonRenders`.

## Evidence

**CPU ground truth** (`TerrainSunVisibility.ts`, vitest): the horizon march agrees with an independently derived analytic
ray for a synthetic ridge from 0.5° to 8° Sun elevation; unknown coverage is never lit or shadowed. Required coverage
(`occluderRangeKm`): Moon 1° / 10 km relief → 158 km, Mars → 208 km; the default 320 km outer level covers both.

**The real shader against the CPU reference** (`npm run test:terrain-shadow:webgl`, real WebGL, SwiftShader). A synthetic
2 km-wide, 1.5 km-high ridge with vertical walls in a realistic scene (scale 1e-6, rotated and offset body,
camera-relative geometry), 1930 receivers per body, Sun 1.5–12° at azimuths 90°/125°, each receiver compared at its own
horizon.

| | Moon | Mars |
| --- | --- | --- |
| Frame/data alignment (view 3 green) | 791 / 800 px | 791 / 800 px |
| Mean \|GPU − reference\| (Sun fraction), `high` | 0.008 | 0.008 |
| `medium` / `low` | 0.009 / 0.009 | 0.008 / 0.008 |
| Hand-filtered path (no float-linear) | 0.008 | 0.008 |
| Light leaks / false shadow beyond the edge tolerance (every preset) | 0 / 0 | 0 / 0 |
| Largest shadow-edge shift (0.4 km measurement grain) | 0.8 km | 0.8 km |

The first version scored 0.019 / 0.024, with 2 km edge shifts and 6–13 km edge shifts for `medium`/`low`. Edge
tolerance is `max(1 km, 12 % of the distance)` plus one texel of the level whose horizon map holds the receiver. The
clipmap holds the ridge's vertical walls as one-texel slopes, and horizons are interpolated between texel centres. With
the source ending before the ridge, the receiver is lit (1.0) and tinted in view `2`, not black.

**Real terrain**, hardware GPU. The #149 fused LOLA cube-sphere Moon, `scripts/capture-terrain-solar-shadow.mjs --gpu`
(Apple M4 Max, Metal, vsync off), same pose and epoch per mode. Files are in
[validation/terrain-solar-shadow/](validation/terrain-solar-shadow/) (`*-gpu.png`, raw JSON in `captures-gpu*.json`).
This catalog drapes no photo imagery, so `on` and `neutral` show computed lighting only. The ephemeris is the catalog's
Keplerian fallback, so the geometry is consistent but the calendar dates are not real.

| View | Sun at site | off | on | Sun fraction | neutral, no shadows | neutral, shadows | alignment |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Shackleton rim (89.67°S) | 0.74°, az 21.7° | [img](validation/terrain-solar-shadow/shackleton-rim-off-gpu.png) | [img](validation/terrain-solar-shadow/shackleton-rim-on-gpu.png) | [img](validation/terrain-solar-shadow/shackleton-rim-visibility-gpu.png) | [img](validation/terrain-solar-shadow/shackleton-rim-neutral-off-gpu.png) | [img](validation/terrain-solar-shadow/shackleton-rim-neutral-gpu.png) | [img](validation/terrain-solar-shadow/shackleton-rim-alignment-gpu.png) |
| Polar ridge field (88.4°S) | 1.80°, az 4.0° | [img](validation/terrain-solar-shadow/polar-ridge-off-gpu.png) | [img](validation/terrain-solar-shadow/polar-ridge-on-gpu.png) | [img](validation/terrain-solar-shadow/polar-ridge-visibility-gpu.png) | [img](validation/terrain-solar-shadow/polar-ridge-neutral-off-gpu.png) | [img](validation/terrain-solar-shadow/polar-ridge-neutral-gpu.png) | [img](validation/terrain-solar-shadow/polar-ridge-alignment-gpu.png) |
| Equatorial crater (9.6°N) | 2.86°, az 90.8° | [img](validation/terrain-solar-shadow/equatorial-crater-off-gpu.png) | [img](validation/terrain-solar-shadow/equatorial-crater-on-gpu.png) | [img](validation/terrain-solar-shadow/equatorial-crater-visibility-gpu.png) | [img](validation/terrain-solar-shadow/equatorial-crater-neutral-off-gpu.png) | [img](validation/terrain-solar-shadow/equatorial-crater-neutral-gpu.png) | [img](validation/terrain-solar-shadow/equatorial-crater-alignment-gpu.png) |

**Motion stability** (`--sequence`). Each frame is captured at one pose as off (view 6) | Sun fraction | neutral | on, and
assembled as a 2×2 MP4. Each sequence has a per-frame trace of every level's centre, builds, rebuild reason, texels
sampled and anchor resets (`sequences` in `captures-gpu.json`).

- **Camera, time frozen.** The camera pans 20 km, yaws 12° and zooms in, then returns along the same path. That re-centres
  the 8 km level about 15 times each way.
- **Time, camera fixed.** The clock advances 2 min per frame for 96 frames.

| View | Camera ([mp4](validation/terrain-solar-shadow/shackleton-rim-camera.mp4)): states seen / level builds / first vs last frame | Time ([mp4](validation/terrain-solar-shadow/shackleton-rim-time.mp4)): frame-to-frame change, max / median |
| --- | --- | --- |
| Shackleton rim | `ready`, `partial` (12 of 97 frames, tiles streaming) / 30, 4, 2 / **identical** (mean diff 0) | 0.044 / 0.037 = 1.19 |
| Polar ridge ([camera](validation/terrain-solar-shadow/polar-ridge-camera.mp4), [time](validation/terrain-solar-shadow/polar-ridge-time.mp4)) | `ready`, `partial` (11 of 97) / 33, 4, 2 / **identical** | 0.150 / 0.137 = 1.09 |
| Equatorial crater ([camera](validation/terrain-solar-shadow/equatorial-crater-camera.mp4), [time](validation/terrain-solar-shadow/equatorial-crater-time.mp4)) | `ready` only / 33, 6, 3 / **identical** | 0.906 / 0.640 = 1.42 |

The state never went to `building` and no anchor reset happened during any sequence. A pixel-identical round trip
means the shadows depend only on the terrain, Sun and pose: not on the path, the clipmap's centre or how often it
re-centred. A max/median near 1 means the edges advance evenly with time, with no frame jumping. In `partial` frames,
fine terrain the viewer has not streamed yet is shadowed from the coarser level, and sharpens a few frames later.

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

## Cost

Mean frame time on the hardware GPU (Apple M4 Max, Metal, vsync and frame limit off), the same three views and epochs.
Off → on is steady state. "Sun moving" re-renders a horizon map every frame (`on-rehorizon`), which is the cost during
time warp. At 1× it re-renders about once every 2 minutes on the Moon.

| View | 1280×720 off → on | Sun moving | 3840×2160 off → on | Sun moving | First version, 720p / 4K |
| --- | --- | --- | --- | --- | --- |
| Shackleton rim | 1.3 → 1.3 ms | 3.2 ms | 2.2 → 3.1 ms | 6.0 ms | 4.3 / 35.7 ms |
| Polar ridge | 1.2 → 1.3 ms | 3.5 ms | 1.5 → 2.1 ms | 5.0 ms | 3.4 / 31.2 ms |
| Equatorial crater | 1.2 → 1.3 ms | 2.7 ms | 1.5 → 1.5 ms | 4.7 ms | 1.5 / 12.8 ms |

- **Steady state** costs 0–0.9 ms even at 4K: the per-pixel part is a level lookup and one filtered fetch.
- **Horizon pass**: one level, 256² texels, about 1–2 ms on this GPU, at most two levels in a frame, and only when the
  data or the Sun changed. It does not grow with screen resolution. The presets change only this pass. `medium` and
  `low` take one-texel steps instead of 0.75, and `low` stops after 360 steps, which still reaches the outer level.
- **CPU fill**: a re-centre samples about 16k texels (the new strip), and an initial level 64k at 44–143 ms, spread over
  frames at `budgetMs` (3 ms).
- **Memory**: three RG32F height levels (1.5 MB) and three RGBA16F horizon maps (1.5 MB). No draw calls are added.

There is no phone or integrated-GPU measurement. The fragment cost is now near zero, so the open question there is the
horizon pass: 1–2 ms per level on an M4 Max, likely 5–20× more on a phone. `low` and smaller levels (`size: 128`) are
the levers. The default stays off until that is measured.

## Limits

- **Visual only.** No PSR certification, illumination duration or power products.
- **Resolution.** A receiver's shadow is interpolated between texel centres of its level: 62 m within 8 km of the focus,
  0.5 km to 64 km, 2.5 km beyond. Occluders are seen at their level's resolution, so a ridge narrower than a texel there
  is under-represented. The 62 m inner level resolves what LOLA 118 m (10 m polar) can show.
- **Range.** Terrain beyond the outer level (default 320 km) is unknown. The default covers a 1° Sun and 10 km relief.
- **Streaming.** Until fine source tiles arrive, the coarser level answers, and the shadow sharpens when they do. Terrain
  no level holds is drawn lit.
- **Time warp.** When the Sun moves more than 1/16 of its radius per frame, the coarser levels' maps can lag the finest
  by up to two frames.
- **Baked imagery** (see above). Imagery declared `baked` shows no terrain shadows, and the viewer says so.
- **Quantized-mesh terrain** mixes LODs in its CPU samples. Cube-sphere terrain is the supported low-Sun path.
- **Overhangs.** A radial height field cannot represent overhangs. `clipmapSourceFromSurface` keeps the highest surface.

## Acceptance

| Issue requirement | Where |
| --- | --- |
| Synthetic ridge with known occlusion; sweeps move the edge predictably | CPU test + WebGL parity, 2 azimuths × 5 elevations, 3 presets, 2 filter paths |
| Shackleton-like rim/floor, equatorial Moon, representative Mars | Real Moon captures; Mars synthetic only (no Mars terrain product locally) |
| Offscreen / adjacent-tile occluders within a documented radius | `occluderRangeKm`; outer level 320 km |
| No toggling across LOD; no acne/peter-panning; stable under motion | One source level per clipmap level; receiver on the same surface; round-trip-identical camera sequences; even time sequences |
| Neutral-albedo isolation and honest treatment of baked imagery | Debug views 4/5; WAC+NAC section |
| No regression: spacecraft shadows, eclipses, imagery overlays | Opt-in; direct term only; existing suites pass |
| Desktop cost | Hardware-GPU table at 720p and 4K, steady and Sun-moving |

## Next

1. **Phone / integrated-GPU run** of the horizon pass, then a per-device default `quality` / level `size`.
2. **Relightable polar albedo** so the shipped Shackleton scene can show changing illumination honestly.
3. **Numeric visibility query (#217)**: the same clipmap answers "is the Sun above the local horizon at this site";
   `solarVisibility` in `TerrainSunVisibility.ts` is that function over a height source. A separate issue.
