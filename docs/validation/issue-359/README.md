# Issue #359 / PR #363 validation

PR #363 remains draft; no merge or readiness transition was performed. The controls below establish the recorded behavior, not statistical reliability.

## Native UI / Ask execution parity review

Runtime source: `45ac4418`. The blocking review at `c22716ee` was valid: native UI/configured reruns used one 200,000-evaluation solver call, while the routine used by Ask allocated work per activity. Before the fix, the actual native **Find maximum** button exhausted 200,000 physical-terrain evaluations in **39.43 s**, producing only **12/72** candidates (11 numerically complete). Its best was Flight 10, ~12.18 m. The operation used by Ask produced all 72 candidates with 387,231 evaluations (140.43 s in that diagnostic). The ellipsoid control similarly returned only 13 candidates through UI versus all 72 through the routine. The faster UI result was not equivalent.

The Ask-only execution switch is removed. Activity requests now share scope filtering, source-knot-derived interval allocations, cancellation/progress and publication through `runAnalysis`, regardless of UI, routine, expert API or stored rerun. Existing limits remain 128 intervals, 200,000 per solver call and one million per collection; Flight 1's allowance was not increased. Empty/out-of-window/disabled restrictions remain effective. Unchanged configured reruns retain the full typed scope and explicit work cap, including disjoint windows; a form edit replaces that definition. The generated form also retains selected activity IDs. Event Finder no longer changes every interval's coverage to partial merely because a different interval has a numerical limit.

The repeatable [comparison harness](../../../scripts/test-trajectory-path-parity.mjs) uses fresh contexts, the same 1400×900 canvas/Events pane, 30 s ordinary renderer warmup, all 72 catalog flight IDs/windows, IAU_MARS, adaptive requested step 0.1 s and refinement tolerance 0.005 s. Both metrics use Mars's declared ellipsoid `[3396.19, 3396.19, 3376.2]` km and geodetic-normal height. Terrain pins `cube-fused-e7a6cf73d237-g2-m15-b66ee59ba`; its source accuracy remains unknown. Reports retain every window, actual spacing, per-flight evaluation count, datum/source, result and viewer state. No inference time is included in these numerical cells.

| Metric / path | Evaluations / terrain queries | Candidates / temporal complete / numerical complete | Wall time |
| --- | ---: | ---: | ---: |
| Physical terrain / native UI | 387,231 / 387,231 | 72 / 72 / 71 | 104.29 s |
| Physical terrain / Ask operation, without inference | 387,231 / 387,231 | 72 / 72 / 71 | 133.57 s |
| Physical terrain / stored native rerun | 387,231 / 387,231 | 72 / 72 / 71 | 99.26 s |
| Ellipsoid / native UI | 337,703 / 0 | 72 / 72 / 72 | 11.98 s |
| Ellipsoid / Ask operation, without inference | 337,703 / 0 | 72 / 72 / 72 | 11.40 s |
| Ellipsoid / stored native rerun | 337,703 / 0 | 72 / 72 / 72 | 10.32 s |

All per-flight result fields, including evaluation counts and qualifications, compare exactly across the three paths after excluding ephemeral IDs. Both native paths clicked the actual best result row and verified exact epoch, pause, selection and tracking. Physical clearance selects Flight 61 at ~24.018 m; ellipsoid height selects Flight 64 at ~−2.04024 km and is not a terrain substitute. Flight 1 still reaches 9,872 evaluations with a ~2.989 m partial candidate and no proven upper bound. No full-scope physical-height winner is established.

The 66,604 source records imply roughly 266,200 endpoint/quarter-segment probes under the existing solver policy before local refinement, already beyond the old total cap. All 387,231 evaluated terrain locations were distinct; exact point memoization would not remove these calls. No coarser search, discarded source knots, spatial quantization or new refinement framework was adopted: the measured fast UI path does not demonstrate an equivalent cheaper answer. This remains expensive shared physical analysis. All runs used ANGLE Metal / Apple M4 Max; OS scheduling and network/cache warmth remain uncontrolled. Earlier diagnostics ranged 78–186 s; these are observations, not a latency guarantee. The controlled six-cell run recorded at most a 52 ms main-thread task and 119.5 ms heartbeat interval.

