# Issue #359 acceptance

2026-11-05, PR #363. **Functional acceptance passed; the physical-surface negative answer failed factual review. Keep the PR draft.**

Live acceptance used the ordinary fixed Ask panel in the loaded Rosetta catalog, with both normal and escalation requests pinned to `claude-haiku-5-5`, provider fallback disabled, and no production routing/default changes. Every provider-reported model matched Haiku. Chromium used SwiftShader at 1400 × 900. The catalog was paused before requests; its original timeline window was preserved. Prompt-cache warmth was uncontrolled.

Final run:

| Request | Model rounds | Observed result |
| --- | ---: | --- |
| Show a distance profile between Philae and 67P in the timeline | 7 | One native `range` profile; correct pair, enabled and visible; matching serialized `getProfile` result delivered to the model |
| Not closest approach; I want the profile in the timeline | 3 | Same ID and native trace; no search or duplicate profile |
| Philae's height above 67P's physical surface | 4 | No profile/search created; refused the unsupported quantity; **incorrectly claimed no terrain or surface model was loaded** |
| Explicitly accept center distance instead, labeled as such | 6 | One native range profile with an honest center-distance/not-surface-height label |

All requests preserved camera position/target/up/FOV, epoch, playback, tracking, selection and timeline window. No Event Finder query ran. The default full-catalog trace has 856 samples, 29 missing; the model reported the gaps rather than certified clearance or complete coverage. Native timeline presence and trace visibility were checked independently from the model reply. The profile quantity/presence/visibility reads were checked in actual serialized provider-bound tool results, matched by tool-call ID. An accepted partial visualization was not retried and no window/epoch change was attempted in the final run.

An independent native viewer check found one loaded 67P DSK mesh, while `getSurfaceData(...).terrain` was null. Null terrain metadata does not establish absent DSK/mesh surface geometry. Discovery now states that limit explicitly, but Haiku still made the absence claim in the final negative answer. This remains an answer-quality limitation; the functional negative result is not full factual acceptance. The live harness checks this separately and fails acceptance on that claim. Three bounded diagnostic/final trials used only Haiku; these are individual smoke trials, not a reliability benchmark.

Live testing also exposed a partial-result classification defect: a successfully configured, visible trace with sample gaps had been returned as an overall failed write. Its configuration postcondition remains a hard check; presentation completeness is now an internal soft state check that yields a partial receipt. Model goals cannot set that classification. Regressions verify that configuration mismatches still fail, while incomplete presentation stays partial.

Repeat native script/dispatcher/UI acceptance:

```sh
CL_VIEWER_URL=http://127.0.0.1:5199 node scripts/test-timeline-profiles.mjs
```

Repeat approved live acceptance (requires a configured `ANTHROPIC_API_KEY`; raw reports remain outside the repository):

```sh
VITE_ASK_ENDPOINT=http://127.0.0.1:8797 npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5200 --strictPort
ASK_PROFILE_LIVE=1 node scripts/test-ask-timeline-profiles.mjs
```

Local checks after the partial-outcome change: package build, test/viewer/Svelte typechecks, changed-source ESLint and capability coverage pass; 1005 tests across the control package and viewer libraries pass. CI must be rechecked on the final remote head.
