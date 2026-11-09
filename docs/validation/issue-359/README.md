# Issue #359 / PR #363 validation

PR #363 remains **draft / hold merge**. Numerical readback and the composed analytical operation are implemented and locally checked. The complete final-head live transfer gate is **not established**: repeated controls encountered cold-scene load deadlines, model-service HTTP 502s, and requests that did not settle within the harness deadline. Those runs are failures/inconclusive, not passes.

## Analytical boundary

`events.findClosestApproach` composes the existing coverage inspection, query configuration, Event Finder, complete candidate ranking and native presentation. The model chooses the pair and temporal scope; it no longer needs to orchestrate those implementation steps. Granular controls remain available. No solver, generic planner, mission-specific branch, kernel repair or contact analysis was added.

`windowMode` explicitly selects `coverage` for an unqualified question or `interval` for a requested phase/date, with both UTC or ET endpoints. An interval is never silently clipped or bridged across a gap. Unknown coverage remains unassessed, not evidence of absent data. Bounds are four assessed windows, one million total search steps, and a shared 30-second native search allowance. A task permits one correction after a confirmed no-search preflight rejection (two rejected preflights maximum), but cannot rerun an executed pair with changed bounds; the known frame error also closes its Event Finder path.

A known missing frame can return a distinct 32-point center-distance alternative for one contiguous interval. It uses the existing native profile sampler. Automatic seeking/framing requires an explicit interval of at most one day, spacing at most 15 minutes, zero gaps/missing samples, and finite samples on both sides of the minimum. This is a conservative presentation policy, not a scientific accuracy guarantee. Broad/coarse/boundary-minimum traces remain exploratory without changing clock, playback or camera. After any sampled alternative, the same Ask request cannot add granular camera/time changes: this prevents both coarse-navigation bypass and a redundant UTC seek rounding away the returned ET. A new user request resets that guard. `sampledEpochSelected` reports actual navigation. The compact model payload contains actual interval/count/gaps/units/extrema and a distinct sampled-view observation; the granular data API still returns every sample. `computedEventVerified` stays false. The actual failed attempt binds the event goal even if an older event remains selected; successful seeking/framing never certifies it. Sampled clock/pause predicates are held only after actual navigation. No-search goal placeholders can bind to a corrected search without changing closest/encounter requirements or a person-named query. Equivalent queries/profiles created by this operation reuse unchanged native items per host/scene; edited or authored items are never overwritten or deleted. Manual takeover and scene reload still win.

`answer-check.ts` now grounds sampled distances and epochs without requiring an `event-result`: kilometre/metre/AU claims, dates, ISO clock times and ET claims are compared to published facts, with rounding tolerance. Tests reject fabricated `999 km`, wrong dates/times, negative ranges and unsupported AU claims. One existing answer correction runs; persistent contradiction uses the host's numerical summary. This is a contradiction check for supported numeric forms, not a proof of arbitrary prose.

The earlier direct commits' frame classification and receipt semantics remain. Their loop-level recovery counter/global retry block were replaced at the tool boundary, regressions were corrected/extended, and the generic exhaustion answer was replaced with actual published facts. There is no new recovery-round framework.

## Natural-language evidence

All inference below used `claude-haiku-5-5` for normal and escalation requests, fallback disabled, fixed Ask routing, output capped at 1,536 tokens. Raw processed tokens include cache reads/writes; cache warmth was uncontrolled. Chromium used SwiftShader, not a physical-GPU acceptance control.

The final atomic sampled path passed the exact prompt: **“When did Philae get closest to comet 67P during its landing? Show me.”** It took **5 rounds / 56,987 tokens**, compared with the previous **10 / 146,069**. The model selected 2014-11-12 08:30–16:00 UTC. The 32 samples (870.9677-second spacing, zero missing) returned **2.451742069646693 km at ET 469079196.2162581 / 15:45:29 UTC**. Independent point evaluation, native trace, exact seek, paused state and the returned pair-view observation agreed. The answer disclosed interval/count/spacing/gaps and denied a certified minimum, surface height or verified computed event. The event goal remained failed; both projected participant centers were in view. This is a sampled estimate, not touchdown.