The **exact natural-language prompt** below also passed through the ordinary Ask textarea/Send control on this runtime, **Haiku only**: **387,231 terrain queries; 82.20 s calculation; 88.70 s first terrain query through final answer/navigation; five rounds / 71,100 processed tokens**. Model-delivered tool payloads, all 72 candidates, rendered Event Finder coverage, exact ET and independent Cartesian height control passed. No task ≥50 ms was recorded; calculation/whole-turn maximum heartbeat was 49.8/72.5 ms and p95 frame interval 16.6 ms. The answer checker rejected scope/winner wording after the existing single correction, so the displayed answer used the truthful native fact summary. It explicitly compares 72/72, separates Flight 1's numerical limit and disclaims a global winner and telemetry accuracy. This run does not establish independent model-prose reliability.

The actual live **Stop** control passed after **61,214 terrain calls**: timeline stepping 120 ms, real camera drag and text input verified, Stop **146 ms**, cancelled status, zero published candidates and no new evaluations for 200 ms afterward. No task ≥50 ms was recorded; maximum heartbeat 86.1 ms; two Haiku rounds / 24,055 processed tokens. An initial live setup attempt had no Ask endpoint and stopped before inference; restoring the development endpoint resolved it.

Validation: **455 tests pass in 27 files; five optional external Cosmographia-fixture tests skipped**. Package builds, test/viewer/Svelte typechecks, changed-source ESLint, harness syntax and diff checks pass. `agent-loop.ts`, model routing, recovery rounds and scientific source data are unchanged by this review. Raw reports/profiles/screenshots remain temporary. To repeat numerical parity: `TRAJECTORY_PARITY_ASSERT=1 node scripts/test-trajectory-path-parity.mjs`; live completion/Stop use the existing responsiveness harness and its explicit Haiku opt-in, with the dedicated viewer's `VITE_ASK_ENDPOINT` pointing to the local proxy.


## Source epoch coverage review

Runtime source: `ead4699d`. The new endpoint audit is covered by a deterministic replay of all 72 real activity/XYZV pairs. The activity catalog preserves nominal ET seconds; `scripts/terrain/reconstruct_ingenuity.py` serializes `2451545 + ET / 86400` as a Julian date, and the XYZV parser decodes that binary64 value. At these dates its representable spacing is about 40.2 microseconds. All 55 previously partial endpoint cases encode to **exactly the same retained Julian date** as their source endpoint. This is serialization equivalence, not a calibrated clock or a new physical timing-accuracy claim.

The parser now retains that encoding evidence. Shared preflight/solver coverage assessment reconciles only outer endpoints with exact encoding equality, discloses each requested/source ET pair, and samples the unchanged intersection with source coverage. Interior gaps, endpoints without encoding evidence, and endpoints in different encoding cells remain gaps. No broad epsilon, time snapping, extrapolation, state fabrication or mission-specific runtime rule was introduced. A genuine 20-microsecond gap without encoding evidence remains partial in regression tests.

Native results and Event Finder separate temporal coverage, unavailable samples, numerical completeness, and source accuracy. The routine contract reports all 72 candidate intervals, **72 temporally complete at source encoding precision, zero meaningful temporal gaps, zero unavailable evaluated samples, and 71 completed numerical searches**. Flight 1 independently exhausts its local allowance of 9,872 evaluations (1,183 source records), returning a ~2.989 m candidate. It has no proven upper bound: it could contain a higher value. Accordingly `winnerId` remains null; the best available sampled candidate remains Flight 61, **24.018461853 m** at **2023-10-05T08:11:34.040Z**, with estimated-reconstruction and terrain/source accuracy limits intact. No numerical allowance was increased to obtain this result.

The exact natural-language Ingenuity prompt quoted below was rerun through the ordinary Ask UI with **Haiku only**, on **ANGLE Metal / Apple M4 Max**. All 72 actual candidates and the selected Flight 61 row were checked; the native Event Finder's rendered coverage details agree with the contract. The final answer explicitly says all 72 intervals were compared, distinguishes Flight 1's limit, reports the estimated reconstruction and avoids a confirmed maximum. Exact ET/pause/selection/tracking and the independent Cartesian height control pass. This final answer passed the existing typed answer boundary without native-fallback substitution.

Completion: **387,231 terrain queries; 78.90 s calculation; 85.81 s first query through final answer/navigation; no task ≥50 ms recorded; 42.7 ms calculation / 73 ms whole-turn maximum heartbeat; 16.6 ms p95 frame interval; five rounds / 72,993 processed tokens**. Timing does not include the later Event Finder inspection. Cache warmth and scheduling remain uncontrolled; these are single-run observations, not hard realtime guarantees.

Final Stop/control run: timeline stepping completed in **177 ms**, actual camera drag and Ask text input succeeded during computation, and the real Stop button completed in **264 ms** after **36,198 terrain calls**. No further evaluations started during the 200 ms post-Stop stability check; the turn ended cancelled. No task ≥50 ms was recorded, maximum heartbeat was **59 ms**, p95 frame interval **17.1 ms**; **two Haiku rounds / 23,979 processed tokens**.

