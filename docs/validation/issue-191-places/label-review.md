# Geographic label review follow-up

The cartographic policy and persistence replace the original per-frame draw-slot labels. Scientific source points, extents, coordinate transformations and provenance remain the existing imported geographic features.

## Design and source precedents

The [Celestia location model](https://github.com/CelestiaProject/Celestia/blob/master/src/celengine/location.h) separates physical size and importance; [MapLibre symbol style controls](https://maplibre.org/maplibre-style-spec/layers/#symbol) distinguish collision ordering, text halo and opacity. This implementation adapts those principles to physical 3D surface projection and LOS; it does not embed a 2D map engine or claim equivalent algorithms.

The precedence/default table, overrides and exact work bounds are in [planetary-nomenclature.md](../../planetary-nomenclature.md). Regions are ranked after projection and eligibility, so a densely populated spatial cell cannot starve an important visible feature. Whole-body views use broad layout clearance; font hierarchy and opacity remain modest. Selected places bypass scale admission, but never proven physical occlusion.

`PersistentLabels` and `AnnotationBudget` in `packages/three/src/annotations/` expose the renderer-independent identity, collision/stickiness, hysteresis, opacity, and deferred-work semantics. No other renderer is rewritten here. Adoption in adaptive graticules (#163) and contour labels (#265) remains scoped follow-up work under those existing issues; their output is still respected through shared annotation obstacles.

## Zoom-stability and double-click re-review

The follow-up to [review 6328188076](https://github.com/AaronPlave/cosmolabe/pull/274#issuecomment-6328188076) retains the same primitives. Contested ownership uses a 20-point priority takeover margin, separate screen-space entry/leave footprints (new arrivals require at least 12 px additional clearance), and the existing .75/1 scale hysteresis. Ranking has no wall-clock hold timer. A replacement reserves its slot while the predecessor fades out, then fades in; ordinary competing names cannot crossfade over each other. If camera motion makes already-visible footprints intersect, the live owner takes precedence immediately.

Ordinary omissions fade; retained IDs bypass regional and 512-candidate admission cuts and keep freshly projected physical anchors. Explicit invalidation handles proven backside/LOS occlusion, invalid anchors, removed/hidden data and unavailable bodies. Deferred LOS retains the last completed result. Departing and faint entering labels are not pickable.

Double-click uses the shared scene-selection path and emits `geographic:dblclick`; the viewer resolves the current place and calls `navigateToPlace(place, 'fly')`. Existing body fallback and tool/measurement/probe/event precedence remain covered. No extra DOM click handler or camera path was added.

The CI motion gate now captures actual per-frame IDs, opacity, accepted state and text rectangles in both zoom directions and tiny repeated zoom reversals. It checks per-place visibility and accepted-state sequences, bounded collision handoffs, and absence of overlapping text above .1 opacity. A place may appear at most twice per broad zoom leg; a repeat entry requires at least 25% camera-range change since its previous exit. Tiny zoom reversals therefore cannot repeatedly alternate winners. These checks use the camera scale, not a frame-rate-dependent timer. Unit regressions cover nearly tied competitors, threshold motion, decisive takeover, non-overlapping handoff, ordinary omission versus authoritative invalidation, and Mars/Moon double-click/body/tool routing.

### Updated recording and measured acceptance

[Continuous zoom/double-click/terrain recording](labels-zoom/label-motion.mp4) · [Per-frame IDs, opacity, rectangles, scale and state sequences](labels-zoom/motion-metrics.json). This supersedes the initial recording below for label stability. The entire browser session is transcoded to H.264 without cuts, at 1440×900 on Chrome/Metal, Apple M4 Max. It includes hover, label double-click flights, both zoom directions, repeated tiny reversals, body switching and real terrain loading/refinement.

| Measured collision handoffs (180 frames per zoom leg) | Mars | Moon |
| --- | ---: | ---: |
| Global → regional | 8 | 10 |
| Regional → surface | 9 | 13 |
| Surface → global | 10 | 8 |
| Tiny zoom reversals | **0** | **0** |

Both slow-orbit runs retained **0 enters / 0 exits / 0 DOM identity changes** across 240 frames, with 1,680 Mars and 1,200 Moon moving-name pick checks. Label CPU p95 was 7.9 ms / 6.9 ms respectively at this recording viewport; these are separate from the initial 4K measurements below. There were **zero overlapping text pairs** above .1 opacity in all gated zoom samples. No place repeated its appearance during either inward leg or tiny reversals; one Mars outward sequence legitimately re-entered after a substantial scale/position change, within the declared scale-aware bounds. Both real-terrain probes returned `terrain`; supported Moon label sampling and the explicit Mars reference-shape fallback remain unchanged.

Updated captures: [Mars global](labels-zoom/mars-global.png), [regional](labels-zoom/mars-regional.png), [surface](labels-zoom/mars-surface.png), [terrain](labels-zoom/mars-terrain-refinement.png); [Moon polar global](labels-zoom/moon-global.png), [regional](labels-zoom/moon-regional.png), [surface](labels-zoom/moon-surface.png), [terrain](labels-zoom/moon-terrain-refinement.png).

Local validation: the final SwiftShader CI sampling run passes with no browser errors; 91 focused regressions pass; build, lint, all type checks and production bundle pass. The broader suite passed 215 files / 2,507 tests, with the previously documented unchanged CSPICE progress-throttle timing failure and 7 skipped tests. Final remote-head CI is reported on the PR. No physical-phone or human acceptance is claimed.

## Navigation integration

PR #270 is merged in main; this branch incorporates its final implementation through main commit `9a692d1`. Place Fly/Jump now calls the same coordinate resolver, physical terrain refinement and `flyToSurface`/`jumpToSurface` path as Navigate. The earlier place-only targetOffset camera extension was removed. Copy emits a hemisphere-marked planetocentric pair matching Navigate’s default and the shared surface-point copy convention, and other-body navigation clears both detail selection and highlight. Same-body navigation retains selection.

## Reproduction

```sh
DEV_DATA_MODE=local npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5194 --strictPort
CL_VIEWER_URL=http://127.0.0.1:5194/ CL_GPU=hardware CL_TERRAIN=1 node scripts/test-planetary-places.mjs
CL_VIEWER_URL=http://127.0.0.1:5194/ CL_GPU=hardware CL_RECORD=1 CL_TERRAIN=1 node scripts/test-place-label-motion.mjs
```

Both scripts are CI gates using SwiftShader. CI samples the same complete motion path with 90 orbit frames and 60 frames per zoom leg, while the full physical recording uses 240 and 180 respectively, to keep the software-rendered gate within the job deadline. Sampling counts are recorded in its metrics. `CL_TERRAIN=1` and physical GPU recording require the preexisting local terrain pyramids and Chrome. The motion gate checks slow orbit, stop/start, tiny movement, zoom/pan through global/regional/surface tiers, stable DOM identities and bounded enter/exit counts. Unit regressions additionally force LOS deferral, hysteresis-edge movement, priority collisions, body rotation/backside, terrain LOS, selected persistence, viewport geometry and deterministic placement. Other unit/browser tests retain full-Gazetteer import/search/provenance, navigation equivalence, clipboard, failures and compact-layout coverage.

A physical query can exceed the 2 ms scheduler allowance. Last-valid LOS can remain until its scheduled refresh; known backside/occlusion is removed immediately. This bounded scheduling avoids frame-budget flicker without promising zero terrain-occlusion latency. Default importance is an authored cartographic heuristic; mission catalogs may override it and search always retains valid low-priority places.

## Initial physical-GPU acceptance (2026-10-21)

[Continuous screen recording](labels/label-motion.mp4) — slow orbit, stop/start/tiny motion, FOV changes, zoom/pan through all tiers, selection/body change, then real terrain loading/refinement. The recording is one uninterrupted browser session, transcoded from Playwright WebM to H.264 without cuts. Screenshot textures/illumination come from the actual catalog; the south-polar Moon is naturally dark, not missing geometry.

| Scale | Mars | Moon |
| --- | --- | --- |
| Global | [Mars](labels/mars-global.png) | [Moon polar/day-night](labels/moon-global.png) |
| Regional | [Mars](labels/mars-regional.png) | [Moon](labels/moon-regional.png) |
| Surface | [Mars](labels/mars-surface.png) | [Moon night side](labels/moon-surface.png) |
| Measured terrain/refinement | [Jezero](labels/mars-terrain-refinement.png) | [Shackleton](labels/moon-terrain-refinement.png) |

[Full workflow metrics](labels/workflow-metrics.json) · [Per-frame motion and churn metrics](labels/motion-metrics.json).

Chrome/Metal, Apple M4 Max. The workflow run uses a **3840×2160** drawing buffer; the recording is **1440×900**, reported separately. All **11,139** records loaded, with zero geographic importer skips; initial import **451.4 ms**, index construction **27.7 ms**, initial JS heap **75.8 MiB** (viewer plus original/normalized data, not isolated retained-memory usage).

| 4K whole-body view | Names | Candidates | Label CPU p95 ms | Frame p95 ms | Warm enters/exits |
| --- | ---: | ---: | ---: | ---: | ---: |
| Mars places orbit | 8 | 87 | 6.80 | 16.80 | 0/0 |
| Moon places orbit | 7 | 25 | 6.50 | 16.80 | 0/0 |

The extra projection/ranking work increases total label CPU over the original implementation, while both full-body samples still hold approximately 60 FPS. The 2 ms allowance applies to scheduled physical sampling/LOS, not total label projection/layout.

- **Mars slow motion:** 0 enters / 0 exits across 240 frames; 0 DOM identity changes; 1680 successful moving-label pick checks; frame p95 17.50 ms.
- **Moon slow motion:** 0 enters / 0 exits across 240 frames; 0 DOM identity changes; 1200 successful moving-label pick checks; frame p95 18.90 ms.

During deliberate zoom sweeps, enter/exit counts rise as different named anchors enter/leave the frustum, scale bands and collision layout; the complete counts are retained rather than hidden behind FPS. Both measured-terrain sequences returned actual `terrain` probe hits. Moon anchors use supported physical terrain samples; Mars names retain the explicit reference-shape fallback for unsupported areoid-datum heights. Some selected anchors briefly have no label during proven terrain occlusion/refinement; LOS deferral alone cannot remove an already accepted label.

Build, lint, all type checks, production bundle, 11 Python tests and focused place/annotation/navigation regressions pass. The full local suite passed 215 test files / 2,495 tests with one unchanged CSPICE progress-throttle timing failure and one skipped file / seven skipped tests; additional final regressions pass in the focused gate. Final remote-head CI is reported on the PR. No physical-phone or human acceptance is claimed.
