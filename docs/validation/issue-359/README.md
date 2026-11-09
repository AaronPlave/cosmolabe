# Issue #359 / PR #363 validation

The complete eight-case Haiku transfer control passed on production source **`7850fb4d`**. The subsequent evidence commit changes only this document. PR #363 remains draft; no merge or readiness transition was performed. These are smoke controls, not a statistical reliability benchmark.

## Analytical boundary

`events.findClosestApproach` composes the existing coverage inspection, query configuration, Event Finder, complete candidate ranking and native presentation. The model chooses the pair and temporal scope; it no longer needs to orchestrate those implementation steps. Granular controls remain available. No solver, generic planner, mission-specific branch, kernel repair or contact analysis was added.

`windowMode` explicitly selects `coverage` for an unqualified question or `interval` for a requested phase/date, with both UTC or ET endpoints. An interval is never silently clipped or bridged across a gap. Unknown coverage remains unassessed, not evidence of absent data. Bounds are four assessed windows, one million total search steps, and a shared 30-second native search allowance. A task permits one correction after a confirmed no-search preflight rejection (two rejected preflights maximum), but cannot rerun an executed pair with changed bounds; the known frame error also closes its Event Finder path.

A known missing frame can return a distinct 32-point center-distance alternative for one contiguous interval. It uses the existing native profile sampler. Automatic seeking/framing requires an explicit interval of at most one day, spacing at most 15 minutes, zero gaps/missing samples, and finite samples on both sides of the minimum. This is a conservative presentation policy, not a scientific accuracy guarantee. Broad/coarse/boundary-minimum traces remain exploratory without changing clock, playback or camera. After any sampled alternative, the same Ask request cannot add granular camera/time changes: this prevents both coarse-navigation bypass and a redundant UTC seek rounding away the returned ET. A new user request resets that guard. `sampledEpochSelected` reports actual navigation. The compact model payload contains actual interval/count/gaps/units/extrema and a distinct sampled-view observation; the granular data API still returns every sample. `computedEventVerified` stays false. The actual failed attempt binds the event goal even if an older event remains selected; successful seeking/framing never certifies it. Sampled clock/pause predicates are held only after actual navigation. No-search goal placeholders can bind to a corrected search without changing closest/encounter requirements or a person-named query. Equivalent queries/profiles created by this operation reuse unchanged native items per host/scene; edited or authored items are never overwritten or deleted. Manual takeover and scene reload still win.

`answer-check.ts` now grounds sampled distances and epochs without requiring an `event-result`: kilometre/metre/AU claims, dates, ISO clock times and ET claims are compared to published facts, with rounding tolerance. Tests reject fabricated `999 km`, wrong dates/times, negative ranges and unsupported AU claims. Explicit steady/monotonic claims are also checked against reversals in returned samples, allowing 1% numerical variation. One existing answer correction runs; persistent contradiction uses the host's numerical summary. This is a contradiction check for supported numeric forms, not a proof of arbitrary prose.

The earlier direct commits' frame classification and receipt semantics remain. Their loop-level recovery counter/global retry block were replaced at the tool boundary, regressions were corrected/extended, and the generic exhaustion answer was replaced with actual published facts. There is no new recovery-round framework.

## Natural-language evidence

All cases used `claude-haiku-5-5` for normal and escalation requests, fallback disabled, fixed Ask routing, and output capped at 1,536 tokens. Raw processed tokens include cache reads/writes; cache warmth was uncontrolled. Each case had a fresh scene/conversation. The renderer was Chromium SwiftShader, not a physical-GPU control.

