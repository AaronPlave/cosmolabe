# Ask reliability gate, 2026-11-03 (#345)

Status: the deterministic gate, the outcome checks and the paid A/B (run
2026-11-04, [results below](#ab-results-2026-11-04)) are done. First-attempt success
rose from 45% to 81% across both models and both tool modes, at lower cost.

## What a request is judged by now

Ask used to stop at "the call returned ok". A request is now judged against an
end state, read from the viewer:

1. **Intent as an end state.** For a request that changes the view, the prompt asks
   the model to state the whole end state as a typed `checkGoal` goal. That includes
   constraints from earlier turns, such as "Psyche close **and** Mars in view".
2. **Act through shared controls.** `composeView` is a new verb over the existing
   `circleCenter` orbit. Scripts and Ask both use it, and it holds no agent-only
   camera state.
3. **Independent check.** `checkGoal` reads the viewer itself. It covers camera
   composition, event presentation, surface appearance and ground points. The
   result is `met`, `partial`, `unmet` or `inconclusive`. Missing evidence never
   counts as success.
4. **Bounded repair.** The model may make one correction for a specific unmet check,
   and may check at most three times per request. Otherwise it says what holds and
   what does not.

Earlier turns are condensed to the person's words, the answer and the writes the
viewer ran, so a long conversation does not replay every tool result. On a hard
budget stop, one note lists exactly what is already applied. The duplicate banner
and the "N unverified" count for camera moves that do have a read are gone.

## Review changes (PR #351)

- **The loop, not the model, owns verification.** Goals persist across turns by subject; a later `checkGoal` cannot silently drop an earlier constraint (`release` must name it). After any change the loop re-checks the held goals itself and gives the model one correction round when it did not see an unmet result. The verdict is shown beside the answer.
- **False positives closed** in `outcome.ts` with negative tests: hidden/fully occluded/too-small objects, framing or drawing of another result, surface goals with no requested style, saved points that are selected but not at the sub-point.
- **Benchmark oracles measure the requested outcome.** "All flybys" must be local-minima scope and match the count of range minima an independent sample of `getObjectState` finds over the searched window. The no-flyby refusal needs the premise to be false (sampled minimum range > 1 AU; Voyager 1–Neptune is 3.48e9 km in the loaded catalog), nothing presented, and an answer that says no. `false-success` is its own class, and the summary counts answers contradicted by the viewer's check and changes left unchecked.

Second review (at `30612f7`):

- **Goal lifecycle.** There is one camera, so a camera or event goal about a new subject replaces the earlier one ("now show Mars" retires the Psyche close-up); independent surface and ground goals stay held. The host now checks every held goal after a change, not only the ones this request named, and asks the model to answer to any failing goal it has not seen. Merging more than four objects to keep in view is reported as a conflict instead of trimming one.
- **No initial goal.** A camera, clock, event, surface-colour or ground-point change made without a goal gets one `[Viewer check]` round to state one. If none fits, the request is marked unverified (`AgentRun.unverified`, "This change was not checked against the viewer") even when earlier goals still hold. Selection, labels and imagery are not asked, since no goal kind observes them.
- **"All flybys" oracle independent of the model's query.** Truth is now sampled over the pair's whole loaded-kernel coverage from `getEventSearchOptions`, with no range cap, and the query must cover that window. Live on the Psyche catalog: one coverage window, 2023-10-13 to 2031-11-01, 11,763/11,763 samples available, 5 local minima, the closest 1.8e8 km. Psyche never comes within 1 AU of Earth after launch, so the case also requires the answer to say none is a close flyby, the same standard as the Voyager/Neptune refusal. Unset scope is still accepted: the solver defaults it to local minima (`closest-approach.ts`).

## Evidence

| Check | Where | Result |
| --- | --- | --- |
| Five-turn Psyche/Mars conversation with a scripted model; end state judged by `checkGoal` | `packages/control/src/ask-reliability.test.ts` (Fast PR CI) | Passes: close-up range kept, Mars in view, epoch and pause held. The camera is framed once and never re-framed or dollied. |
| Rounds and replay | same | 3/3/3/2/3 rounds for the five turns (turn 1 sets the clock with no goal kind to fit, so it gets the one ask-for-a-goal round; turn 2 now states its close-up goal). The turn-5 request carries 1,115 characters of history, against 11,336 if the earlier tool exchanges were replayed (fake host; real results are larger, so real savings are larger). |
| Hard budget stop mid-conversation | same | The applied composition holds, the history stays valid and condensable, and nothing is retried. |
| `composeView` convergence | `packages/control/src/compose.test.ts` | Converges from 300 random target directions, distances and fields of view (the only accepted failure is "anchor fills the view" with the camera untouched). It reports occlusion instead of claiming success. |
| Real renderer, Psyche at the 2026-05-15 Mars flyby, Mars turned out of frame | `npm run test:ask-composition` | Passes on this checkout. Psyche stays at 1.5 m, Mars (8,008 km away) comes into frame, the receipt is `completed`, and clock and selection are unchanged. Judged by the script's own projection. |
| Vocabulary parity | `ask-reliability.test.ts` | Every curated verb is registered and the directional `circleCenter*` IDs are offered. A bare `circleCenter` is neither registered nor offered. |

Cost of the change: the fixed-mode cached prefix (tool schemas plus system prompt)
grew from 20,553 to 24,459 characters, about 1k tokens. It is read from cache on
every round.

## Observed failure (Nov 3) and owners

| Failure | Cause class | Fix here | Remaining owner |
| --- | --- | --- | --- |
| "Rotate around Psyche to see Mars" alternated between a close-up and pair framing | Ask planner/orchestration, plus no deterministic composition op | `composeView`, multi-turn constraint rule, goal check | Live A/B measurement, this issue |
| Five turns used up the proxy's raw-token cap | Orchestration: full tool replay each round | History condensing, per-turn stats | Proxy cap policy, deployment |
| "3 steps (0 done, 0 refused, 3 unverified)" | Tool contract: camera writes had no read | Composition read gives camera writes a verified receipt | n/a |
| Jargon in answers ("receipt", "projected centers…") | Prompt and tool summaries | Prompt bans the words; summaries now describe the view | n/a |
| Psyche is drawn larger than its 0.5 m catalog radius, so anchor occlusion is underestimated | Renderer observability | Documented as a limit of sphere occlusion | #337 / #224 |

## A/B results, 2026-11-04

Arm A is the viewer at the merge base (`67bff6c2`, pre-#345); arm B is this branch
(`5269d4ef`). Both ran from the same harness and judge, against the same catalogs, at the same
time (four parallel workers: arm × model). The matrix is 8 tasks × 2 models (Sonnet 5.5,
Haiku 5.5) × 2 tool modes (fixed, discovery) × 5 repetitions = 160 cells per arm. Each
cell is a fresh scene and conversation, and success means first-attempt success judged from
viewer state, never from the answer.

| Model, mode | Arm A | Arm B | Rounds p50 A → B | Est. cost A → B |
| --- | --- | --- | --- | --- |
| Sonnet, fixed | 31/40, 78% (62–88%) | 39/40, 98% (87–100%) | 6 → 7 | $2.08 → $2.36 |
| Sonnet, discovery | 9/40, 23% (12–38%) | 39/40, 98% (87–100%) | 16 → 8 | $3.94 → $2.48 |
| Haiku, fixed | 22/40, 55% (40–69%) | 29/40, 73% (57–84%) | 7 → 7 | $0.15 → $0.17 |
| Haiku, discovery | 10/40, 25% (14–40%) | 22/40, 55% (40–69%) | 12 → 10 | $0.22 → $0.21 |
| **All** | **72/160, 45% (37–53%)** | **129/160, 81% (74–86%)** | | **$6.40 → $5.22** |

Brackets are Wilson 95% intervals. Median latency fell from 27 s to 22 s and raw processed
tokens from 28.8M to 24.8M.

Per task (successes of 5; columns Sonnet fixed, Sonnet discovery, Haiku fixed, Haiku discovery):

| Task | Arm A | Arm B |
| --- | --- | --- |
| voyager-jupiter | 5 0 5 0 | 5 5 5 5 |
| cassini-mimas | 5 0 5 0 | 5 5 5 5 |
| psyche-earth-all | 5 0 3 0 | 5 5 2 2 |
| psyche-mars-closest | 5 0 4 0 | 5 5 5 2 |
| mars-elevation | 5 4 4 5 | 4 5 5 5 |
| ingenuity-pin-point | 0 0 0 0 | 5 5 2 1 |
| psyche-mars-closeup (5 turns) | 1 0 0 0 | 5 5 5 1 |
| voyager-neptune-none | 5 5 1 5 | 5 4 0 1 |

How to read it:

- **The reported failure is fixed for three of four configurations.** The five-turn Psyche/Mars close-up went from 1/20 to 16/20; Haiku in discovery mode is the exception (1/5).
- **Discovery mode now works for event searches.** Arm A's discovery runs could not configure an Event Finder search (the definition shape was never shown; 89 "malformed definition" errors in the pilot), so every computed-encounter task failed there.
- **Ingenuity is not a fair comparison.** The pre-#345 viewer cannot report a saved point's coordinates, so arm A's turn 2 is inconclusive by construction. Without that task the totals are 72/140 against 116/140.
- **Regression: the Voyager 1/Neptune refusal** went from 16/20 to 10/20. In 7 of B's 10 failures the answer correctly says Voyager 1 never flew past Neptune, but then presents the distant 3.48e9 km range minimum, which the strict oracle counts as presenting an encounter. Counting "said no and showed the distant minimum" as a pass, the results are 19/20 against 17/20.
- **False success rose from 3 to 7**, five of them Haiku listing Psyche–Earth range minima as flybys without saying none comes within 1 AU. The viewer's own end-of-request check contradicted 12 of B's answers; the panel shows that verdict beside them.

Corrections made during the run, all applied to both arms:

- The judge's camera probe omitted angular size and field of view, so every "legible" check failed.
- Saved-point checks never read the feature's coordinates.
- A 6-hour sample counted 5 Psyche–Earth range minima where a 10-minute sample and the event search both find 9.
- `checkGoal` read only the first 100 results. Cassini–Mimas returns 484, so a correct closest-approach presentation read as "epoch unavailable" in Ask's own check and in the judge. The Cassini cells were rerun after the fix.
- Cells lost to the machine sleeping overnight, or to a sampler stack overflow, were rerun. Cells that had already completed were kept; none was run twice.

Cost of the whole exercise: $16.09 estimated, including the pilot, the interrupted overnight run and the Cassini rerun.

## Not done, and why

- **Factual review of answers.** The judge checks viewer state and a few answer properties (a stated refusal, the distance caveat); dates, ranges and windows in the prose are still `pending-review`.
- **Arm C (selective screenshot review).** Not built. No arm B failure above needed pixels to explain it: each traced to an event-search setup, a refusal presentation or a missing caveat.
