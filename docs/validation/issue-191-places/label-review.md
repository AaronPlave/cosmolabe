# Geographic label validation

The cartographic labels reuse imported geographic features, namespaced identity, scientific source coordinates, extents and provenance. [Policy, defaults and work bounds](../../planetary-nomenclature.md) document the feature; [Navigate acceptance](navigation-review.md) covers its user interaction.

## Motion and decluttering

`PersistentLabels` and `AnnotationBudget` provide persistent identity, collision ownership, opacity and deferred physical work. Ordinary omissions fade. Proven backside/LOS occlusion, invalid anchors, unavailable bodies and removed/hidden data invalidate unsafe labels immediately. Deferred LOS retains the last completed result. Source extents guide scale admission, not surveyed boundaries.

The existing acceptance checks visible and accepted-state runs, bounded collision handoffs, stable DOM identity, moving-name picking and no overlapping painted text above 0.1 opacity. It permits at most two appearances per broad zoom leg and requires **1.25× camera-range change from ownership loss** before a departed name returns. Unexplained opacity loss while still accepted starts its own departure. The threshold and tests are unchanged by this evidence cleanup.

[Motion summary](label-motion-review/summary.json) records the final local runs from the label-motion review (`754ba33`): Chrome/Metal at full 240 / 180 / 20 sampling and SwiftShader at 90 / 60 / 6. Both complete Mars/Moon global→regional→surface, reverse zoom, tiny reversals and small pans without browser errors. Phase summaries retain sampling, pick counts, identity changes, timing, maximum run counts and collision handoffs; individual frames/IDs were omitted. This is an evidence reduction, not a replacement for executing the assertions.

Selected captures: [Mars global](label-motion-review/mars-global.png), [Mars regional](label-motion-review/mars-regional.png), [Moon regional](label-motion-review/moon-regional.png). Initial 4K measurements preceded the final refinements: 8 Mars / 7 Moon names, label CPU p95 6.8 / 6.5 ms and frame p95 about 16.8 ms on Chrome/Metal, Apple M4 Max. Measurements are viewport/device-specific, not universal performance guarantees; the 2 ms allowance applies to scheduled physical work, not all projection/layout CPU.

## Label-motion failure diagnosis

The final review reproduced two actual continuity defects and one frame-time-dependent assertion error:

| Case | Evidence and correction |
| --- | --- |
| Hephaestus Rupēs (`2459`) near viewport edge | Eligibility stayed around 7–8 and cached LOS remained visible. Higher-priority `2404` took its slot, left the viewport, and `2459` briefly returned just before its own exit. Applying full entry clearance to viewport edges prevents that return while preserving incumbent exits. |
| One-frame padding collision (`356` / `389`) | Placement padding intersected while painted text stayed separate. Using padding to suppress fades destroyed the old state. Separate painted bounds preserve the fade/identity; true painted overlap still suppresses unsafe departures. |
| Full-sampling fade (`15904`) | Ownership loss began near 290 km, fade completed near 420 km, and re-entry occurred near 485 km. The actual departure-to-return change was 1.67×; measuring after fade completion incorrectly reported 1.15×. The same 1.25× check now starts at ownership loss. |

Both renderer fixes passed the original unchanged assertion under local SwiftShader before the fade-accounting correction. Regressions preserve rejection of short collision returns, unexplained opacity blinks and stale departure reuse. The two renderer regressions failed on the original renderer and passed with the fixes. The cleanup does not alter any of this code or coverage.

## Terrain label anchoring

Unsupported areoid heights remain unsupported physical elevations. Heightless label presentation can instead follow the currently drawn surface through the existing probe/pin hit path, with explicit `rendered-surface` identification. Explicit source heights remain intact; physical navigation and scientific datum semantics do not change. Cached completed anchors drive close-range projection/admission, scheduled re-seating follows refinement, and LOS still rejects occluded labels.

Sakarya Vallis previously used a reference anchor **2.372 km above the rendered ground**. The final [terrain results](label-motion-review/terrain-results.json) preserve GPU identification, the five acceptance cases and geometric error measurements: unselected label visible/pickable at 20 km, 1 km, 100 m and **20 m**, plus 100 m-high / 500 m-across oblique viewing. Geometric agreement passes the test's 10 m bound; it is not a terrain-height accuracy claim. Hardware was Chrome/ANGLE Metal on Apple M4 Max. The location uses global terrain outside the Jezero native imagery patch.

Captures: [20 km context](terrain-labels/sakarya-20km.png), [20 m close view](terrain-labels/sakarya-0.02km.png), [oblique view](terrain-labels/sakarya-0.1km-oblique.png).

The original terrain acceptance also distinguished supported Moon terrain samples from Mars reference-shape fallback rather than inventing an areoid transform. The [historical import summary](import-summary.json) preserves those results. A physical query can exceed the scheduler allowance; last-completed LOS can remain until refresh. No zero-latency occlusion guarantee is implied.

## Reproduction and CI

Use the [recording, smoke and terrain commands](README.md#reproduce). Full traces/videos are generated output, not committed evidence. [Exact-head CI at 43db339](README.md#ci-evidence) passed the motion/inspector gates and uploaded their raw output; artifacts may expire and can be regenerated. No physical-phone or independent human acceptance is claimed.
