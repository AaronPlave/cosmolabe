# Exploratory Ask assessment: 2026-11-12

This is the original diagnostic baseline. [Review implementation and final
regressions](379-review.md) supersede its assessment-only scope and follow-up
recommendations; the identified shared fixes remain in PR #380.

Ask can produce useful native views and bounded sampled explanations in unfamiliar
catalogs. It does not yet reliably turn an open investigation or comparison into
a useful visual explanation. The observed limits point first to source/coverage
contracts and intent-preserving composition, rather than a new agent framework.

## Method and limits

The [12 requests and rubrics](../../../scripts/ask-benchmark/exploration.mjs)
were frozen before runtime changes, across Earth–Moon, Earth from Orbit, OEM
Ingest and Europa Clipper. The latter three were outside the earlier six-catalog
reliability suite. Production fixed tools, Haiku 5.5, default effort, no fallback,
one attempt per task; one task continued for a second turn with the active
tracking/time/camera context. Catalog defaults were retained, playback frozen,
selection initially cleared. The baseline viewer was `4473f2f0`.

Every final native view was visually inspected, alongside independently projected
render-camera positions, full camera poses, selection/time, native event state
and timeline traces. Model-visible observations were matched by call ID. Numerical
checks used separate native point-state reads and coarse sampling/local refinement,
not Ask's verdict or Event Finder ranking. This is independent instrumentation
review by one evaluator, not a separate blinded reviewer or a first-time-user study.

