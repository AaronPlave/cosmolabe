# Issue #359 / PR #363 validation

The latest multi-turn controls below ran on **`f8c9a5f8`**. PR #363 remains draft; no merge or readiness transition was performed. Individual controls establish the recorded behavior, not statistical reliability.

## Persistent conversation review

The blocking four-turn report was reproduced through the Ask textarea and Send button in one scene/conversation. Baseline `ba358a9a` applied authored viewpoints but could not verify them, changed the separation investigation into a minimum search, discarded the exact sampled ET, and sought a rounded UTC on the fourth turn. No camera-input events were observed in that reproduction; a false manual takeover was not reproduced.

The reusable fixes expose authored viewpoint ET/time/pose and bounded object existence, trajectory and geometry windows through ViewerControl/Ask. Viewpoint pose checks occupy one camera-goal slot; a newly requested view no longer leaves a different authored pose held. Existing history compaction retains bounded numerical evidence and exact ETs. Time readback reports requested/observed epochs and the recently measured bodies separately from event selection. Scene-existence differences are computed by the host, with a regression against a real erroneous “1 s later” answer (actual difference ~201 s).

Native viewpoint application also captured an old-origin mesh position as an orbit offset, moving the target on the next frame. The fix derives an authored tracked-origin offset in that origin's coordinates. A real-controller regression checks subsequent frames. Geometric composition now identifies stale placements and distinguishes model-bound overlap from established occlusion: a screenshot showed Rosetta visible while its solar-array bounding sphere had reported full occlusion. Such overlaps now remain unassessed; they are not hidden-pixel evidence. Unresolved aliases are refused with name candidates rather than evidence that a body is absent.

No recovery-round counter, additional planner/solver, provider default change or mission-specific prompt branch was added. The existing ten-round fixed-mode request limit, one answer correction, search/retry bounds and manual/scene-reload guards remain. A proposed extra pre-seek guide acknowledgement was removed after it needlessly disrupted ordinary clock operations; the useful context is returned with the seek instead.

### Final-source multi-turn UI control

`node scripts/test-ask-analysis-conversation.mjs` uses the normal Ask UI and tool route, not a scripted model or tool sequence. It loads a fresh scene/conversation per scenario, starts the clock paused for a stable initial state, and preserves that conversation for every listed follow-up. After each turn it records actual epoch, playing state, camera, selection, per-object labels/visibility, native event selection and profiles. Native distances are independently re-evaluated; model-delivered payloads are matched by call ID. Screenshots were inspected, not committed. Provider is Haiku only (`claude-haiku-5-5`), including escalation, fallback disabled; output cap 1,536, process guards 1.2 million processed tokens / $1 estimated cost. Chromium SwiftShader; cache warmth uncontrolled.

| Persistent interaction | Observed result | Per-turn rounds / processed tokens |
| --- | --- | --- |
| Exact Rosetta four-turn report | Both authored views actually applied at their exact ETs; numerical follow-up examined changing center range without running Event Finder; final request sought the exact prior sample ET and disclosed the separate Philae object's existence limit | 4 / 53,960; 4 / 50,823; 5 / 74,683; 3 / 40,050 |
| Huygens authored landing view → Cassini–Titan distance history → smallest sample | Authored Titan view applied and held; three actual point-state ranges compared; final epoch exact, Titan in frame, Cassini accurately reported outside it | 5 / 63,305; 2 / 22,905; 2 / 22,354 |
| Held-out Mars swing-by view → Rosetta–Mars distance history → smallest sample | Authored view applied; bounded profile data independently agreed; exact sampled epoch sought, with qualified analytical planetary occlusion rather than a claim both vehicles were visible | 4 / 52,074; 7 / 102,508; 3 / 41,557 |

All ten turn controls passed in the completed run: **39 rounds / 524,219 processed tokens**. No provider/loading failure occurred in this completed run. The exact Rosetta prompts were:

1. “show me when philae lander touched down on 67p”
2. “show me the moment rosetta and philae separated (for philae descent to 67p)”
3. “use a distance calc between rosetta and philae to figure it out”
4. “go to the min”

The first two epochs were `469078427.1826898` (authored 15:32:40 UTC) and `469053407.18268466` (authored 08:35:40 UTC). The configured separate-object/geometry transition at 08:35:15 UTC is a different scene fact. The history read 32 samples from 05:35:40 to 11:35:40 UTC (~696.8 s cadence), indicating growing center range between 08:29:51 and 08:41:28. This does not certify physical release. The last turn sought returned ET **`469053058.61290324`** exactly (~2.78 m sampled center range), before the separate Philae object's configured start at 08:35:15. The model reported that the independent object was not drawn then. This does not establish that the earlier combined Rosetta art model contains no lander geometry.

Limitations remain explicit: sampled transition brackets and minima depend on model-chosen windows/cadence; these are not certified events. Configured profile visibility can be partial and is distinct from observed drawing. Bounding spheres do not resolve model silhouettes. The Huygens annotation targets Titan; the catalog has no separate Huygens probe object. History requests remain comparatively costly (one held-out turn used 7 rounds / 102,508 tokens). The controls do not prove arbitrary conversational reliability.

Earlier attempts are not included as passes: they exposed omitted navigation, a coarse-minimum substitution for a transition, lost ET precision, stale pose/clock goals, incomplete visibility reporting, false absence from an unresolved alias, and the wrong relative existence time. One Cassini load timed out at 25/31 kernels before inference; a later complete run loaded successfully. A Git push also hit transient DNS failure and succeeded on retry. A harness assertion that prescribed a separate composition tool call was corrected to accept equivalent model-delivered composition in the seek result, independently checked against native state.

Validation on this runtime: **510 focused tests in 27 files**, control/three builds, test and Svelte typechecks, changed-source ESLint, 125-operation capability coverage, script syntax and diff checks pass.

The original closest-approach controls were also rerun on this source through `scripts/test-ask-analysis-transfer.mjs` (`ASK_ANALYSIS_CASE=cassini,philae-success,philae`). All three passed with no provider/loading failure: Cassini–Titan computed presentation **4 rounds / 48,095 tokens**; exact Philae question with test-only worker dependencies furnished **3 / 39,050**; the same exact question with the normal missing frame **4 / 56,004**. The latter read 32 samples from 08:35:40–16:00:00 UTC at 860 s spacing, zero missing, and sought the eligible sampled ET exactly; it explicitly could not confirm framing and retained the unmet computed-event goal. These additional controls do not replace the persistent conversations. The actual worker dependency repair still belongs to #361; physical surface/contact analysis remains #360.

CI on runtime source `f8c9a5f8`: [run 42654394208](https://github.com/AaronPlave/cosmolabe/actions/runs/42654394208). This evidence update changes only this document; exact final-head CI is tracked in the PR description.

## Earlier isolated controls (historical source)

The complete eight-case Haiku transfer smoke control passed on **`7850fb4d`**; these are historical results, not final-source multi-turn acceptance.

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
