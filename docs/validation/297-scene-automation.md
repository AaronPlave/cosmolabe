# Scene automation validation (#297)

UI, scripts, trusted hosts and Ask use the same `ViewerControl` operations,
semantic models and native solvers/renderers. The public operation/effect contract
is deliberately listed in `scripts/ask-capability-contract.json`; it is not a
serialized run report. [check-ask-capability-coverage.mjs](../../scripts/check-ask-capability-coverage.mjs) checks that manifest
against registration, script routing, discovery, permissions and every typed
control member. Its source-registry regression runs in standard PR CI.

## Acceptance and runnable coverage

Paths below are relative to the repository root. Unit suites run in standard PR
CI; standalone browser/provider scripts are **manual checks, not PR CI gates**.

| Contract | Maintained acceptance |
| --- | --- |
| Places: stable scene-scoped identities, exact/ambiguous/missing resolution, native navigation | [viewer-control.test.ts](../../apps/viewer/src/lib/__tests__/viewer-control.test.ts) |
| Measurements/geographic features: shared CRUD, selection, styles, frames, validation, undo, notifications; opening/clearing measurement editor | [viewer-control.test.ts](../../apps/viewer/src/lib/__tests__/viewer-control.test.ts), [spatial-measurements.test.ts](../../apps/viewer/src/lib/__tests__/spatial-measurements.test.ts), [geographic-editing.test.ts](../../apps/viewer/src/lib/__tests__/geographic-editing.test.ts), [test-modern-scene-automation.mjs](../../scripts/test-modern-scene-automation.mjs) |
| Imagery/terrain: independent authority, availability, ordering, appearance, UI-to-host events | [viewer-control.test.ts](../../apps/viewer/src/lib/__tests__/viewer-control.test.ts), [surface-appearance-pick.test.ts](../../apps/viewer/src/lib/__tests__/surface-appearance-pick.test.ts), [SurfaceObservation.test.ts](../../packages/three/src/__tests__/SurfaceObservation.test.ts) |
| Readiness: fresh drawn-surface/geometry observations, bounded wait, timeout/cancel, source failure, reload/disposal | [readiness-control.test.ts](../../apps/viewer/src/lib/__tests__/readiness-control.test.ts), [TerrainViewCoverage.test.ts](../../packages/three/src/__tests__/TerrainViewCoverage.test.ts), modern-scene browser check |
| Activities: catalog-backed list/filter/select/seek/navigation and timing/provenance | [viewer-control.test.ts](../../apps/viewer/src/lib/__tests__/viewer-control.test.ts), Ingenuity analysis tour in [ingenuity-analysis-tour.cosmo](../../apps/viewer/test-catalogs/ingenuity-analysis-tour.cosmo) |
| Event Finder: configure/run/progress/cancel, bounded result pages, exact run references, timeline/native draw observations | [event-integration.test.ts](../../packages/control/src/event-integration.test.ts), [viewer-control.test.ts](../../apps/viewer/src/lib/__tests__/viewer-control.test.ts), [test-event-visualization-integration.mjs](../../scripts/test-event-visualization-integration.mjs) |
| Sensors: physical pointing distinct from observation freshness and render failure; no playback blackout, true missing-attitude recovery | [InstrumentObservation.test.ts](../../packages/three/src/InstrumentObservation.test.ts), [test-instrument-playback.mjs](../../scripts/test-instrument-playback.mjs) |
| Point Probe: replacement invalidates draw receipt; clock ticks preserve last observed epoch; physical/reference/rendered surfaces distinct | [SemanticSurfacePoint.test.ts](../../packages/three/src/SemanticSurfacePoint.test.ts), [spatial-control.test.ts](../../apps/viewer/src/lib/__tests__/spatial-control.test.ts) |
| Portable state: snapshot → parse → execute into populated scene, bookmark/order replay, v1 restore, wrong-catalog refusal | [modern-scene.test.ts](../../packages/control/src/modern-scene.test.ts), [snapshot.test.ts](../../packages/control/src/snapshot.test.ts), [viewer-control.test.ts](../../apps/viewer/src/lib/__tests__/viewer-control.test.ts), modern-scene browser check |
| Agent parity/privacy: all verbs registered/classified, exact schemas and effects, host policy, destructive/external confirmation, bounded allowlisted metadata | [agent.test.ts](../../packages/control/src/agent.test.ts), [capabilities.test.ts](../../packages/control/src/capabilities.test.ts), [ask-capability-contract.test.mjs](../../scripts/ask-capability-contract.test.mjs), [geographic-agent-metadata.test.ts](../../packages/control/src/geographic-agent-metadata.test.ts) |
| Ask UI: progress, approvals, safe collapsed disclosures, catalog switch clears stale selection | [test-ask-status-ui.mjs](../../scripts/test-ask-status-ui.mjs) (provider-free fixtures); [answer-text.test.ts](../../apps/viewer/src/lib/__tests__/answer-text.test.ts) |
| README Event Finder capture uses public query/measurement/timeline controls | [capture-readme-media.mjs](../../scripts/capture-readme-media.mjs), [media recipe](../readme-media.md) |