The 12 tasks cost **$0.028065 estimated**, with 68 model rounds and 940,827 raw
processed tokens including cache reads/writes. End-to-end task latency p50 was
10.954 s, p95 24.057 s; catalog loading excluded. Two diagnostic reruns added
$0.008542, bringing total estimated spend to **$0.036607** against the approved
$2 cap. Cache warmth was uncontrolled. Actual billing is unavailable. Pricing
was checked against the [official Haiku documentation](https://platform.claude.com/docs/en/models/haiku-5-5/overview).
No model/routing comparison or statistical success-rate claim follows from this sample.

Chromium used SwiftShader: these findings do not establish physical GPU performance.
The full observations, screenshots, local numerical checks and mockup walkthrough
remain under `/tmp/ask379*`; only [compact evidence](379-evidence.json) is committed.
Hashes identify those local reports; they do not make temporary files durable.

## Results matrix

G = grounding/feasibility; C = capability choice/composition; V = visual usefulness;
T = truthful explanation; U = execution UX. P = pass, ~ = partial, F = fail.
For ambiguity/unsupported tasks, V assesses the expected unchanged scene.
“First failure” identifies the earliest meaningful limiting category, not every
subsequent mistake. Missing science can coexist with a well-handled refusal.

| Task | G/C/V/T/U | Independently checked outcome and limit | First failure | Rounds / s / estimated USD |
| --- | --- | --- | --- | --- |
| `em-explore` | P/~/~/~/P | Authored Lunar Orbit, both centers visible; Moon angular radius 0.0905°, only a few pixels. No fabricated activities. Final explanation misses the visible legibility limit. Two malformed IDs copied the index's note marker. | **b**, registry presentation | 7 / 11.5 / .003265 |
| `em-context` (2 turns) | P/~/~/~/P | Exact ET and Moon range 417,449 km retained. Angular radii Earth 0.490°, Moon 0.238° agree with the answer, but the second compose leaves the full pose unchanged; tiny dark discs offer a weak comparison. | **d**, composition/usefulness | 7 / 13.9 / .002528 |
| `em-ambiguous` | P/P/P/P/P | Asked which objects/views and what “better” means; full stable state unchanged. | None; clarification appropriate | 2 / 4.5 / .000545 |
| `iss-explore` | ~/~/P/F/P | Actual 0.5 km ISS close-up is useful. Source provenance was not checked, an invented namespace failed, and imagery was called loaded despite `surface: waiting`, no view coverage. | **d**, evidence choice | 6 / 10.2 / .001897 |
| `iss-appearance` | ~/~/~/F/P | Ends at Nov 5 11:30 UTC with Earth visible. Native API exposes changed daily date and baked illumination; public projection drops both. Answer admits no content comparison but calls both layers loaded. Independent views show no verified daily imagery drawing; cannot infer weather or a lighting cause. | **b**, shared metadata parity | 6 / 15.2 / .002083 |
| `iss-unsupported` | P/P/P/P/P | Correctly declines missing wind observations and leaves state unchanged. TLE and true-colour imagery do not measure strongest winds. | **a**, missing scientific data | 3 / 6.8 / .001021 |
| `oem-investigate` | ~/~/P/~/P | Native distance trace, finite bounded samples, disclosed cadence/interval and center-distance distinction. All 32 numerical samples agree with native point-state norms. However the displayed window extends outside the OEM and silently holds endpoints; “0 missing” does not establish source coverage. | **b**, shared coverage contract | 9 / 18.4 / .004060 |
| `oem-compare` | ~/F/~/~/~ | Trace exists, but incoming/outgoing comparison becomes repeated minimum refinement. Two malformed signature IDs; two unavailable GF attempts; step limit reached. Safety answer reports a sampled minimum and not a successful comparison. | **d**, narrowed intent/composition | 10 / 24.1 / .005836 |
| `oem-contact` | F/~/P/F/P | No changes and correctly declines actual particle contact. But a Cassini display mesh exists: absence of a registered hull/contact model is not absence of geometry. “Load models and I can run the clearance check” promises an unavailable algorithm. | **a**, missing contact science; secondary **e** | 3 / 4.7 / .000881 |
| `clipper-explore` | ~/P/P/~/P | Native Europa event marker/view, exact epoch, center range 1,584.73393 km independently reproduced. Loaded-window/step and unclassified flyby caveats stated; predicted provenance and reference-altitude meaning omitted. | **c**, source grounding | 3 / 11.0 / .001058 |
| `clipper-compare` | ~/~/~/~/P | Correct March interval, pairs, ranking and values independently reproduced: Europa 1,838.60771 km vs Ganymede 442,173.32551 km. Final selection/time is Europa's event but camera remains tracking Ganymede, ~914,091 km from Europa; no useful juxtaposition of the two approaches. Ask itself reports unverified. | **d**, multi-result presentation | 6 / 12.9 / .002904 |
| `clipper-science` | P/~/P/P/P | Correctly distinguishes instrument definitions from missing ice-thickness products; unchanged view. Four rejected instrument getter calls add avoidable work. | **a**, missing scientific product; secondary **e** | 6 / 9.4 / .001986 |

Categories: a scientific data/algorithm; b shared capability/control parity;
c scene grounding; d choice/composition/verification; e model error; f performance/UX.
No first failure was assigned to f merely because a bounded run took time.

## Evidence that changes the investment decision

- **Metadata is present locally but absent in Ask.** Native `getImagery('Earth')`
  exposes `follow-simulation`, dates Nov 4/5, daily cadence, `illumination: baked`
  and unknown current-view coverage. `agentMetadata().imagery` omits the entire
  time object and withholds unapproved attribution/description. The missing
  date/illumination fields are a parity gap; withheld provenance must remain
  unknown unless explicitly reviewed. Status `ok` is not proof of pixels drawn.
- **Display availability is not scientific coverage.** The OEM declares
  `2004-06-30T12:00:00` through `2004-07-02T11:58:00.000056`, UTC/J2000.
  The profile samples June 30 07:12 through July 2 16:45. Both the profile and
  `getObjectState` report finite available values outside the file. The loader
  uses `InterpolatedStatesTrajectory`, whose `stateAt` clamps to endpoints.
  This is a confirmed shared scientific-boundary problem, not a reasoning failure
  or a reason to demand SPICE GF for every profile. The file's originator is
  COSMOLABE; imported samples must not be called mission telemetry.
- **The arithmetic was not the comparison bottleneck.** Separate native-state
  sampling/refinement finds all three Clipper minima within 0.000001 km and
  0.02 s of the returned results. This validates the bounded comparison evidence,
  not continuous/all-time completeness. The camera and multi-result explanation
  remain inadequate even when the numbers are correct.
- **Stop works at the checked boundary.** A local in-memory transport applied
  Moon selection, held its next reply, then received Stop through the actual UI.
  The panel read “Researching…” with Stop available, then “Stopped. Already
  applied: Selected Moon.” A late reply proposing Sun selection was ignored;
  selection/camera/ET stayed identical after 500 ms. This used zero provider calls
  and does not cover every solver/camera race. The 12-task live suite itself
  did not exercise Stop or a selected-object follow-up; tracking context did.

## Targeted fix and frozen reruns

The registry used `camera.viewpoint*(...)` and `profiles.listProfiles()` as
compact signatures. Baseline calls copied both `*` and `()` into IDs. The small
generic fix quotes exact IDs and moves `[notes]` after the parameter signature.
Schema validation, usage-note gates, bounded indexing and production routing
remain in force. The dynamic-widget regression now checks that every quoted ID
round-trips through discovery, including a newly registered operation.

Reruns used the exact frozen wording, separate reports and fresh conversations:

| Task | Observed change | Remaining limit |
| --- | --- | --- |
| `em-explore` | 7 → 5 rounds; no malformed IDs or refused calls | Same distant authored view; weak explanation. One observation does not establish a latency/cost improvement. |
| `oem-compare` | Signature-copy failures absent | Still 10 rounds / step limit, with unrelated argument errors and repeated minimum refinement. No claim that formatting repairs composition. |

## Next investments, ordered by observed impact

1. **Repair the shared evidence boundary.** Carry safe temporal-imagery fields
   through the public contract; distinguish readiness/draw coverage and reviewed
   provenance. Expose imported-source intervals and make out-of-coverage profile
   reads explicitly unavailable rather than certified by a clamped display pose.
   These findings belong with #328's common discoverable contract and scientific
   coverage owners. They are not new native blockers declared by this assessment.
2. **Preserve comparison intent through native presentation.** Add small generic
   regressions for history vs extrema, two-pair comparison, and re-presenting the
   chosen result after inspecting another query. Require honest limits when a
   useful view was not achieved. Retain existing profiles/events/cameras and
   bounded rounds; this evidence does not justify a general planner or larger budget.
3. **Validate the modified composer guidance below.** Show authored/available/
   unverified distinctions early and avoid suggesting irrelevant comparisons
   from whatever body the default camera tracks. Test first-time-user prediction
   before shipping; no command gallery or extra model request is needed.
4. **Keep absent science explicit and demand-led.** Wind products, ice-thickness
   inference and particle/hull contact each need different data/algorithms owned
   by #321/feature work. Do not promise that loading a mesh supplies a solver.
   These three unsupported tasks do not justify building all three capabilities
   or an agent framework as the next investment.

## Guidance decision: modify, then validate in a focused UI follow-up

The [assessment-only candidate generator](../../../scripts/ask-benchmark/guidance.mjs)
was exercised against actual registry availability and public scene metadata in
all four loaded catalogs, without inference or automatic analysis. A disposable
mockup checked open → choose → fill composer → close; choosing did not submit.

| Catalog | Generated starting points | Comprehensibility finding |
| --- | --- | --- |
| Earth–Moon | Two actual authored views | Honest evidence supports only two. Do not pad a mandatory 3–5 count with invented science. |
| Earth from Orbit | Two authored views + inspect configured imagery | Useful distinction between show and inspect; neither implies daily imagery is drawn. |
| OEM Ingest | Two authored views + Saturn–Sun range | A mechanically valid suggestion is irrelevant to Cassini's encounter. Default tracking is insufficient intent. |
| Europa Clipper | Two authored views + Clipper–Jupiter range | Legitimate center-distance exploration, with explicitly uncertified interval coverage; not clearance or observed science. |

Keep the compact affordance, with fewer entries when evidence is sparse. Prefer
the person's selected subject for analysis examples; if intent/coverage is
unknown, offer inspection/clarification. The evaluator could distinguish show,
inspect and explore from the labels, but that is **not evidence of first-time-user
comprehension**. A real new-user prediction check remains necessary before shipping.
This change therefore ships no production guidance UI and claims no usability gain.

```text
[ What can I do here? ]
  Show <actual viewpoint>       Authored view · outcome unverified
  Inspect imagery on <body>    Configured layers · view coverage unknown
  Explore <selected pair>      Center distance · interval coverage unverified
[ editable question ………………………………… ] [ Send ]
```

## Validation

374 tests across control and benchmark suites pass; package TypeScript build,
changed control-file lint and `git diff --check` pass. The prototype tests reject
data inference from operation availability, preserve authored/result distinctions
and refuse to equate layer `ok` with coverage. Native/browser evidence and the
two frozen reruns are described above. No new solver or model orchestration,
mission-specific runtime path, default routing change or production UI was added.