Validation: **452 focused tests in 27 files pass; five optional external Cosmographia-fixture tests skipped**. Core/control/three builds, test/viewer/Svelte typechecks (zero Svelte errors/warnings), changed-source ESLint, harness syntax and diff checks pass. New regressions cover exact encoded endpoints, strict interior/unidentified gaps, sampling inside original coverage, real 72-flight source replay, independent numerical/sample failures, task-level winner eligibility and misleading completion prose. Only model-facing terminology changed in `agent-loop.ts`; its recovery-round logic is untouched.

An earlier completed trial still omitted the all-72 comparison despite correctly naming 71 numerical completions; the existing answer check was tightened and rerun. The interrupted environment lost a subsequent temporary browser/report, so it was restarted. The durable changes are source, focused regressions, this concise evidence and the existing repeatable harness; raw reports/profiles/screenshots remain temporary. PR stays draft/unmerged, with exact-head CI tracked in its description.

## Terrain-query responsiveness review

The exact new review prompt is **“show me the highest altitude (above terrain) that ingenuity got to and fly to ingenuity at that point in time.”** The original `2c9fe679` scene genuinely froze under the native 72-flight physical-terrain workload. This review is addressed in the same PR; the existing solver, numerical allowances, coordinate/frame identities and Ask loop architecture remain.

Point heights still intersect the Cartesian lattice along the geodetic normal. Exact cube-cell plane crossings replace repeated generic radial marching for this point query; finest ownership and closed seam/ancestor-boundary rules remain shared with ray queries. Mesh bounds reject unrelated triangle groups, and the resident-level index skips nonexistent levels. Analytical loading checks finest coverage along the normal and refuses missing grids instead of substituting a coarse parent or reference shape.

Elapsed CPU-time checks target 8 ms in the solver and analytical terrain work. Triangle scans and tile traversal expose cooperative checkpoints; cancellation reaches the actual terrain consumer, with checks after loads/yields and between bounded triangle chunks. Shared grid fetches may still complete for other consumers; cancelled analysis starts no more terrain evaluations. No new worker, solver, planner, recovery-round framework, scene branch or model routing default was added.

### Observed performance

Dedicated, ownership-checked viewers loaded the same Ingenuity catalog on **ANGLE Metal / Apple M4 Max**, with ordinary renderer activation warmed for 30 seconds. Original-head isolation reused unchanged scientific assets; its initial LFS-pointer texture setup failure was excluded. Cache warmth and operating-system scheduling were uncontrolled. CPU profiles/reports/screenshots remain private temporary artifacts.

| Workload | Longest main-thread task | Largest 20 ms heartbeat interval | Stop |
| --- | ---: | ---: | ---: |
| Original native workload, ten-second window | 1,434 ms | 2,838.8 ms | 1,101 ms |
| Fixed native workload, ten-second window | no task ≥50 ms recorded | 41.5 ms | 26 ms |
| Final exact-prompt UI calculation | no task ≥50 ms recorded | 41 ms | — |
| Final exact-prompt UI, through final answer/navigation | no task ≥50 ms recorded | 74.4 ms | — |
| Final UI interactions and Stop | no task ≥50 ms recorded | 78.2 ms | 205 ms |

The matched native CPU probes reduced `finestResident`/`march`/`discover`/`resident` from **82.0% to 3.3%** of sampled CPU hits. The final UI calculation performed **387,231 terrain queries** in **91.67 s**; first terrain query through final answer was **97.51 s**, with a **16.6 ms p95 frame interval**. This is responsiveness evidence, not a claim that dense physical analysis is instantaneous.

The normal Ask textarea/Send control used **Haiku `claude-haiku-5-5` only**, escalation pinned, fallback to another model disabled. Completion took **5 rounds / 69,987 processed tokens**. It compared all 72 native activity IDs, independently checked the returned height with a generic Cartesian ray, and checked model-delivered tool payloads plus exact epoch, pause, selection and tracking. The final model prose still misstated a withheld terrain identity, so the existing single-correction/fact-summary boundary supplied the truthful final answer. No additional recovery rounds or analysis retries were introduced.

The Stop run used the same exact prompt while actual terrain evaluation was active. Timeline stepping, camera dragging and text input were observed before pressing the real Stop button. Timeline stepping completed in 123 ms; actual camera and input changes were verified before Stop returned in 205 ms. The evaluation count remained unchanged for 200 ms after Stop. It used 2 rounds / 23,443 processed tokens.

