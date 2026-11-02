# Event Finder analysis-to-visualization acceptance

Integrated in PR #334, including the implementation originally reviewed in stacked PR #335, for the explicit P2 acceptance added to #297. This work
connects existing Event Finder/analysis, timeline, selection, rendering,
ViewState and capability operations. No event solver, geometry treatment,
workflow language, UI or provider integration is added.

| Acceptance | Implementation | Evidence |
|---|---|---|
| [x] Configure → run → inspect, typed/discoverable, bounded pages, windows/units/frames/provenance/coverage | `event-control.ts`, `contracts.ts`, `event-agent-metadata.ts`, generated `verbs.ts`/help | `event-integration.test.ts`, `viewer-control.test.ts`, real Cassini GF fixture |
| [x] Result → coordinated existing timeline, epoch, objects/highlights and 3D marker/span/geometry, explicit observed/partial | `focusEventResult`, `getEventVisualization`, native `EventMarkers.visibilityFor` / `UniverseRenderer.getEventVisualization` | Native draw-state/current-camera regression; `waitUntilReady({kind:"event",reference,et,policy:"native-draw"})`; ordinary/harness Cassini script-runner and actual Script panel wait → screenshot, selected lane, exact ET and draw-enabled glyph |
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
- [`ordinary.png`](ordinary.png): ordinary viewer capture.
- [`ordinary-script.png`](ordinary-script.png): image returned by the actual `screenshot` verb after the script’s bounded readiness wait; the Script panel Run control also produced a verified PNG download.
- [`ordinary.cosmo`](ordinary.cosmo): portable query/measurement/view definitions;
  deliberately no cached results or run revision.

Reproduce with a clean viewer on port 5397 and
`node scripts/test-event-visualization-integration.mjs` (`CL_VIEWER_URL` and
`CL_OUTPUT` override defaults). Full transient browser diagnostics are written
to `/tmp/event-visualization-integration`; they are not required runtime assets.

Validation on the combined implementation: viewer suite 54 files / 732 tests; focused control/native suites
146 tests, including targeted draw-state and metadata regressions; repository
`npm run typecheck`, changed-file lint, purity and diff checks. Production/embed
build results and remote CI are reported in the PR, separately from this
browser evidence. Both combined Ingenuity/Cassini fixtures passed on the owned checkout at port 5697. This validation does not merge or deploy PR #334.


Capture policy is explicit. `timeline` requires the exact selected result/run,
frozen requested epoch, visible timeline lane and matching native render pass;
`native-draw` additionally requires a draw-enabled selected glyph/span/active
explanatory geometry. Hidden or occluded geometry may stay partial and time out.
A changed reference/run/epoch is stale; unsupported native observation is
unavailable. Neither policy promises unoccluded pixels or calibrated observations.
The script wait never seeks, frames or restarts searches. Unit/adapter tests prove
abort, timeout and stale results stop before capture, with no leaked wait timers.
Camera/viewport changes invalidate the native observation until another pass.
