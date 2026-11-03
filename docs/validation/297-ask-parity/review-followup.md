# November 2 Ask acceptance corrections

This addresses reviews [6586543808](https://github.com/AaronPlave/cosmolabe/pull/334#issuecomment-6586543808)
and [6587178052](https://github.com/AaronPlave/cosmolabe/pull/334#issuecomment-6587178052)
in the same PR. No solver, provider routing, query budget or camera coordinate
model is replaced.

The natural Ingenuity follow-up is now inspected immediately after `can you place
a point then`. It must create/select exactly one approved feature using the
pin-to-Draw conversion already delivered to the conversation. The test checks
that the existing pin epoch/direction remain and that no second pin or feature
is created. There is no third coaching prompt. The updated
[spatial evidence](spatial-acceptance.json) and [screenshot](ground-pin-panel.png)
replace the earlier two-feature acceptance. A probe read from the preceding turn
is valid evidence; the harness does not force a redundant read.

The styling scenario explicitly requests elevation as the final base color and
HiRISE enabled separately for later imagery use. Fixed and Discovery must both
report `baseColor: elevation`, `palette: blue-gold`, `hillshade: true`, and the
highest-resolution managed imagery layer enabled. Enabling a layer does not
imply it controls the final base color or that every tile has loaded. The two
previous styling rows in [acceptance.json](acceptance.json) are replaced by these
stronger executions. Genuinely conflicting final-color requests still need
clarification; the setter does not silently override a different explicit mode.

`getEventResultPage(..., {order: 'range-ascending'})` compares **every measured
candidate in the completed run before paging**. It returns `ranking.compared`
and preserves exact run references and truthful `nextOffset`. Missing measured
ranges refuse ranking. The ordinary chronological order remains available for
inspection. A six-candidate deterministic fixture places the smallest range at
chronological index 3 and verifies pagination after ranking and stale-reference
refusal. The real Haiku Cassini case also compares 484 local minima and selects
index 190, providing independent coverage beyond a synthetic first-result case.
The agent clamps only read-only page limits to five; mutation arguments retain
strict validation. Compact registry inputs now include types/enums and identify
the complete JSON run-reference contract, avoiding a bare-ID presentation retry.

`presentEventResult(reference, 'pair' | 'target')` is a shared typed/script/Ask
operation over native Event Finder focus, clock pause, existing camera framing
and orbit-target ownership. Pair framing refreshes poses after floating-origin
changes and fits the two actual scene positions and body extents with room for the standard side panels. It does not
alter scientific coordinates or scale one body independently. The default is
pair; target is an explicit fallback intent when a pair cannot be shown. Missing
meshes or unsupported framing refuse rather than claiming success. Low-level
`focusEventResult` remains available without framing.

Presentation waits at most 1.5 seconds for a current native observation. A scene,
run, selected event, clock or manual-camera change cancels the continuation;
there is no delayed camera/time reassertion. Tests exercise manual input and
manual seek during this wait. Readback separates paused event selection, tracked
object/reference, projected participant centers, enabled native body groups and
native event draw observations. Projection and draw-enabled counts do not prove
unoccluded pixels. Query-save and search-completion receipts now verify their
actual domain postconditions separately from partial native geometry. Ordinary
frame operations verify the resulting tracked object and finite camera pose;
that observation also does not prove pixel visibility.

Final default Fixed Ask used the exact Voyager and Cassini prompts, actual Ask
panel approvals, public catalogs and the existing provider. Independent public
viewer reads compare the selected range against all completed candidates,
verify exact paused epoch/run reference, and check both native projected centers
inside the view. The answers identify the actual searched window, now supplied
in ET and calendar dates (including each event UTC timestamp, so the model need not hand-convert ET), and retain loaded-kernel/correction/step limits.
Screenshots were visually inspected by the coding agent; this is not a claim of
an independent human smoke test. The PR remains unmerged for that requested check.

See [compact current evidence](review-acceptance.json),
[Voyager](voyager-encounter.png), [Cassini](cassini-encounter.png), and the
[point screenshot](ground-pin-panel.png). Raw model dumps remain local. Estimates
are not billing; cache warmth is uncontrolled. The final Haiku smoke completed in eight model calls / 100,041 processed tokens, with one corrected coverage-window refusal (no schema or page-limit refusals), and reported both actual searched boundary dates. Saved-query receipts now also return the inspected availability/coverage so an unsupported window can be corrected before a run. This improves on the prior 12-call / 166,692-token run without claiming a fixed round or cost guarantee. The Haiku smoke uses the same
150,000-token pre-request admission threshold, without raising call limits.

Validation: 55 viewer files / 754 tests; 14 control files / 194 tests. Configured
TypeScript and Svelte checks (zero warnings), changed-file ESLint, purity, registry
coverage (108 operations), and production/embed/declaration builds pass. Exact
remote-head CI is checked after publication and remains required before merge.

Replay with explicit public-scene provider authorization and an owned viewer
configured with `VITE_ASK_ENDPOINT=http://127.0.0.1:8798`:

```sh
ASK_MISSION_LIVE=1 ASK_SCENARIOS=voyager,cassini ASK_MODES=fixed node scripts/test-ask-modern-scene.mjs
ASK_MISSION_LIVE=1 ASK_SCENARIOS=ingenuity ASK_MODES=fixed,discovery node scripts/test-ask-modern-scene.mjs
ASK_MISSION_LIVE=1 ASK_SPATIAL_CASE=ground-pin node scripts/test-ask-spatial-points.mjs
```
