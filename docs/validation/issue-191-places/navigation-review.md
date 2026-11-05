# Named target and navigation validation

This compact record supersedes the earlier chronological capture sets. It preserves user-facing acceptance, provenance, limitations and the [latest motion diagnosis](label-review.md#label-motion-failure-diagnosis). Full output remains reproducible through the [existing scripts](README.md#reproduce).

## Browse and inspect

Navigate has Places and Coordinates modes using the shared #270 resolver/controller, view presets, physical refinement and Fly/Jump path. Browse and inspection are separate views. Back restores query, filters, ordering and scroll without cancelling the active target. Inspection has one content scroller and a fixed action footer. Active named targets remain distinct from informational selection; releasing a target preserves camera position/time/body tracking. Copy uses explicit planetocentric/east-longitude hemisphere formatting and feedback expires after six seconds.

All matches sort before incremental DOM rendering, with total/rendered counts and keyboard Show more. Body remains prominent; Type/Origin/Sort occupy a compact popover. Relevance uses tracked body, exact name, cartographic importance and diameter; name and indicative-diameter sorts apply to all matches, with unknown sizes last. An indicative diameter is not a boundary. Initial docked height is half the viewport; resize/compact presentation remains authoritative.

[Inspector results](final-framing/results.json) cover narrow/tall floating panels and compact sheets, pinned actions, one scroll owner, retained browsing, focus-ring and scrollbar containment, active-filter truncation and source restoration. [Shared navigation results](final-framing/navigation-results.json) cover equivalent Places/Coordinates camera poses, presets, Fly/Jump, clipboard, safe viewport double-click and scene replacement.

Selected captures: [340 px inspector](final-framing/inspect-340.png), [720 px inspector](final-framing/inspect-720.png), [compact inspector](final-framing/inspect-compact.png), [compact browse](final-framing/browse-compact.png), [named target HUD](navigation/arena-named-target.png), [named target on terrain](navigation/named-terrain.png).

Full-index search p95 was **0.1–5.5 ms** on Apple M4 Max / Chrome/Metal with 11,139 places, 10 warm-ups and 40 timed queries. These are synchronous index filter/sort timings, not network or end-to-end rendering. [Latency results](review-followup/search-latency.json), [GPU identification](review-followup/gpu.json).

## Final source-status and feature-framing review

Addresses [review 6369348271](https://github.com/AaronPlave/cosmolabe/pull/274#issuecomment-6369348271).

**Auto / Fit feature / Custom** preserves explicit intent. Fit recomputes approximate overhead altitude from the newly inspected indicative diameter (minimum 5 km); unknown/invalid diameter visibly falls back to Auto. Coordinates treats retained Fit as Auto, while explicit Custom remains shared. Typing switches to Custom; clearing switches to Auto. Viewport double-click retains predictable Overhead+Auto behavior independently of form state. Equivalently configured Places/Coordinates actions land at the same camera pose.

Captures: [large feature](final-framing/fit-large.png), [small feature](final-framing/fit-small.png), [unknown diameter fallback](final-framing/fit-unknown.png).

Include source controls search/drawing eligibility independently of Show labels. **No name sources included** means all sources are excluded. **Geographic labels hidden; names remain searchable** covers included sources hidden by layer/body. Changing a caption never changes source or label choices. Cmd-K and Places use the same availability policy; unlink/disable reconciles stale inspection/targets without moving the camera. Re-enable/relink, mixed sources and body-wide visibility are tested. The Places demo enables both bodies' names by authored default.

Captures: [included but hidden](final-framing/sources-hidden.png), [excluded](final-framing/sources-excluded.png), [mixed](final-framing/sources-mixed.png). Both local hardware and SwiftShader acceptance passed; [CI logs and full raw artifacts](README.md#ci-evidence) additionally prove inspector ran before motion and both passed at `43db339`.

## Mission adoption and limits

All six shipped mission scenes loaded their unchanged assets/trajectories, exposed only the appropriate body's Gazetteer, found an official feature and navigated it without geographic/browser errors. [Compact six-scene results](inspector-missions/mission-results.json) retain source/body counts, selected identity, surface status and errors.

| Catalog | Additional mission/user anchors | Observed navigation surface |
| --- | --- | --- |
| MoonFall/Shackleton | Explicitly fictional base/PSR waypoints | Terrain |
| LRO/Moon | None | Terrain |
| Apollo 15 imagery | NASA NSSDCA landing coordinates, accuracy unknown | Terrain datum |
| MSL/Dingo Gap | Existing approximate overlay anchor, not rover landing | Reference-shape fallback |
| Ingenuity/Jezero | Vendored NASA/JPL MMGIS airfields; areoid height omitted | Reference-shape fallback |
| Jezero imagery | None | Reference shape |

Imported datum/geodetic coordinates convert to planetocentric before the actual scene resolver. Terrain readiness alone does not establish a supported physical height sample. No surveyed accuracy, native coverage or unknown height transform is manufactured.

MoonFall's 20 km polar/night view showed terrain streaking and no ordinary labels. The same direct navigation against the original `f66508b` catalog, with **zero Places records**, reproduced it: [original baseline](inspector-missions/moonfall-before-places.png), [with Places](inspector-missions/moonfall-shackleton.png), [baseline state](inspector-missions/moonfall-before-places-results.json). This is a retained pre-existing rendering limitation; artifact-free polar terrain is not claimed.

## Terrain label anchoring and close-range review

[Terrain findings, GPU results and selected close/oblique captures](label-review.md#terrain-label-anchoring) document the Sakarya fix, supported physical-sample fallback and the distinction between rendered presentation and scientific elevation. The cleanup retains those findings and assertions without committing per-frame arrays or video.

## Label-motion review: collision exits and fade-aware acceptance

Addresses [review 6374449480](https://github.com/AaronPlave/cosmolabe/pull/274#issuecomment-6374449480). [Diagnosis](label-review.md#label-motion-failure-diagnosis) records viewport-edge re-entry, padding-only collision fade loss and the fade-completion false positive. [Hardware/SwiftShader summaries](label-motion-review/summary.json) retain phase measurements. The **1.25×** threshold, visible/accepted-run limits, collision/overlap and picking tests remain unchanged by cleanup.

## Validation and evidence policy

Before cleanup, exact-head [CI 40026754690](https://github.com/AaronPlave/cosmolabe/actions/runs/40026754690) passed all five jobs at `43db339`; see [CI evidence](README.md#ci-evidence). Local focused label validation passed 50 renderer files / 507 tests and four acceptance-helper regressions. Viewer framing/source checks passed 42 files / 550 tests. Historical counts describe those runs, not newly executed cleanup-head tests.

[Reproduction commands](README.md#reproduce) generate the complete traces and optional video in ignored working storage; the existing targeted/nightly workflows upload their normal `/tmp` output. Historical local recordings and superseded repeated screenshots were removed. Artifacts have finite retention, so commands are the durable reproduction path. Physical-phone and independent human acceptance remain unclaimed.
