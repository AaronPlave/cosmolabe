# Exploratory scene assessment (#379)

Status: tasks frozen on 2026-11-12. The [baseline findings](379-findings.md)
precede the [review implementation and final regressions](379-review.md).
The frozen wording/rubric is unchanged; PR #380 now implements the shared
findings and composer guidance. Production routing is unchanged.

Local preparation verified all four catalogs reach scene readiness and render
in this checkout's dedicated viewer. Baseline views were visually inspected;
they are not Ask outcomes. Earth–Moon shows untextured approximate bodies;
Earth from Orbit exposes static Blue Marble and daily NOAA-20 VIIRS metadata
separately from the ISS existence interval; OEM Ingest renders Cassini at
Saturn; Clipper renders its spacecraft/instrument scene. Full baseline metadata
and images remain under `/tmp/ask379-baseline*`. Eighteen existing benchmark
tests pass; both modified JavaScript modules pass syntax checking, and the
exploration plan runs without provider requests.

## Frozen protocol

The exact 12 requests and acceptance criteria are in
[`exploration.mjs`](../../../scripts/ask-benchmark/exploration.mjs).
Four catalogs deliberately include three outside the previous six-catalog
reliability suite: Earth from Orbit, CCSDS OEM Ingest and Europa Clipper.
Earth–Moon supplies an approximate-motion control. The Moon composition task
has two turns in the same scene/conversation; its second turn retains the
active time and camera context. Each other task starts fresh.

Use the shipped fixed tools and default Haiku model, one repetition, no fallback,
at most $2 estimated total and the existing raw-token/request/turn limits.
This is an exploratory sample, not a success-rate or model-comparison study.
Unknown pricing stops subsequent requests. Account billing is not observable;
in-flight or cancelled requests may incur unobserved cost.

```sh
# Plan only: no model requests.
ASK_BENCHMARK_SUITE=exploration ASK_BENCHMARK_MODELS=claude-haiku-5-5 node scripts/benchmark-ask.mjs

# After explicit authorization for public scene/tool data transmission:
ASK_BENCHMARK_LIVE=1 ASK_BENCHMARK_SUITE=exploration \
ASK_BENCHMARK_MODELS=claude-haiku-5-5 ASK_BENCHMARK_MAX_USD=2 \
ASK_BENCHMARK_REPORT=/tmp/ask379.json ASK_BENCHMARK_CAPTURES=/tmp/ask379-captures \
node scripts/benchmark-ask.mjs
```

Start this checkout's viewer on port 5299 with `VITE_ASK_ENDPOINT=http://127.0.0.1:8799`.
Verify listener ownership first. Keep full reports and captures outside git.
The harness records public model observations and whether they reached a
subsequent provider request, independent full camera pose/projection, native
profile configuration and bounded numerical samples, and native event state.
Screenshots record the final view per turn. Manually inspect intermediate
appearance comparisons too; a final screenshot cannot establish both epochs.
Rendered baselines use Chromium software WebGL and do not validate physical GPU performance.

## Independent review and result matrix

Model outcomes remain **unverified** until reviewed. For every task record:

| Field | Required evidence |
| --- | --- |
| Grounding/feasibility | Actual objects, epoch, frame, metric, catalog/source and coverage |
| Choice/composition | Relevant existing operations, no substituted metric or failed-query loops |
| Visual usefulness | Inspected native view/results; actual projection, occlusion, trace visibility |
| Truthful explanation | Independent numbers and provenance; sampled/authored/computed/unavailable distinctions |
| Execution UX | Progress/Stop observation, rounds, latency, tokens, estimated cost, late changes |
| Earliest meaningful failure | a scientific data/algorithm; b shared capability; c context; d composition/verification; e model; f performance/UX; none; or unverified |

Use pass/partial/fail/unverified separately for each dimension. Unsupported
science can be handled correctly and still limit the user's desired outcome.
Do not count missing physics as a reasoning defect. Successful receipts and
answers are evidence to inspect, never an automatic passing outcome.

Do not revise wording or criteria after observing answers. If a clear generic
misuse is fixed, preserve the first attempt and rerun the affected frozen case
separately, recording source commits and additional spend. Keep a concise matrix
and concrete evidence excerpts, rather than committing raw traces.

## Capability guidance interaction to evaluate

Proposed interaction, not a shipped feature or an assessment conclusion:

1. A small “What can I do here?” button beside the composer opens a transient
   set of 3–5 starting points.
2. Derive candidates from the shared registry and actual loaded scene/source
   availability. Operation availability alone cannot establish data readiness.
3. Each entry states its scope: for example an authored view, a sampled
   center-distance comparison, or imagery configuration with readiness unknown.
   A result becomes verified only after execution and independent observation.
4. Choosing an entry fills the composer for editing; Send remains explicit.
   Closing the popover discards it. No model call, automatic analysis or persistence.

Compare what a new user predicts before and after seeing this interaction:
what will be shown, calculated or configured, what evidence is needed, and
what remains unsupported or needs clarification. Record observed comprehension
separately from an evaluator's judgment. No user study has been conducted here.

The findings record a **modify** decision from the catalog/evaluator walkthrough,
with first-time-user validation still outstanding before a UI follow-up ships.
This protocol does not authorize a general orchestration framework or new
scientific solver.