### Scientific result and truthful partial scope

The best available candidate is **Flight 61**, **0.0240184618532 km (~24 m)** geodetic-normal physical terrain clearance, at **2023-10-05T08:11:34.040Z**, ET **749765563.2247751**. The independent Cartesian-ray result differed by **3.41×10⁻¹³ km**; this numerical agreement does not certify source accuracy. The existing native navigation showed Ingenuity at that exact epoch.

All **72** intervals produced candidates; **17** have no detected gaps and **55** retain declared trajectory endpoint gaps up to **20.0272 µs**. **One** interval also reached its local numerical allowance. That local limit did not stop the collection after 17 flights. No full-scope/global winner or height-error bound is established. The trajectories are estimated reconstructions, not telemetry. A versioned physical terrain source was used; withholding its private identifier from Ask does not make it unidentified or certify its accuracy.

Structured tool summaries now report the evaluated and gap-free counts even when an interval hits a local budget. Typed facts preserve local budget counts and terrain-identity presence without disclosing private identifiers. Existing answer checks reject confusing the gap-free count with the comparison count, a false collection-stop claim, invented budget exhaustion, or an unidentified source inferred from a withheld identifier. Native factual fallback retains all qualifications.

Earlier UI attempts are excluded from final acceptance: an unobserved-terrain-work timeout with no established cause; an independent control ray aimed upward at negative ellipsoid height; misleading scope/source prose; and an initial whole-turn 100 ms heartbeat gate that caught a **56 ms final-view activation task / 114.5 ms heartbeat**. The harness now records calculation and whole-turn timing separately and publishes both. Its gates are <100 ms main-thread tasks, <100 ms calculation heartbeat, <200 ms whole-turn heartbeat, and <300 ms Stop. These are observed regression bounds, not hard realtime guarantees. Software-renderer cold imagery uploads also showed independent stalls; the accepted timing runs use the identified physical GPU.

### Validation and reproduction

**555 focused tests in 35 files** pass across control contracts/answers and native trajectory, physical surface, terrain, navigation and viewer tests. Package builds, test/viewer/Svelte typechecks, changed-source ESLint, script syntax and diff checks pass. Regressions cover elapsed yielding before 256 evaluations, cancellation inside triangle/traversal work, flat ellipsoid/face/edge/pole agreement, missing finest grids, resident replacement/eviction, and actual misleading answer variants.

`CL_VIEWER_URL=http://127.0.0.1:5202/ TERRAIN_PERF_REPORT=/tmp/terrain-native.json node scripts/test-terrain-analysis-responsiveness.mjs` runs the native stop probe. With a dedicated viewer configured for the proxy endpoint and an approved provider/scene, add `TERRAIN_PERF_LIVE=1`; `TERRAIN_PERF_COMPLETE=1` runs completion, otherwise it tests live interactions/Stop. `TERRAIN_PERF_ASSERT=1` enables timing gates. `TERRAIN_PERF_GPU` selects the browser backend; the report records the actual renderer. Paid inference is opt-in and pinned to Haiku. Runtime source for this earlier responsiveness control is `7412f370`; the later coverage review above supersedes its endpoint interpretation. Exact final-head CI is tracked in the PR description. PR remains draft and unmerged.

## Task-level height execution review

The latest review's exact request, **“show me when ingenuity is at max elevation across all flights”**, now leads to one precise choice between reference-ellipsoid height and physical terrain clearance. The native task never silently substitutes a height datum. After choosing ellipsoid height, the existing numerical service evaluated **all 72 flight intervals**, stored native results, and navigated to its best available sampled candidate. The follow-up “show me” reused that result without another analysis.

`analysis.analyzeTrajectoryExtrema` resolves subjects, full native activity/window scope, declared datum/frame/source compatibility and numerical defaults, then uses the existing solver/results/navigation. `getTrajectoryAnalysisOptions` exposes current scene choices. `resolve` now labels truncated activity candidates; compact scene summaries reach the model instead of exceeding its output budget.

Bounds are **32 subjects, 128 intervals, 200,000 evaluations per interval and 1,000,000 total**. Source-knot-based per-interval allowances prevent early dense flights consuming the collection budget. Known covered pieces are probed before rejecting a broad envelope. No knots or source epochs are silently discarded, snapped or extrapolated, and no new solver/planner was added.