| Natural question / control | Observed outcome and presentation | Rounds / tokens |
| --- | --- | --- |
| When did Cassini get closest to Titan? Show me | Computed 3,601.5 km range at 2005-04-16 19:11:45 UTC; actual event/run/epoch, framing and drawing verified | 3 / 33,330 |
| Exact Philae landing question; test worker dependencies furnished | Computed ~2.39 km center distance at 2014-11-12 15:34:03 UTC; actual event/run/epoch and native presentation verified | 3 / 31,158 |
| Exact Philae landing question; normal missing frame | Qualified 32-sample minimum; native trace observed, no encounter seek/framing; computed-event goal remains unmet | 6 / 73,088 |
| How did Philae's distance change during descent? | Grounded 32-point history over the model-chosen 08:35:42–15:33:52 UTC interval, ~22.6 to ~2.40 km; profile configured visible, native drawing not observed, clock/camera unchanged | 7 / 100,941 |
| When was Rosetta closest to Earth? | Only a coarse 32-point alternative over 2004–2016, minimum 7,793 km at the first point; no automatic seek or verified event | 4 / 41,747 |
| When did Philae first touch down? | Catalog-authored Agilkia date, 2014-11-12; no exact time inferred or computed contact claim; no navigation requested | 2 / 19,078 |
| When were Philae and Earth closest during 1980? Show me. | Structured missing coverage, no search execution, profile substitution or navigation | 3 / 30,705 |
| Find the smallest distance between Cassini and Saturn in the loaded data and show it. | Held-out pair: computed ~80,246 km range at 2004-07-01 02:38:22 UTC; actual event/run/epoch and native presentation verified | 4 / 41,120 |

The exact prompt was **“When did Philae get closest to comet 67P during its landing? Show me.”** In the failure case the chosen interval was 2014-11-12 08:00–18:00 UTC, with 32 samples, 1,161.2903-second spacing and zero missing samples. Its minimum was **2.4470415658470572 km at ET 469079138.1517419 / 15:44:30 UTC**. Independent point evaluation agreed. Because this trace exceeds the navigation-spacing policy, the viewer retained its epoch/camera. Subsequent granular framing attempts were refused, and the answer disclosed that the event was not selected and 67P was not in view. The native profile trace was observed. This is useful exploratory data, not a verified closest approach or touchdown.

Compared with the earlier same-question controls, routine computed Philae orchestration fell from 8 rounds / 101,862 tokens to 3 / 31,158; missing-frame recovery fell from 10 / 146,069 to 6 / 73,088. These individual measurements do not guarantee future cost. History remained relatively expensive, and its chosen endpoints are not an independently established full descent phase. A configured-visible profile is not proof it was drawn; that history case has no native trace observation.

Computed searches use the default one-hour step and assessed catalog/kernel overlap. The held-out Cassini–Saturn scope was 2004-01-02 to 2005-04-07, not an all-time or outside-catalog global minimum. Coarse Rosetta–Earth samples do not locate a real encounter. Physical DSK/mesh clearance/contact remains unsupported here.

The computed Philae success control furnishes existing catalog frame/attitude dependencies only in its test browser and disables window kernel pruning there. Production worker dependencies and Rosetta's intentional `-226000` bus-origin identity are unchanged: #361 owns that repair. #360 owns physical surface/contact analysis. Authored viewpoints remain distinct annotations; null terrain metadata never establishes absent DSK geometry.

Earlier attempts exposed a genuine granular-navigation bypass and a redundant UTC seek that shifted the exact sampled ET by 34 ms; both are now blocked. An explicit steady-trend claim contradicted a sampled rebound; the numerical checker now rejects that captured answer. Other attempts failed on overly prescriptive assertions (ISO-only dates, mandatory profile/trace reads or wording) and a terminated dedicated viewer causing connection refusals. Those attempts remain failed/inconclusive; they are not counted as final passes. The final full run exited zero with no provider/loading failures. Raw reports remain outside the repository.

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

**472 tests in 23 files pass**, including boundary composition, complete ranking, scoped UTC windows, unknown/missing coverage, other failures, old-selection isolation, numerical contradiction correction, takeover and reload. Package build, test/viewer typechecks, changed-source ESLint, 123-operation capability coverage, script syntax and diff checks pass. Exact remote-head CI is checked separately. No merge was performed.
