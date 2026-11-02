# Event Finder analysis-to-visualization acceptance

Follow-up to PR #334 for the explicit P2 acceptance added to #297. This work
connects existing Event Finder/analysis, timeline, selection, rendering,
ViewState and capability operations. No event solver, geometry treatment,
workflow language, UI or provider integration is added.

| Acceptance | Implementation | Evidence |
|---|---|---|
| [x] Configure → run → inspect, typed/discoverable, bounded pages, windows/units/frames/provenance/coverage | `event-control.ts`, `contracts.ts`, `event-agent-metadata.ts`, generated `verbs.ts`/help | `event-integration.test.ts`, `viewer-control.test.ts`, real Cassini GF fixture |
| [x] Result → coordinated existing timeline, epoch, objects/highlights and 3D marker/span/geometry, explicit observed/partial | `focusEventResult`, `getEventVisualization`, native `EventMarkers.visibilityFor` / `UniverseRenderer.getEventVisualization` | Native draw-state regression; loaded ordinary/harness Cassini scene, selected lane, highlighted bodies, exact ET and draw-enabled glyph |
| [x] Compose and preserve portable definitions; report transient result limits | Existing camera/measurement/layer/caption actions; query snapshots; existing ViewState v1 rerun + unique times/state match | Snapshot → parse → execute preserves definitions and returns not-searched; restored v1 view recomputes with new run identity; saved `.cosmo` and screenshot |
| [x] Trustworthy failure/interruption and host boundaries | Run references include scene/query/result/batch; shared batch freshness checks; structured query/page/focus refusal; existing effect/authoring policy | Rerun/edit/kernel replacement/reload, missing/disabled query, missing result, empty page, no renderer/hidden lane, abort, supersession and manual time/camera preservation; metadata privacy/host-omission regressions |
| [x] One real scripted end-to-end workflow plus missing coverage/cancellation | `scripts/test-event-visualization-integration.mjs` uses public control + parse/execute in an already implemented closest-approach kind | Both ordinary and `?test=1` viewers passed on Apple M4 Max / ANGLE Metal; no model/provider request or arbitrary settling sleep |

The real search uses Cassini/Saturn, LT+S, step 60 s, window
`[141912064.184, 141955264.184]` ET. The current loaded kernels return the
closest approach at ET `141921566.6511854`; this is evidence for that loaded
catalog/kernel set, not a universal event epoch. Native event metrics include
reference-ellipsoid altitude and centre distance; the separate measurement is
labelled centre distance. Rendered event geometry remains explanatory.

The receipt distinguishes a registered marker group from a draw-enabled glyph.
The spacecraft close-up occludes its event glyph and correctly remains partial;
framing Saturn yields the observed marker used by this capture. Counts do not
establish visible pixels, observational calibration or source accuracy.

Recorded evidence:

- [`acceptance.json`](acceptance.json): compact actual state and adverse outcomes.
- [`ordinary.png`](ordinary.png): actual ordinary viewer capture.
- [`ordinary.cosmo`](ordinary.cosmo): portable query/measurement/view definitions;
  deliberately no cached results or run revision.

Reproduce with a clean viewer on port 5397 and
`node scripts/test-event-visualization-integration.mjs` (`CL_VIEWER_URL` and
`CL_OUTPUT` override defaults). Full transient browser diagnostics are written
to `/tmp/event-visualization-integration`; they are not required runtime assets.

Validation: viewer suite 54 files / 729 tests; focused control/native suites
146 tests, including targeted draw-state and metadata regressions; repository
`npm run typecheck`, changed-file lint, purity and diff checks. Production/embed
build results and remote CI are reported in the PR, separately from this
browser evidence. The P2 follow-up does not merge or deploy PR #334.
