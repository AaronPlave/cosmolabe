# Issue #359 acceptance

2026-11-06, PR #363. The final Haiku-only exploration run passes the sampling-disclosure checks. The other four profile/correction/clearance scenarios passed during this review. These are individual smoke trials, not a reliability benchmark.

All live requests used the ordinary fixed Ask panel in the loaded Rosetta catalog, with normal and escalation requests pinned to `claude-haiku-5-5`, provider fallback disabled, and no production routing changes. Provider-reported models matched Haiku. Chromium used SwiftShader at 1400 × 900; cache warmth was uncontrolled. Raw reports remain outside the repository.

The final exploration request explicitly says “Philae's distance profile relative to 67P” so a fresh conversation does not default to the tracked Rosetta spacecraft. In **8 model rounds**, Ask created the native range trace, read 32 actual samples, reported **2.473 km at 2014-11-27 17:00:48 UTC**, and sought ET **470379716.12903225** through existing `setTime`. The actual returned minimum was **2.472798109264723 km**, the smallest finite value among those samples.

The reply named both effective interval endpoints, **2003-12-30 23:58:55 UTC to 2017-01-01 23:58:50 UTC**, and described the minimum as the smallest of **32 samples**, with two missing endpoints. It explicitly distinguished center distance from surface clearance/touchdown. This is not a certified global or continuous minimum. Authored touchdown viewpoints are separate annotations; physical-surface/contact analysis remains #360.

Acceptance independently verified the visible native trace, unchanged camera/selection/tracking/playback/timeline window, exact returned navigation ET, actual point value at that ET, and the complete serialized provider-bound numerical result. No competing solver, Event Finder query or authored-viewpoint navigation ran. The bounded read has 32 samples with 2 missing; the native pixel-density trace separately has 856 samples with 29 missing.

The harness now requires both effective sampling endpoints (ET or UTC dates), the real sample count or correctly rounded step, and explicit limitation to the returned samples. It rejects the earlier “32 samples across the full window” reply. Numerical read summaries place the actual interval, count/spacing, gaps and sampled minimum together and explicitly request both endpoints in the final answer.

Profile state is verified independently in the native viewer. Provider-delivered supporting evidence may be a targeted read or a verified mutation receipt, including earlier evidence in the same conversation. A repeated `getProfile` call is not mandatory. Replaying the earlier accepted-alternative case without that call now passes on its actual delivered receipt; removing provider evidence still fails.

During this review the original profile request (6 rounds), correction (7), physical-clearance refusal (3), and explicitly accepted center-distance alternative (5) passed. The refusal made no absent-surface-model claim. Earlier inspection established a loaded 67P DSK mesh despite null terrain inventory; inventory nulls do not establish absent geometry.

Native/script/dispatcher acceptance also covers narrow-window clipping, disabled-row edit/re-enable/delete, shared identity, unsupported quantity refusal and direct comparison of returned numerical ranges to loaded Universe positions. Shared reads use the existing `quantityAt` / `sampleProfile`, preserve null gaps and state, and return at most 32 samples. There is no new solver or interpolation across gaps. Package build, typechecks, changed-source ESLint and the 122-operation capability gate pass; 169 focused viewer/control tests pass. Final-head CI must be checked separately.

Repeat native acceptance:

```sh
CL_VIEWER_URL=http://127.0.0.1:5199 node scripts/test-timeline-profiles.mjs
```

Repeat approved live acceptance (requires configured `ANTHROPIC_API_KEY`):

```sh
VITE_ASK_ENDPOINT=http://127.0.0.1:8797 npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5200 --strictPort
ASK_PROFILE_LIVE=1 node scripts/test-ask-timeline-profiles.mjs
# Only numerical exploration:
ASK_PROFILE_LIVE=1 ASK_PROFILE_SCENARIO=explore node scripts/test-ask-timeline-profiles.mjs
```
