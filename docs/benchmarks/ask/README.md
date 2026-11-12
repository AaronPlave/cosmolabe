# Ask quality, latency and cost benchmark (#332)

[#379 findings and decision](379-findings.md) assess 12 frozen tasks across four
catalogs. The [protocol](379-exploration.md) and `ASK_BENCHMARK_SUITE=exploration`
record evidence for independent review without assigning automatic success.

[2026-11-01 findings and measured limitations](2026-11-01-findings.md) ·
[2026-11-04 final gate (#345)](2026-11-04-final.md) ·
[2026-11-05 final pass (#345)](2026-11-05-final-pass.md).

## Reliability suite (#345)

`scripts/ask-benchmark/reliability.mjs` holds 22 user-level tasks across six
catalogs, judged on viewer state (predicates over the harness's own reads and
projection, closest approaches against independent range sampling) and on the
answer text (stated distances, dates, counts, flyby claims, refusals). Live runs
default to fixed mode; `ASK_BENCHMARK_CASES=critical` selects the issue's literal
requests; `ASK_BENCHMARK_MAX_USD` caps each invocation; `rescore.mjs` re-judges
saved reports without provider calls. Multi-turn tasks run as one conversation in one
fresh scene; each turn is finished before the next is sent and judged on its
own. A stopped conversation is the observation: the harness does not keep
spending after a budget or rate stop.

Judging never reads the answer. Event, surface and ground-point goals are
`checkGoal` over viewer reads the harness records itself; camera composition is
the harness's own projection of the render camera, not the viewer's
`getViewComposition` under test. Every run is classified `complete`,
`correctly-refused`, `partial`, `incorrect`, `timed-out`, `interrupted`,
`budget-stopped`, `error` or `harness-error`. A failed state check with an
answer that sounds successful is flagged `suspectedFalseSuccess` for review;
factual verdicts remain `pending-review` as before. `reliabilitySummary` in the
report gives first-attempt success with a Wilson 95% interval, failures per
check, rounds/latency/raw-token p50/p95 and estimated cost per arm/model/mode.

```sh
# B: this checkout's viewer
ASK_BENCHMARK_LIVE=1 ASK_BENCHMARK_SUITE=reliability ASK_BENCHMARK_REPETITIONS=5 node scripts/benchmark-ask.mjs
# A: the same harness against a pre-#345 viewer (a worktree at the merge base, on another port)
ASK_BENCHMARK_LIVE=1 ASK_BENCHMARK_SUITE=reliability ASK_BENCHMARK_ARM=A CL_VIEWER_URL=http://127.0.0.1:5298/ node scripts/benchmark-ask.mjs
```

`ASK_BENCHMARK_EFFORT` sets the model's effort level (`output_config.effort`; unset uses its default).
`ASK_BENCHMARK_MODELS`, `ASK_BENCHMARK_MODES` and `ASK_BENCHMARK_CASES` narrow
the matrix; `ASK_BENCHMARK_PROXY_PORT` (default 8799) lets several harnesses run in
parallel, each forwarding the page's endpoint to its own proxy. Wrap long runs in
`caffeinate -i` so the machine cannot sleep mid-run; the default is both models and both modes. Paid runs keep the raw-token
and estimated-dollar guards below. `.github/workflows/ask-live-benchmark.yml`
runs the fixed-mode reliability suite weekly or on dispatch, only when the
repository variable `ASK_LIVE_BENCHMARK` is `true` and the key secret is set.
The deterministic gate is the Vitest suite in Fast PR CI (`ask-reliability`,
`compose`, `outcome`, `reliability` tests); `npm run test:ask-composition` checks
`composeView` on the real Psyche scene (needs the mission kernels, so it is not
in PR CI).

This benchmark runs the regular development Ask panel against the real loaded
viewer. It compares fixed tools and discovery on the same twelve quality tasks plus one excluded diagnostic
in `scripts/ask-benchmark/cases.mjs`, with Sonnet 5.5 and Haiku 5.5. It does not
change defaults, route tasks, or implement mission-specific runtime workflows.

## Reproduce

Use Node 20+, installed workspaces and Playwright Chromium. Build packages with
`npm run build`. From this checkout, start a dedicated viewer:

```sh
VITE_ASK_ENDPOINT=http://127.0.0.1:8799 npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5299 --strictPort
node scripts/benchmark-ask.mjs # plan only; no provider requests
ASK_BENCHMARK_LIVE=1 node scripts/benchmark-ask.mjs
```

The configured `ANTHROPIC_API_KEY` stays in Node. The live harness first checks
both exact model IDs against the account's Models API. Review official pricing
before rerunning on another date. `CL_VIEWER_URL`, `ASK_BENCHMARK_REPORT` (default
`/tmp/ask-benchmark.json`), `ASK_BENCHMARK_REPETITIONS` (1–10), and a comma-separated
`ASK_BENCHMARK_CASES` subset are optional. The harness owns port 8799 and closes it
on completion. Verify listener ownership for the viewer port with `lsof`; a
viewer from another checkout invalidates the comparison.

A fresh browser context means a fresh scene, preferences and conversation for
every cell. Catalog default ET and viewpoint are retained. Clock rate is zero;
playback initially runs for pause/cancel tasks, otherwise it is paused. Tasks,
models and modes share these initial conditions. Model/mode order reverses on
alternating tasks/repetitions. Provider cache warmth remains uncontrolled: fresh
browser contexts do not flush provider caches. Keep order and all cache token
categories with results. One repetition is an exploratory paired matrix, not a
statistical performance or equivalence claim. The live script exits nonzero for
harness failures; model/state/factual failures remain benchmark observations, so
an exit code of zero is not task-quality acceptance. Latency starts at Send and ends at
the completed Ask turn; catalog load is excluded.

## Acceptance and review

The clock-anchored `ambiguous-flight` task is diagnostic only: it is excluded
from quality and comparable-suite usage denominators. State checks use independently read selection, activity/place references, ET,
playback and camera pose. Lunar Orbit checks full position, target and up against
the catalog viewpoint (1 km / 0.001 tolerance). Landing navigation resolves the
catalog anchor through the current body pose and checks target error below 0.5 km
and eye distance 0.1–5 km, allowing terrain refinement. Framing additionally projects the loaded object's
center through the actual render camera and measures its viewport size. An
unverified/partial receipt is retained even if this independent probe confirms a
view. A successful host return or fluent final answer is insufficient. Unchanged
checks compare the frozen clock, selection, tracking and camera. Cancellation
stops at the next HTTP boundary after a successful mutation and checks for later
mutation; it does not test every possible in-flight cancellation race.

Every factual score initially says `pending-review`. Review the retained final
answer against the public tool observations and per-task rubric. Record `pass`,
`partial`, or `fail` with a concrete reason in a separate review artifact. Never
count a passing state check as factual acceptance. In particular check exact
references, estimated flight timing, synthetic MoonFall provenance, missing or
withheld attribution, degraded imagery and unknown coverage. Missing shared
semantic APIs remain #297 work; absent evidence is not success.

Reports contain final answers, public tool observations, state probes,
receipt status and usage counts. They exclude raw provider requests, signed
reasoning, credentials and raw host/catalog inventories. Do not retain debug
provider traces. Tool observations are captured before the agent loop's 6,000-character
serialization budget: the model may instead receive `result-too-large`. A retained
observation does not prove the model received it. Inventory acceptance additionally
requires a successful, nonpartial serialized payload in a subsequent provider
request, matched by call ID; omitted or missing delivery evidence cannot pass. The report records the source commit; reruns should use a clean
checkout of that commit.

## Pricing and bounds

Official first-party global standard pricing reviewed 2026-11-01:

| Model | Uncached input | Cache read | 5m cache write | Output |
|---|---:|---:|---:|---:|
| claude-sonnet-5-5 | $2 | $0.10 | $2.50 | $10 |
| claude-haiku-5-5, prompt ≤100,000 | $0.10 | $0.01 | $0.125 | $0.50 |
| claude-haiku-5-5, prompt >100,000 | $0.50 | $0.05 | $0.625 | $2.50 |

Rates are USD per million tokens. Haiku's tier uses uncached input **plus cache
reads and writes**, and applies to output too. Sources:
[pricing](https://platform.claude.com/docs/en/about-claude/pricing) and
[Haiku model ID/specification](https://platform.claude.com/docs/en/models/haiku-5-5/overview).
The existing proxy estimator uses the **answered** model, never an assumed
requested model; unknown pricing remains null. No fallback is requested.

The benchmark separately limits 8 million raw processed tokens and $4 estimated
USD across all cells, checking before subsequent requests; in-flight work can
overshoot. Raw totals include all cache reads/writes and output. Each cell owns a
fixed-model proxy, closed before the next cell. The proxy's raw-token and
estimated-dollar guards are also enabled; the benchmark's global estimated-dollar
guard is separate and fails closed after unknown usage pricing. These are not provider
account spending limits. Actual billed cost is not observable from the configured
Messages API key and remains null. Requests aborted before usage is returned may
incur unobserved billing. Cancellation at the harness boundary avoids forwarding
that next request.

## Efficiency investigation

Use round counts, schema character counts, described-schema history and semantic
steps to inspect each workflow. Check whether independent reads were emitted in
one provider round, schemas were described together and reused, and repeated
scene reads brought new evidence. Discovery's smaller initial schema can lose to
its extra list/describe/invoke rounds and growing history. Public projections
already compact/sanitize model-facing inventories. Any later compaction must
preserve attribution, unknown coverage, partial receipts and degraded readiness.

Keep post-write verification, scene ownership and cancellation guards. Agent
execution remains sequential even when the model emits independent reads together.
Adding concurrent execution needs its own safety evidence; do not retry writes or
silently hand partly executed work to another model. Model/default changes require
comparable factual correctness beyond this exploratory matrix. The $0.002 simple
and $0.005 routine targets are aspirations, not acceptance thresholds.

Write reports outside the repository. Keep only concise findings and a small
representative fixture in git; archive full reports and digest-bound reviews
externally when durable raw evidence is needed. The historical findings explicitly
state which raw evidence was omitted. Compact external results with:

```sh
node scripts/summarize-ask-benchmark.mjs /tmp/ask-benchmark.json reviews.json > compact-results.json
```

The compactor deduplicates exact repeated observations. `observationRef` points
into the top-level `observations` map. Review keys are
`task/model/mode/repeat` under a `reviews` object, with `verdict` and `reason`. Use `excluded` for a documented invalid task rubric;
excluded probes are removed from quality and comparable-suite usage denominators.
Only state-passing cells with a factual `pass` count as `fullyVerified`.

Reviews can be tied to exact evidence with a `reportSha256` field calculated by
`reportDigest` in `scripts/ask-benchmark/report.mjs`. The summarizer rejects a
nonempty review set whose digest does not match, so another run's answers cannot
inherit old passing reviews. The digest is stable after observation deduplication.

The later instrumentation records each response's semantic `outputCalls` and the
next request's `lastResultCodes` (including `result-too-large`) without preserving
provider text/reasoning. This makes independent-read batching and output-budget
omissions visible. Scene readiness starts the task; asynchronous terrain/imagery
readiness is observed rather than forced or assumed complete.
