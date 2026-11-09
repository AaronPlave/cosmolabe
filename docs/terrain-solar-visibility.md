# Terrain-cast solar shadows and horizon occlusion (#205)

**Status: implemented, opt-in, visual only.** A ridge, crater wall or massif that blocks the Sun from a point on
streamed terrain now shades that point, from the actual Sun direction and epoch, including terrain beyond the screen
and across tile and LOD boundaries. It is not a certified illumination, permanently-shadowed-region or solar-power
product. Its cost is measured on a hardware GPU below: cheap on a desktop GPU at 1080p, **too heavy to default on** for
low-end or high-resolution targets (see [Cost](#cost)).

Builds on #204 ([surface-illumination.md](surface-illumination.md): Sun direction at the receiver, the direct term this
attenuates, imagery provenance). Not in scope: #182 hillshade, #134 scattering, #242 camera→Sun-disk visibility, #217
numeric site→target geometry.

## Use it

**Viewer: Display panel → Terrain shadows → Off / Low / Medium / High.** It appears whenever a loaded body has terrain
with heights a shadow can be built from (cube-sphere grids, quantized mesh), and it works on **any** such terrain, with
no catalog change: picking a quality builds the clipmap and adds the effect to the tiles already loaded. It follows the
catalog until you choose (Off, unless the catalog sets `solarShadows`), then remembers your choice
(`terrainShadowMode` in the viewer prefs). A line under it says what is happening: building, some terrain not loaded
(drawn lit, not shadowed), or on; and "Off in Flood lighting", since `flood` has no Sun.

Catalog: `"terrain": { …, "solarShadows": true }` ([catalog-format.md](catalog-format.md#solarshadows)) turns it on for
that terrain by default at `high` (`{ "quality": "low" }` etc. tunes it). It is off by default, so no existing scene
changes. The fixture catalog is `apps/viewer/test-catalogs/experiments/moon-terrain-cube-solar-shadow.json`.

Renderer (`UniverseRenderer`): `setTerrainShadowMode('off' | 'low' | 'medium' | 'high' | null)` (`null` follows the
catalog), `terrainShadowSummary()`, `terrainShadowStatus(body)`, `setTerrainShadowDebug(0|1|2|3)`. Debug views: `1` Sun
fraction (white lit, black shadowed), `2` the same with terrain the clipmap does not hold tinted magenta, `3`
frame/data alignment (green: the drawn surface is within 10 m of the clipmap).

What it touches: only the **direct** diffuse/specular term of **relit** surfaces (`reflectance` and legacy `unknown`
imagery; `mixed` stacks per pixel). Baked imagery is shown as it is (its shadows are in the pixels), ambient and eclipse
terms are untouched, and `flood` mode has no Sun, so the effect is off there. Small spacecraft/lander shadows keep their
own shadow map (`UniverseRenderer.updateSunLightAndShadow`), unchanged.

## How it works

**A height clipmap filled from source terrain, and a per-fragment horizon march against it.** Not a shadow map.

1. **Clipmap** (`SolarShadowClipmap.ts`). Up to three nested squares (default 8 / 64 / 320 km half-width at 256², i.e.
   62 m / 0.5 km / 2.5 km texels; about 2 MB), each re-centred in whole texels with hysteresis on the orbit target (or the
   camera). Every level holds the terrain's geocentric radius minus the anchor radius, in a **gnomonic** projection about
   one fixed anchor frame, so the sphere is exact at any range: no flat-ground approximation, and body curvature is
   first-order (see [Evidence](#evidence)). Levels are filled a few ms per frame (`budgetMs`, default 3) and swapped in
   when complete.
2. **One consistent source level per clipmap level.** Texels are read from the cube-sphere CPU grids at **one product
   level** (the coarsest whose cell is no wider than the texel), never from whatever mix of LODs happens to be resident.
   A mosaic has steps at its tile seams, and at a 1–3° Sun a 20 m step is a wall that casts a shadow hundreds of metres
   long (an early version did exactly this). A tile that is not resident yet is requested and the texel is *unknown*.
   Other sources go through `ClipmapSource`: `clipmapSourceFromSurface` adapts any `PhysicalSurface` (a height field by
   `sampleElevation`, a mesh/DSK by radial rays), so irregular meshes reuse the same march. The older quantized-mesh
   path reads the sampler's resident tiles and **does** mix LODs; use the cube product for reliable low-Sun shadows.
3. **Max-reduced mips** of every level, with validity as a second (min-reduced) channel. A march step longer than a texel
   reads the mip whose texel is at least that long at both ends of the step, so a ridge narrower than the step cannot be
   skipped (it can only be dilated). Textures are read with `texelFetch` and filtered by hand: no float-linear extension.
4. **Shader hook** (`injectSolarShadowIntoShader`, next to the #204 baked-imagery hook, one program for every tile). Per
   fragment: place the receiver on the clipmap's own surface (so receiver and occluder come from one data set and the draw
   LOD cannot create self-shadow or leaks), march toward the Sun with step `max(0.9 texel, stepGrowth × distance)`, take
   the largest angle by which terrain stands above the Sun ray, and convert it to the visible fraction of the Sun's disk
   (linear across its diameter, so shadow edges are continuous in time). It stops when the ray clears every possible
   occluder (`occluderRangeKm` below). Fragments facing away from the Sun are not marched.
5. **Jitter.** The first step and the cross-ray position of coarse taps are shifted per pixel (interleaved gradient noise).
   Without it every fragment samples the same distances and far edges band in stripes; with it they become grain.

**Unknown is never authoritative.** A fragment whose ray meets a texel with no source terrain, or lies outside every
level, is drawn **lit** (the #204 term) and flagged: debug view `2` tints it, and `terrainShadowStatus` reports each
level's `unknownFraction`, state (`building` / `partial` / `ready`), and last build time. While a level has unknown
texels a ray is not called clear until it rises above `unknownReliefKm` (default 10 km), so missing terrain cannot hide
behind an early exit. Coarse approximation is disclosed, not hidden: edges are conservative by up to one step (see Limits).

### Why not a Three.js shadow map

| Requirement | Shadow map (cascades/depth) | Horizon march over source heights |
| --- | --- | --- |
| Caster and receiver in different tiles / LODs | Depth comes from *drawn* LODs, so coarse caster and fine receiver disagree: acne, peter-panning, large dark areas that toggle on LOD swaps | Both read one source-height field: draw LOD cannot change the answer |
| Terrain beyond the frustum | Caster geometry must be drawn into the map: draw calls and streaming for tiles never shown | Heights only; no draw calls |
| 1–5° Sun, 100+ km shadows | Depth range/precision across 100+ km; cascades sized by Sun elevation | Cost is taps, not resolution; reach set by `occluderRangeKm` |
| Seams, skirts, missing LOD | Skirts cast; gaps leak light | A hole is a flagged unknown, not a leak |
| Moving Sun / camera | Texel swimming on every re-fit | Sun is a uniform; clipmap snaps to texels |

A precomputed horizon map (per-texel azimuth horizon angles built from the same clipmap) remains the fallback if the march
misses a mobile budget; it needs the same clipmap and the same fraction function.

## Evidence

**CPU ground truth** (`TerrainSunVisibility.ts`, 6 vitest cases): the horizon march agrees with an *independently derived*
analytic ray (`r(φ) = rp·cos el / cos(el+φ)`) for a synthetic ridge from 0.5° to 8° Sun elevation; the edge moves
monotonically with azimuth; unknown coverage is never lit or shadowed.

**Curvature is first-order.** On the Moon a 4 km height difference gives a 153 km flat-ground shadow at 1.5°, but ~80 km on
the sphere. **Required terrain coverage** (`occluderRangeKm`: beyond it no terrain of that height can block the Sun):

| Body | Sun elevation | Relief above receiver | Coverage radius |
| --- | --- | --- | --- |
| Moon | 1° | 5 km | 105 km |
| Moon | 1° | 10 km | 158 km |
| Moon | 2° | 5 km | 84 km |
| Moon | 5° | 5 km | 49 km |
| Mars | 1° | 5 km | 134 km |
| Mars | 1° | 10 km | 208 km |
| Mars | 5° | 5 km | 52 km |

The default outer ring (320 km half-width) covers the 1°, 10 km case on both bodies; terrain farther than the outer
level is outside the budget and is *unknown*.

**The real shader against the CPU reference** (`npm run test:terrain-shadow:webgl`, real WebGL, software SwiftShader).
A synthetic 2 km-wide, 1.5 km-high N–S ridge in a realistic scene (scale 1e-6, rotated and offset body, camera-relative
geometry), 1930 receivers per body over Sun elevations 1.5–12° and azimuths 90°/125°. Each receiver is compared with the
reference at *its own* horizon (a planet curves 0.033° per km, so one Sun direction is a different elevation per receiver).

| | Moon (1737.4 km) | Mars (3389.5 km) |
| --- | --- | --- |
| Frame/data alignment (view 3 green) | 791 / 800 px | 791 / 800 px |
| Mean \|GPU − reference\| (Sun fraction) | 0.019 | 0.024 |
| Light leaks (lit where reference shadowed, beyond edge tolerance) | 0 | 0 |
| False shadow (dark where reference lit, beyond edge tolerance) | 0 | 0 |
| Largest shadow-edge shift (0.4 km measurement grain) | 2.0 km | 1.6 km |
| `medium`: mean error / leaks / largest shift | 0.046 / 0 / 6.0 km | 0.042 / 0 / 5.2 km |
| `low`: mean error / leaks / largest shift | 0.050 / 0 / 6.8 km | 0.065 / 0 / 13.2 km (6 receivers dark that the reference lights) |

The edge tolerance is `max(1 km, 12 % of the distance to the ridge)`. Unknown coverage: with the source ending between a
receiver and the ridge, the receiver is lit (1.0) and tinted in view `2`, not black. The 5 + 4 non-green alignment pixels
are the ridge flanks, where the drawn triangles and the bilinear clipmap differ by more than 10 m.

**Real terrain**: the #149 fused LOLA cube-sphere Moon (local data), `scripts/capture-terrain-solar-shadow.mjs`, same pose
and epoch per view, playback paused. Images and raw JSON (clipmap status, Sun geometry, timings, poses) are in
[validation/terrain-solar-shadow/](validation/terrain-solar-shadow/). Epochs are chosen by scanning the clock for the Sun
elevation wanted at the site; the ephemeris is the catalog's Keplerian fallback (no SPICE kernels), so the *geometry* is
consistent but not the real calendar date.

| View | Sun at site | off (#204) | on | flood | Sun fraction | unknown | alignment |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Shackleton rim (89.67°S) | 0.74° el, az 21.7° | [img](validation/terrain-solar-shadow/shackleton-rim-off.png) | [img](validation/terrain-solar-shadow/shackleton-rim-on.png) | [img](validation/terrain-solar-shadow/shackleton-rim-flood.png) | [img](validation/terrain-solar-shadow/shackleton-rim-visibility.png) | [img](validation/terrain-solar-shadow/shackleton-rim-unknown.png) | [img](validation/terrain-solar-shadow/shackleton-rim-alignment.png) |
| Polar ridge field (88.4°S) | 1.80°, az 4.0° | [img](validation/terrain-solar-shadow/polar-ridge-off.png) | [img](validation/terrain-solar-shadow/polar-ridge-on.png) | [img](validation/terrain-solar-shadow/polar-ridge-flood.png) | [img](validation/terrain-solar-shadow/polar-ridge-visibility.png) | [img](validation/terrain-solar-shadow/polar-ridge-unknown.png) | [img](validation/terrain-solar-shadow/polar-ridge-alignment.png) |
| Equatorial crater (9.6°N) | 2.86°, az 90.8° | [img](validation/terrain-solar-shadow/equatorial-crater-off.png) | [img](validation/terrain-solar-shadow/equatorial-crater-on.png) | [img](validation/terrain-solar-shadow/equatorial-crater-flood.png) | [img](validation/terrain-solar-shadow/equatorial-crater-visibility.png) | [img](validation/terrain-solar-shadow/equatorial-crater-unknown.png) | [img](validation/terrain-solar-shadow/equatorial-crater-alignment.png) |

All six clipmaps finished `ready` with 0 % unknown texels. The drawn surface agrees with the clipmap to 10 m almost
everywhere (alignment views are green); red/blue patches are steep rim slopes, where the drawn mesh LOD differs from the
consistent source level. A *representative Mars* real-terrain fixture is not included: no Mars terrain product is local,
so Mars is covered by the synthetic-ridge test at Mars's radius.

## Cost

All numbers are mean frame time with shadows off → on, from `scripts/capture-terrain-solar-shadow.mjs` on the real Moon
terrain at the three views below, same pose and epoch. **Hardware: Apple M4 Max (Metal via the installed Chrome, vsync and
frame limit off, so the interval is the cost of the frame).** This is a high-end desktop/laptop GPU; there is no phone or
integrated-GPU number, and the 4K rows are a fill-rate stress test, not a mobile measurement.

| View (Sun at site) | 1280×720 `high` | `medium` | `low` | 3840×2160 `high` | `medium` | `low` |
| --- | --- | --- | --- | --- | --- | --- |
| Shackleton rim (0.74°) | 1.3 → 4.3 ms | 3.6 | 2.8 | 2.4 → 35.7 ms | 29.6 | 21.2 |
| Polar ridge field (1.8°) | 1.2 → 3.4 ms | 2.7 | 2.5 | 1.4 → 31.2 ms | 23.4 | 16.7 |
| Equatorial crater (2.9°) | 1.2 → 1.5 ms | 1.4 | 1.3 | 1.5 → 12.8 ms | 10.2 | 8.0 |

(`medium` and `low` give the shadows-on time; the off time is the same as `high`'s.) The p95 is about twice the mean
(`captures-gpu*.json` has mean / p50 / p95 per row).

- On this GPU at 720p the effect costs **0.3–3 ms**. It scales with lit pixels at a low Sun, so Shackleton (low Sun over
  mostly lit rim terrain) is the worst case and the equatorial crater the best.
- Cost is linear in pixels: about **3 ms per megapixel at `high`** in the worst view, so 4K is ~9× the 720p cost. A phone
  or integrated GPU at 1080p with a device pixel ratio of 2–3 has several times more pixels *and* a GPU far slower per
  pixel than an M4 Max, so `high` is not viable there. `low` is 20–40 % cheaper than `high`, not free, and moves far
  shadow edges further toward the occluder (see Evidence). **Do not default this on for mobile or low-end targets.**
- Two optimisations came out of the measurements and are in the shader: bilinear taps use one hardware fetch when the device
  filters float textures (4 → 1 fetches, about 20 % faster; the manual path is kept and tested for devices that cannot), and
  the march stops as soon as terrain covers the whole Sun disk, which more terrain cannot undo, so it is exact (about 3×
  faster over a shadowed floor: Shackleton went from 13.1 to 4.5 ms). The earliest software-WebGL runs (40 → 500 ms) were
  ~100× more pessimistic than this GPU and are no proxy for it.

**CPU clipmap fill** (per level, `status.levels[].lastBuildMs`): 44–143 ms for 256² samples, spread over frames at 3 ms each,
so no frame stalls. With a 4× CPU throttle in software WebGL (which does not slow GL) it was 257–511 ms (3.5–5×), still
incremental. Re-centring rebuilds only the level whose hysteresis box (25 % of its half-width) was left.

**Memory**: three levels of RG32F with mips, about 2.1 MB (0.5 MB at 128²). **Draw calls**: none added. Turning it on for
terrain that was loaded without it recompiles the tile program once (the hook is appended to the loaded tiles' shaders).

Still missing: a phone or integrated-GPU capture, which should set the default `quality` per device class; until then the
catalog default stays off.

## Limits

- **Visual only.** No PSR certification, illumination duration or power products.
- **Conservative edges.** A ridge may be dilated by about one step (`stepGrowth` × distance: 4 % `high`, 5.5 % `medium`,
  8 % `low`, at least one texel), so far shadow edges sit slightly toward the occluder and are grainy rather than banded.
  Edge position is bounded by the table above; light is not let through a ridge wider than a texel of the level in use.
- **Resolution.** An occluder narrower than about two texels of its level (500 m at the middle level) can be under-
  represented; the 62 m inner level resolves what LOLA 118 m (10 m polar) can show.
- **Range.** Terrain beyond the outer level (default 320 km) is unknown; the default covers a 1° Sun and 10 km relief.
- **Anchor.** One anchor frame serves the whole clipmap and resets when the focus moves more than 2° (~60 km on the Moon),
  rebuilding the levels. Fragments outside every level, or while a level is building, are drawn lit.
- **Quantized-mesh terrain** mixes LODs in its CPU samples; cube-sphere terrain is the supported low-Sun path.
- **Imagery declared `baked`** cannot show terrain shadows: its lighting is in the pixels (the viewer says so under the control). The shipped Shackleton WAC+NAC layer is *described* as baked but declares no provenance, so it is relit as `unknown` and does show them; declaring it `baked` would be right for the data and would hide them.
- **Overhangs.** A radial height field cannot represent a mesh with overhangs; `clipmapSourceFromSurface` keeps the highest surface.
- **Sampler statistics.** Fills read the same CPU sampler as readouts, so `terrain.sample` counters include them.

## Acceptance

| Issue requirement | Where |
| --- | --- |
| Synthetic ridge with known occlusion; time/rotation sweep moves the edge predictably | CPU test + WebGL parity, 2 azimuths × 5 elevations |
| Shackleton-like rim/floor, equatorial Moon, representative Mars; same camera/epoch normal vs flood | Real Moon captures (above); Mars synthetic only |
| Offscreen / adjacent-tile occluders within a documented radius and accuracy budget | `occluderRangeKm` table; edge-shift bounds |
| No abrupt toggling across LOD; precision / peter-panning / acne verified | Source read at one level; no depth map; ray starts on the clipmap surface; alignment view |
| No regression: spacecraft/lander shadows, eclipses, instrument parity, imagery overlays | Opt-in; `updateSunLightAndShadow` untouched; direct term only; existing 2248 tests and the #204 WebGL test pass |
| Before/after capture at fixed physical times; benchmark desktop and slower proxy | Captures above; hardware GPU (M4 Max) at 720p and 4K, three presets; no phone/integrated GPU |
| Recommendation, slices, limits, whether a numeric visibility query is justified | This page |

## Next

1. **Mobile / integrated-GPU benchmark.** Then set the default `quality` per device class, and decide whether shipped
   relit-terrain catalogs should opt in.
2. **Numeric visibility query (#217).** The same clipmap answers "is the Sun above the local horizon at this site" without
   the GPU: `solarVisibility` in `TerrainSunVisibility.ts` is already that function over a height source. Exposing it as a
   physical-surface query (site, direction, coverage/accuracy, unavailable) is justified, but is a separate issue with its
   own validation; no change to #205's visual gate.
3. **Clipmap scroll** (shift texels instead of rebuilding), **max-supersampled coarse levels** for narrow far ridges, and a
   real Mars terrain fixture.
