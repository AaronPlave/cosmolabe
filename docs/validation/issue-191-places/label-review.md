# Geographic label review follow-up

The cartographic policy and persistence replace the original per-frame draw-slot labels. Scientific source points, extents, coordinate transformations and provenance remain the existing imported geographic features.

## Design and source precedents

The [Celestia location model](https://github.com/CelestiaProject/Celestia/blob/master/src/celengine/location.h) separates physical size and importance; [MapLibre symbol style controls](https://maplibre.org/maplibre-style-spec/layers/#symbol) distinguish collision ordering, text halo and opacity. This implementation adapts those principles to physical 3D surface projection and LOS; it does not embed a 2D map engine or claim equivalent algorithms.

The precedence/default table, overrides and exact work bounds are in [planetary-nomenclature.md](../../planetary-nomenclature.md). Regions are ranked after projection and eligibility, so a densely populated spatial cell cannot starve an important visible feature. Whole-body views use broad layout clearance; font hierarchy and opacity remain modest. Selected places bypass scale admission, but never proven physical occlusion.

`PersistentLabels` and `AnnotationBudget` in `packages/three/src/annotations/` expose the renderer-independent identity, collision/stickiness, hysteresis, opacity, and deferred-work semantics. No other renderer is rewritten here. Adoption in adaptive graticules (#163) and contour labels (#265) remains scoped follow-up work under those existing issues; their output is still respected through shared annotation obstacles.

## Navigation integration

This branch includes the current #270 dependency without merging that PR. Place Fly/Jump now calls the same coordinate resolver, physical terrain refinement and `flyToSurface`/`jumpToSurface` path as Navigate. The earlier place-only targetOffset camera extension was removed. Copy emits a hemisphere-marked planetocentric pair matching Navigate’s default and the shared surface-point copy convention, and other-body navigation clears both detail selection and highlight. Same-body navigation retains selection.

## Reproduction

```sh
DEV_DATA_MODE=local npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5194 --strictPort
CL_VIEWER_URL=http://127.0.0.1:5194/ CL_GPU=hardware CL_TERRAIN=1 node scripts/test-planetary-places.mjs
CL_VIEWER_URL=http://127.0.0.1:5194/ CL_GPU=hardware CL_RECORD=1 CL_TERRAIN=1 node scripts/test-place-label-motion.mjs
```

Both scripts are CI gates using SwiftShader. CI samples the same complete motion path with 90 orbit frames and 60 frames per zoom leg, while the full physical recording uses 240 and 180 respectively, to keep the software-rendered gate within the job deadline. Sampling counts are recorded in its metrics. `CL_TERRAIN=1` and physical GPU recording require the preexisting local terrain pyramids and Chrome. The motion gate checks slow orbit, stop/start, tiny movement, zoom/pan through global/regional/surface tiers, stable DOM identities and bounded enter/exit counts. Unit regressions additionally force LOS deferral, hysteresis-edge movement, priority collisions, body rotation/backside, terrain LOS, selected persistence, viewport geometry and deterministic placement. Other unit/browser tests retain full-Gazetteer import/search/provenance, navigation equivalence, clipboard, failures and compact-layout coverage.

A physical query can exceed the 2 ms scheduler allowance. Last-valid LOS can remain until its scheduled refresh; known backside/occlusion is removed immediately. This bounded scheduling avoids frame-budget flicker without promising zero terrain-occlusion latency. Default importance is an authored cartographic heuristic; mission catalogs may override it and search always retains valid low-priority places.

## Recorded physical-GPU acceptance (2026-10-21)

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