Preflight distinguishes ambiguous measurement/body, invalid scope, unsupported metric and supported analysis with unavailable data. One executed analysis per subject set is allowed per Ask request; at most two rejected scope preflights or malformed numerical inputs are allowed. Equivalent task/expert retries return a terminal outcome and established facts; the loop skips remaining batch work. Ten fixed-mode rounds and one answer correction remain, without a recovery-round counter or new production token quota. Numerical work bounds are not a physical error or wall-clock guarantee.

Navigation retains goal/manual-takeover/scene-reload contracts. Marking its synchronous clock notifications as its own write fixes the reproduced false takeover. Bounded history preserves exact result IDs. Typed answer checks keep activity counts, evaluated-versus-gap-free intervals, source provenance and authored dates distinct from measured events.

### Scientific result and limits

All 72 Ingenuity intervals produced numerical candidates. **17** have sampled-complete coverage; **55** retain declared trajectory endpoint gaps up to **0.0000200272 s**, observed between catalog activity epochs and loaded trajectory bounds. Those epochs were not snapped, clamped or extrapolated. Consequently `winnerId` stays null. The separately qualified best available ellipsoid-height candidate is **Flight 64**, about **−2.04024 km**, at **2023-10-27T20:47:55.095Z** (ET **751711744.2791412**). Negative ellipsoid height is not terrain clearance. Ingenuity's trajectories are estimated reconstructions, not 3D telemetry; source accuracy and a global height error remain unknown.

The held-out minimum request selected **Flight 16**, about **−2.24908 km**, at **2021-11-21T02:04:19.916Z** (ET **690732329.1**), with the same partial-coverage qualification. Neither candidate certifies a global winner, altitude accuracy, contact or physical release. The controls in this section used explicitly chosen reference surfaces; the later terrain-query review above adds a qualified full-flight physical-clearance control.

### Final controls

Controls used the normal Ask textarea/Send path, one persistent conversation per case, and fresh browser processes. All inference was **Haiku `claude-haiku-5-5` only**, escalation pinned, fallback disabled, output 1536 tokens. Native interval/result coverage, independently recomputed heights, exact ET, camera, selection/activity, visibility/profiles and delivered payloads were checked. Ingenuity and MoonFall rendered views were inspected. SwiftShader; cache warmth uncontrolled.

| Control | Observed result | Rounds / processed tokens |
| --- | --- | --- |
| Exact Ingenuity request → explicit ellipsoid choice → “show me” | One datum question, 72 interval candidates, qualified Flight 64 view; ID reused | 2 / 23,123; 4 / 52,550; 4 / 49,194 |
| Highest radial sphere height across all Polaris hops → “show me” | All 12 hops sampled-complete; synthetic Polaris-D connector candidate, ~2.049 km; exact native view | 4 / 53,133; 2 / 25,138 |
| Held-out lowest ellipsoid height across Ingenuity flights | All 72 candidates, qualified Flight 16, native epoch/selection/view | 5 / 71,208 |
| Philae maximum physical terrain clearance over the specified descent interval | Data unavailable; no fabricated result/navigation or claim that DSK geometry is absent | 4 / 62,747 |
| Exact four-turn Rosetta conversation from the preceding review | Authored touchdown/separation views; range-history investigation; exact sampled-minimum seek with pre-existence visibility qualification | 5 / 75,550; 6 / 79,842; 6 / 98,487; 3 / 47,447 |

These eleven turns total **45 rounds / 638,419 processed tokens**. The main controls ran on `5903eaf6`; the final covered-piece preflight and semantic assertion were checked by the held-out run on `1607f200`. The latter also has a deterministic wide-window regression. These observed controls are not a statistical equivalence or reliability claim, and history turns can still be expensive (one used 98,487 tokens). The result meanings and coverage limits matter independently of navigation success.

Earlier failures included an insufficient shared numerical budget, false clock takeover, oversized evidence, a question mistaken for a result claim, a truncated inventory mistaken for the collection, and omitted reconstruction provenance; regressions cover them. A development reload and a stalled pre-inference scene load invalidate two attempts, which are excluded. An overly literal uncertainty assertion was corrected and a fresh held-out run passed. Raw reports/screenshots remain outside the repository.

**Local validation:** 541 focused tests in 29 files; control build, test/viewer/Svelte typechecks, changed-source ESLint, 127-operation capability coverage, harness syntax and diff checks pass. The final evidence update changes documentation only; exact-head CI is tracked in the PR description. Worker dependencies remain #361; physical contact remains #360; Rosetta's bus-origin identity is unchanged. The earlier missing-frame classification/receipt fixes and truthful fallback remain, with retry handling at operation boundaries.

## Earlier persistent conversation review (`f8c9a5f8`)

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