## Repeat locally

```sh
npm run typecheck
npm test -- --exclude scripts/surface-build.test.mjs
npm run lint
npm run lint:purity
node scripts/check-ask-capability-coverage.mjs
npm --prefix apps/viewer run build
```

Run a viewer from this checkout, verify listener ownership, then run browser checks
sequentially so their GPU/data loads do not interfere:

```sh
npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5797
# In a second terminal:
export CL_VIEWER_URL=http://127.0.0.1:5797/
node scripts/test-modern-scene-automation.mjs
node scripts/test-event-visualization-integration.mjs
node scripts/test-instrument-playback.mjs
node scripts/test-ask-status-ui.mjs
```

Install Playwright Chromium if needed (`npx playwright install chromium`). These
checks use installed Chrome/Metal on macOS when available and Playwright Chromium
with SwiftShader elsewhere. `CL_CHROMIUM` overrides the executable; `CL_GPU=software`
requests SwiftShader. Record actual GPU/device evidence when claiming hardware
rendering; software success does not establish physical GPU behavior. Mission data
and configured hosted surface products must be reachable.

Browser outputs stay in `/tmp` by default. Set `CL_OUTPUT` per mission/event/
instrument run, or `ASK_STATUS_OUTPUT` for the UI fixture. Reports, screenshots,
script-produced captures and snapshots are generated outputs, not checked-in test
inputs. `CL_MODERN_MODES=cassini` selects a targeted modern-scene repeat; the default
still runs ordinary, harness and Cassini. A subset pass is not a full-suite pass.

Optional paid-provider checks remain separate: `test-ask-modern-scene.mjs` exercises
mission/event/style/instrument/authoring workflows in Fixed and Discovery modes;
`test-ask-spatial-points.mjs` checks point/projection follow-ups against native
coordinates. They retain distinct assertions, require `ASK_MISSION_LIVE=1`, a
configured provider key and viewer endpoint, and write to configured `ASK_*_OUTPUT`
or `/tmp`. Run only with explicit authorization to send public fixture metadata
and incur provider usage. They are not repeatable paid-provider CI gates; broader
multi-turn reliability and benchmarking belong to #345.

## Scientific and validation limits

- Sensor feeds are synthetic scene views, not calibrated observations. Pointing
  describes the last observed frame; `observedEt`, `fresh` and `renderError` remain
  separate. Missing state/attitude retains its real reason. A new probe cannot be
  `drawn` until observed. Draw-enabled markers/counts do not guarantee unoccluded
  pixels; deterministic event capture requires the explicit requested epoch/view.
- Imagery residency, actual drawing, product-footprint geometry coverage, target
  LOD and source accuracy are separate claims. No arbitrary-region or whole-body
  coverage is inferred. Strict readiness stops capture on failure/timeout/staleness.
- Mission activity/path timing retains catalog estimates and provenance. Centre
  distance is not terrain clearance; reference/rendered surfaces are not physical
  terrain. Coordinate frames and imported data are not silently transformed.
- Snapshots preserve supported definitions and same-catalog state, not computed
  event caches, run references or private/local resource payloads. Recompute
  Event Finder results after restore and inspect fresh references.
- Latest dedicated Cassini/Clipper instrument playback checks passed at 1x/30x,
  including seek/pause/resume, sensor changes and controlled missing attitude.
  The full modern-scene run passed ordinary Ingenuity but its separate harness
  timed out waiting for streamed imagery to draw; a targeted Cassini repeat passed.
  That full run is **not** counted as passing. Its readiness predicate is unchanged.
  Current-head CI and any newly executed manual checks are reported on the PR.
