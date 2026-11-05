# LRO FOV clipping validation

Catalog: `test-catalogs/lro-moon`. Browser checks used local Chrome with ANGLE Metal on
an Apple M4 Max, not SwiftShader. These are renderer geometry checks with the
catalog's existing pointing/fallback behavior, not certified observation footprints
or a validation of historical instrument attitude.

## Reproduction and changes

At `2025-01-15T00:02:41Z`, LRO is about 76.7 km above the lunar reference sphere.
All seven catalog sensors previously stopped at a fixed 60 km visualization range.
The padded terrain bound could overlap those rays even though the physical surface
was beyond their range. An unsuccessful between-miss probe recursively subdivided
both halves anyway, exhausting 4,096 samples and approximately 300,000 boundary
direction evaluations per sensor. Pausing hid that repeated work through caching.

The fix stops failed probes, still checks other candidate bodies, and removes the
LRO catalog's fixed range caps. Sensor FOVs use the existing target-distance range
and physical-surface clipping. Terrain queries share identical rays, reject unrelated
triangle groups, and account for actual triangle tests. A budget-exhausted partial
sensor pass is discarded and retried entirely against explicit reference fallback.

At `2025-01-15T00:51:34Z`, additional isolated notches came from rays crossing the
datum in one tile and below-datum terrain in a neighbouring tile. The datum tile
missed the physical ray, causing a roughly 4 km jump to the reference sphere.
The corrected lookup uses height only to find candidate tiles after the finest datum
tile misses; endpoints still come from triangle intersections. Missing geometry
remains unavailable. Per-ray tile and per-frame triangle budgets are unchanged.

## Visual evidence at 00:51:34 UTC

Same terrain-facing camera and epoch; the dark lunar surface is not artificially
brightened. The screenshots show FOV geometry and its reference/terrain discontinuities.

| Before height-guided tile discovery | After |
| --- | --- |
| ![Isolated reference fallback creates tall notches](img/lro-fov-clipping/before.png) | ![The corresponding terrain-backed boundaries are continuous](img/lro-fov-clipping/after.png) |

In this reproduction, NAC had 25 reference endpoints among 131 samples and WAC had
29 among 145. After the final on-demand lookup change, NAC had 76 samples and WAC
78, all terrain-backed. Terrain query calls fell from 506 to 362. The finer detail
is still provisional/coarse, as required by the resident-terrain surface contract.

## Playback cost and limits

Instrumented Chrome playback near 00:02:41 initially measured about 47 ms p95 per
sensor with failed recursive probing. After the clipping/range changes, a physical
GPU run with terrain-backed FOVs measured about 1.1 ms p95 per sensor. The final
on-demand neighbour lookup near 00:51:34 at 30x playback measured about 1.8 ms p95
per sensor; paused cached clipping was effectively zero. These are CPU clipping
measurements in different described scenes, not GPU frame times or universal limits.

Regression tests cover bounded failed probes, real grazers behind loose bounds,
triangle-group rejection and shared edges, shared terrain queries and whole-sensor
budget fallback, all seven LRO catalog ranges, above/below-datum neighbouring tile
hits, and avoiding height lookup when the first tile already answers.

Some later wide-FOV gaps are genuine absent CPU residency: the predicted terrain
crossing has no loaded tile, including cases where the datum location has a tile.
More perimeter samples cannot supply that geometry. Instrument-driven coverage
requests, cancellation, shared loading budgets and recovery are tracked separately
in [#280](https://github.com/AaronPlave/cosmolabe/issues/280). No terrain loading,
interpolated gap filling, or scientific footprint certification is added here.

## PR review follow-up

Terrain/mesh candidates now try at most three fixed interior probes in addition to
closest approach when an all-miss interval overlaps their bounds. Failed probes
still never recurse. A deterministic physical-triangle regression covers a ridge
at the quarter point while both base rays and the closest-approach ray miss.
Finite rendering samples cannot guarantee discovery of arbitrarily narrow ridges.

Triangle bounds now use only spare mesh memory: groups coarsen from four triangles
as needed, or bounds are omitted when fewer than 48 bytes remain. Physical mesh
admission therefore matches the globe precheck. A 385×385 grid remains queryable
under the default 8 MiB budget with acceleration; at its exact positions+indices
budget it returns the identical physical hit through a full scan. Retained bytes
include all allocated bounds and stay within the existing budget.

The 60 focused tests pass. A repeat Chrome/ANGLE Metal run on Apple M4 Max at
00:51:34, covering 120 paused, 120 playing at 30x and 120 paused-after frames,
measured 1.9 ms p95 CPU clipping per sensor during playback (previous run 1.8 ms).
The initial paused perimeter still has at most 78 samples, with no tall notches in
the rendered check. Playback peak actual triangle tests were 100,447; the unchanged
100,000 budget can finish its current tile query before deferring further work.
