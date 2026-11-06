# Issue #359 acceptance

2026-11-05, PR #363. **Review fixes pass native browser acceptance and the Haiku-only rerun, including the unsupported-clearance negative response.**

2026-11-06 numerical read follow-up: `getProfileValue` and `sampleProfileData` expose the existing exact quantity evaluator/sampler and position provider to ViewerControl/scripts and discoverable Ask. Interval reads return at most 32 samples, actual ET/UTC, units, requested/effective windows, null gaps and finite sampled extrema. Native Rosetta checks compare every returned range directly to the loaded Universe positions and check that the maximum response fits the ordinary Ask output budget. Unit regressions cover all four quantities, clipping, missing positions, tie selection, count/parameter limits, stale scenes and unchanged viewer state. The height-extrema solver handles different metrics; this read only compares its returned samples, with no new solver.

Haiku-only exploration smoke: “show Philae's distance profile, tell me where the sampled center distance is smallest, and take me there” passed in 9 rounds. It first read 32 samples across the original timeline (2 missing), then 32 over ET 468000000–471500000 (none missing). The returned minimum was **2.4727981082705752 km at ET 469919354.83870965** (2014-11-22 09:08:07 UTC). The final reply reported 2.4728 km, explicitly distinguished center distance from surface clearance/first touchdown, and existing `setTime` used that exact ET. Serialized provider-bound samples, a separate exact point read, visible native trace, unchanged camera/selection/tracking/window and absence of competing solver/viewpoint navigation were checked. The API does not certify a global extremum or contact.

Diagnostic limits: the first larger response exceeded the existing model-result budget, so the shared bound is now 32. Another trial invented a narrow profile window; guidance now requires an explicitly requested restriction. The successful numerical reply described rounded near-equal values as a flat plateau and omitted the sample interval/count; final guidance now warns against inferred exact ties and asks for those limits. A clearance-only rerun correctly refused the unsupported plot without claiming absent geometry, but its accepted center-distance alternative skipped an explicit `getProfile` reread, so that full scenario failed the strict live harness despite an independently visible native trace. These individual smoke trials are not a reliability claim. Keep the PR draft pending final acceptance/review and CI; raw outputs remain outside the repository.

Live acceptance used the ordinary fixed Ask panel in the loaded Rosetta catalog, with both normal and escalation requests pinned to `claude-haiku-5-5`, provider fallback disabled, and no production routing/default changes. Every provider-reported model matched Haiku. Chromium used SwiftShader at 1400 × 900. The catalog was paused before requests; its original timeline window was preserved. Prompt-cache warmth was uncontrolled.

Final run:

| Request | Model rounds | Observed result |
| --- | ---: | --- |
| Show a distance profile between Philae and 67P in the timeline | 6 | One native `range` profile; correct pair, enabled and visible; matching serialized `getProfile` result delivered to the model |
| Not closest approach; I want the profile in the timeline | 3 | Same ID and native trace; no search or duplicate profile |
| Philae's height above 67P's physical surface | 4 | No profile/search created; stated that timeline profiles cannot show physical-surface height, without claiming absent geometry |
| Explicitly accept center distance instead, labeled as such | 10 | One native range profile with an honest center-distance/not-surface-height label |

All requests preserved camera position/target/up/FOV, epoch, playback, tracking, selection and timeline window. No Event Finder query ran. The default full-catalog trace has 856 samples, 29 missing; the model reported the gaps rather than certified clearance or complete coverage. Native timeline presence and trace visibility were checked independently from the model reply. The profile quantity/presence/visibility reads were checked in actual serialized provider-bound tool results, matched by tool-call ID. An accepted partial visualization was not retried and no window/epoch change was attempted in the final run.

Earlier acceptance incorrectly claimed absent surface geometry, despite an independent native check finding one loaded 67P DSK mesh with null terrain inventory. The review fix puts the inventory's scope limit in the surface read description, guide and returned summary: DSK/irregular mesh availability is not assessed, and null terrain does not establish absent geometry. A provider-wire regression preserves that limit. The rerun states the unsupported timeline capability without that absence claim. It also offered a numeric extrema calculation, which was not executed or validated here; #360 owns physical clearance calculations. The accepted alternative encountered a usage-notes refusal and released a stray event-search goal, but ran no search and did not retry an accepted mutation. These 23 Haiku-only rounds are one smoke trial, not a reliability benchmark.

The other two review fixes have focused regressions: availability probes use the intersection of profile and visible windows; native missing counts exclude intentional clipping. Nonoverlapping windows say coverage was not assessed. Disabled profiles remain in the timeline as compact manageable rows; Show re-enables them, and edit/remove stay accessible. Browser acceptance verifies a narrow window between the old coarse probe instants, then disabled edit/re-enable/delete.

Live testing also exposed a partial-result classification defect: a successfully configured, visible trace with sample gaps had been returned as an overall failed write. Its configuration postcondition remains a hard check; presentation completeness is now an internal soft state check that yields a partial receipt. Model goals cannot set that classification. Regressions verify that configuration mismatches still fail, while incomplete presentation stays partial.

Repeat native script/dispatcher/UI acceptance:

```sh
CL_VIEWER_URL=http://127.0.0.1:5199 node scripts/test-timeline-profiles.mjs
```

Repeat approved live acceptance (requires a configured `ANTHROPIC_API_KEY`; raw reports remain outside the repository):

```sh
VITE_ASK_ENDPOINT=http://127.0.0.1:8797 npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5200 --strictPort
ASK_PROFILE_LIVE=1 node scripts/test-ask-timeline-profiles.mjs
# Only the numerical exploration request:
ASK_PROFILE_LIVE=1 ASK_PROFILE_SCENARIO=explore node scripts/test-ask-timeline-profiles.mjs
```

Local checks after review fixes: package build, test/viewer/Svelte typechecks, changed-source ESLint and capability coverage pass; 1010 tests across the control package and viewer libraries pass. CI must be rechecked on the final remote head.
