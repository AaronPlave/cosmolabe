# Issue #359 / PR #363 acceptance

2026-11-06. Exact request: “When did Philae get closest to comet 67P during its landing? Show me.” Both controls use the regular fixed Ask panel and real Rosetta catalog. Normal and escalation requests are pinned to `claude-haiku-5-5`, fallback disabled. Chromium uses SwiftShader; cache warmth is uncontrolled. These are smoke controls, not a statistical reliability benchmark. Raw reports remain outside the repository.

## Audit of the handoff commits

- Retained `d37bcdb` / `c6b56b4` frame-error classification, while withholding raw solver text and scoping the alternative to closest-approach center distance.
- Retained `b1660a1` receipt classification: missing dependencies are partial failures, never successful computations.
- Replaced `2054d9e`'s loop-level Event Finder block and five-round recovery counter with a per-task tool guard. Changing query IDs cannot rerun the worker or create another search; direct tool consumers get the same protection. Unrelated failures do not set this guard.
- Retained and corrected `c0d57f0` / `c7315a1` regressions, including the fixture type that failed handoff CI run 42237267957. Added focused checks for normal success, other errors/kinds, manual takeover, reload, actual sampled navigation and truthful bounded answers.
- Replaced `d8e0d87`'s generic closest-approach exhaustion answer with the existing published-facts summary. At a step limit it reports actual numerical scope and gaps, preserves the stopped status, and does not certify an event or navigation.

There is no new planning framework. The loop retains its existing checks and one answer correction. Its small changes normalize namespaced operation aliases, report existing facts on a budget stop, and skip futile repairs of event predicates after a known missing dependency. Those predicates still report false; unrelated unmet goals still receive the ordinary repair. Camera/time takeover and scene reload remain authoritative.

Fixed Ask now explicitly requests **10 rounds**, discovery 20. Previously both exposed `listCapabilities`, causing the budget heuristic to give fixed mode 20 as well. Results retain the existing 6,000-character budget, with the existing larger schema-description allowance. Numerical reads remain 2–32 samples. There is no promise of a fixed token total or cheap inference: the final missing-frame trial still used **10 rounds / 146,069 raw processed tokens**, including cached tokens. It returns useful evidence instead of repeating the failed search. The proxy's separate token/cost guards remain in force.

## Exact-query controls

With the ordinary worker, one Event Finder run returns `missing-dependency`. Ask creates the native Philae–67P range trace, reads **32 samples** over **2014-11-12 00:00 to 2014-11-13 00:00 UTC**, with **0 missing**, and seeks ET **469108868**. The returned sampled minimum is **2.4727981065148414 km** at the interval end. The reply says this is only a sampled center-distance result, not computed closest approach, continuous coverage, surface clearance or touchdown. The original computed-event predicate remains false, even though the time change succeeds. This coarse sampling misses the smaller continuous result below; that is why its limits are material.

The success control furnishes catalog frame/attitude dependencies only inside its browser's worker and disables window kernel pruning there. Production furnishing and Rosetta's intentional `-226000` bus identity are untouched; #361 owns that repair. The real solver found **2.382505840723018 km at 2014-11-12T15:34:03.978Z** (ET **469078511.16268986**) in its declared window, 2014-11-11 23:59:59.816Z through 2014-11-12 23:59:59.816Z, `abcorr=NONE`, step 3,600 seconds. The reply reports 2.38 km, the smallest of three returned computed minima. This final success trial took **8 rounds / 101,862 raw processed tokens**. Ask presented that exact run reference and epoch with observed native event drawing; the request checked as verified. No sampled-profile substitute or authored touchdown viewpoint was used. Physical surface/contact analysis remains #360.

Acceptance checks the provider-delivered error and numerical payload, actual position-derived point value, requested/effective interval, sample comparison, exact navigation ET, native trace or computed-event selection/drawing, and the final answer. A missing gap disclosure gets one factual correction; persistent omission uses the published facts. No mandatory redundant `getProfile` sequence is imposed. Other failures and event kinds do not acquire an automatic distance substitution.

Earlier native/profile controls cover shared IDs, edit/hide/show/remove, disabled recovery, narrow-window clipping, exact values and null gaps. The previous explicitly sampled exploration and unsupported-clearance controls also passed; null terrain inventory never establishes absent DSK geometry. These older controls are separate from the exact landing question.

## Repeat

Start a dedicated dev viewer with `VITE_ASK_ENDPOINT=http://127.0.0.1:8797` on port 5200. With the explicitly approved provider key configured:

```sh
ASK_PROFILE_LIVE=1 ASK_PROFILE_SCENARIO=closest-failure node scripts/test-ask-timeline-profiles.mjs
ASK_PROFILE_LIVE=1 ASK_PROFILE_SCENARIO=closest-success node scripts/test-ask-timeline-profiles.mjs
# Earlier configuration/clearance/readback controls:
ASK_PROFILE_LIVE=1 node scripts/test-ask-timeline-profiles.mjs
CL_VIEWER_URL=http://127.0.0.1:5199 node scripts/test-timeline-profiles.mjs
```

Local build, test/viewer typechecks, changed-source lint, the 122-operation capability gate and **442 tests in 22 files** pass. Final-head CI is checked separately. No merge is performed by these controls.