The small transfer set produced the following useful controls during implementation. **Earlier passes are identified explicitly; they do not establish a clean full-set pass on the final hardened interface.**

| Natural question / control | Legitimate observed outcome | Rounds / tokens | Evidence limit |
| --- | --- | --- | --- |
| Cassini closest to Titan; show me | Computed result and exact native presentation | 4 / 42,281 | Earlier composed-operation control; final repeat inconclusive |
| Exact Philae prompt; dependencies furnished | Computed 2.382505840723018 km at 2014-11-12T15:34:03.978Z, exact event/run/epoch and native presentation | 4 / 43,316 | Earlier control; final repeat hit provider/load failures |
| Exact Philae prompt; normal missing frame | Qualified 32-sample estimate, seek and framing; computed goal unmet | 5 / 56,987 | Final atomic sampled implementation passed |
| How did Philae's distance change during descent? | Numerical profile, native trace and sampled change, with stated chosen interval | 5 / 69,158; another run 9 / 144,574 | Earlier controls; variable orchestration cost remains |
| When was Rosetta closest to Earth? | Only a coarse sampled alternative after frame failure; no verified event | 4 / 41,029 | Hardened interval/payload contract passed before the framing-only addition; 32 points over 2004–2016 do not establish the real closest approach |
| When did Philae first touch down? | Catalog-authored Agilkia date; no computed contact or precise time inferred | 2 / 18,815 | Annotation evidence only; no solver substitution |
| Philae and Earth closest during 1980; show me | Structured missing coverage; no profile substitution or invented result | 3 / 30,207 | Earlier transfer control; later provider failure is not a pass |
| Cassini–Saturn smallest distance in loaded data; show it | Computed ~80,246 km center range and exact native presentation | 3 / 28,669 | Held out from implementation design; earlier control, final repeats inconclusive |

The real worker success control furnishes existing catalog frame/attitude dependencies only in its test browser and disables window kernel pruning there. Production dependencies and the intentional Rosetta `-226000` bus identity are untouched: #361 owns that repair. #360 owns physical surface/contact analysis. Authored viewpoints remain separate annotations; null terrain inventory does not establish absent DSK geometry.

The evidence shows lower routine search orchestration in successful controls, not statistical reliability or universally low cost. The final full-set gate, including a clean final computed-success landing repeat, remains required before readiness. No reliability follow-up issue was created.

## Repeat and local checks

Start a dedicated viewer with `VITE_ASK_ENDPOINT=http://127.0.0.1:8797`. With the explicitly approved Haiku key and scene metadata authorization:

```sh
CL_VIEWER_URL=http://127.0.0.1:5202/ ASK_ANALYSIS_LIVE=1 caffeinate -i node scripts/test-ask-analysis-transfer.mjs
# Select one or more cases without changing their natural prompts:
ASK_ANALYSIS_LIVE=1 ASK_ANALYSIS_CASE=philae-success,philae node scripts/test-ask-analysis-transfer.mjs
# Earlier profile/configuration/clearance controls:
ASK_PROFILE_LIVE=1 node scripts/test-ask-timeline-profiles.mjs
```

The transfer harness awaits the ordinary Ask panel's `submitAsk` entry point, uses timer-based readiness polling, shares only the asset cache between fresh scenes/conversations, and independently checks call-ID-matched provider payloads, numerical values and native state. Failed/inconclusive cells exit nonzero. Raw provider/browser reports stay outside the repository.

**471 tests in 23 files pass**, including boundary composition, complete ranking, scoped UTC windows, unknown/missing coverage, other failures, old-selection isolation, numerical contradiction correction, takeover and reload. Package build, test/viewer typechecks, changed-source ESLint, 123-operation capability coverage, script syntax and diff checks pass. Exact remote-head CI is checked separately. No merge was performed.
