# Ask final pass: intent before change, bounded context (#345, PR #351), 2026-11-05

This pass answers the review after the [2026-11-04 final gate](2026-11-04-final.md). In five of Haiku's six misses there, the model left the person's intent out of the goal, so an otherwise valid action was verified against an incomplete objective. The review also asked that the model's context stay bounded as operations are added, and for a subtraction pass.

## What changed

All changes reuse the existing contracts, predicate evaluator, loop and harness. There is no new goal representation, planner or per-phrase handler.

- **Intent comes before any change.** In each request, the first change is refused until the model has stated the person's goal with `checkGoal`. The statement can go in the same reply, so it costs no extra round. `require: []` is allowed when the actions alone say everything.
- **What the person stated outranks what an action derives.**
  - Stated predicates carry a `stated` mark. They hold across the conversation until the person restates them or the model releases them.
  - An action's own postconditions never replace or retire a stated predicate. Only derived camera predicates retire when the camera's subject changes.
  - A change whose own expected result contradicts a stated predicate is refused before it runs. This covers a different selection or tracked object, a pin on the reference ellipsoid when the person said "on the ground", a result that is not the closest or not a real encounter, and a `state` value.
  - Composition, distances and times can only be judged after the change, and they are.
- **"All" is checkable.** `eventRun {whole: true}` requires the search window to span the pair's whole loaded coverage. If the coverage is unknown, the check is inconclusive, never met.
- **Unnamed event intent binds to the request's own search.** A stated `eventSelected`/`eventRun` can leave the search unnamed: it binds to the search the request runs or presents. A name the viewer does not have, such as a label or a search not yet created, binds the same way instead of being held where it could never be met. The pilot found this case.
- **Two false positives removed.**
  - `legible` alone no longer verifies a view: an object out of frame or hidden fails it outright. Its small-size verdict counts as secondary only beside an `inView` or `range` check on the same object.
  - A search's own max-range filter is no longer an encounter criterion. Without a sphere of influence, a range minimum is unclassified.
- **Bounded model context.**
  - The system prompt carries the core rules and the guides of the six directly offered tools only.
  - The `invokeCapability` index lists IDs and signatures within a fixed budget (`CAPABILITY_LIMITS.index`); operations past it are counted and found with `listCapabilities`.
  - Operations with notes are marked `*`. Their notes come from the same registry through `describeCapabilities`. Otherwise, the first change returns them instead of running, and a read returns them alongside its result.

## Is the code simpler?

Mostly the same size, with one rule replacing several special cases.

**Production code.** `packages/control/src` without tests went from 6,260 to 6,356 lines: +171/−75 since `2c3e91e4`.

**What was added:**
- The goal-first rule (about 10 lines in the loop).
- The `stated` mark and binding (about 20 lines in `adopt`).
- `eventRun.whole` (8 lines).
- The bounded index (about 20 lines).
- The notes-on-first-use gate (about 10 lines).

**What was removed or folded:**
- The per-request `protect` set.
- The eventSelected-only precondition. It is now one generic comparison over the fields a stated predicate defines.
- The max-range encounter criterion.
- The prompt's full list of feature guides.
- The harness's copies of the distance and date parsers, which now come from `answer-check.ts`.
- Eight unused engine exports.
- The superseded 2026-11-03 report.

**Two costs of this design, measured below:**
- A request now always makes one `checkGoal` call.
- Operation notes reach the model later than when they were all in the prompt. The pilot showed this matters: Haiku stopped finding the "save a point at the pin" notes. The fix was to attach them to the probe read the model already calls, not to grow the prompt again.

## Offline evidence (PR CI, $0)

`ask-engine.test.ts` replays the final gate's Haiku misses with a scripted model:

| Miss | What the test shows |
| --- | --- |
| Closest | Stated unnamed, it binds to the presented result; the distant minimum is refused before it is shown, and the closest then verifies. |
| All | A search missing part of the coverage fails the stated goal, and the answer must say so. |
| On the ground | A pin on the reference ellipsoid is refused before it is placed. |
| Keep it close | A stated distance survives a change of camera subject, so a later view that loses it is not verified. |

The same file also covers:
- **No stated goal:** a change before the goal is stated does not run.
- **Conflicting goals:** an action cannot overwrite what the person stated, but the person restating it can.
- **Unknown names:** a search label binds instead of being held unmet.
- **Registry growth:** 300 extra operations leave the prompt byte-identical and the index within budget, and the last one is still found, described with its notes, and run.

`outcome.test.ts` adds:
- `legible` alone failing when the object is out of frame or only a few pixels across.
- `whole` coverage.
- An inconclusive result when coverage is unknown.
- Stated predicates outranking derived ones.
- The model being unable to mark its own predicate as stated.

Add/remove extensibility and the earlier suites are unchanged.

## Live evidence

All runs are fixed tools and use the same harness judging as the final gate. The commits differ because each batch tested the fix before it:

| Batch | Commit | Model, effort | Passed | False success | Cost |
| --- | --- | --- | --- | --- | --- |
| Pilot, all 26 tasks once | `e6f14d25` | Haiku, default | 23/26 | 0 | $0.10 |
| 9 hard and held-out tasks × 5 | `c821231e` | Haiku, default | 37/45 | 1 | $0.20 |
| Re-run of the two affected tasks × 5 | `e2309c3d` | Haiku, default | 5/10 | 1 | $0.06 |
| Ingenuity pin then point × 5 | `2bf0c062` | Haiku, default | 3/5 | 0 | $0.03 |
| 5 hard tasks × 2 | `daacdaa2` | Sonnet, **low** | 8/8 (2 stopped by the spend cap) | 0 | $0.45 |

Haiku, by task, on the latest code for each task:

| Task | Result | Note |
| --- | --- | --- |
| The four held-out paraphrases (closest, every approach, a marker on the surface, a three-turn close-up) | 24/24 (pilot + 5 each) | Worded after the final gate. |
| psyche-earth-all (every minimum) | 5/5 | Was 9/10 at the final gate. |
| psyche-mars-threshold | 5/5 | |
| psyche-mars-closeup (five turns) | 5/5 | Was 9/10. Before the binding fix, a stated search label held an unmeetable goal for the rest of the conversation (pilot, 1 run). |
| psyche-mars-closest | 4/5 | The miss chose the asteroid 16 Psyche instead of the spacecraft; the stated "closest" held on the wrong pair. |
| ingenuity-pin-point (pin, then "place a point") | 3/5 | Was 7/10. Turn 1 passed every time. In the 2 misses, turn 2 saved the point but did not select it. Before the probe-notes fix, Haiku treated the pin as the point (0/10, 2 false successes). |

Sonnet at `effort: low` passed every hard task it finished (8/8), including the pin then point, at about $0.05 per run. That is close to its cost at default effort at the final gate, so the lower effort did not buy a meaningful saving here. Two runs were stopped by the harness spend cap and are not counted.

## Release decision

- **Haiku does not meet the truthful verified-task gate on the hard tasks.** It is reliable on searches, closest, all and refusals once intent is stated. It still misses multi-step authoring: it saves the point but leaves it unselected.
- **Sonnet stays the default.** The shipped default (`examples/ask-proxy`: `claude-sonnet-5-5`) is chosen before any change, and no part-run request is replayed on another model.
- **Effort.** `ASK_REASONING_EFFORT` now also sets `output_config.effort` for Anthropic models. Eight runs at `low` are too few to change the default, so it stays unset.

## Cost and limits

- **Spend.** Estimated spend for this pass was **$0.85**, against the $2.00 ceiling: Haiku $0.40 (including a stopped run) and Sonnet $0.45. Every invocation had a hard dollar cap. These are token-count estimates, not a bill.
- **Sample sizes are small.** Haiku had 5 repetitions per hard task and Sonnet 2. None of these numbers is a statistically proven rate; the per-task counts above are what was observed.
- **Discovery mode** is covered offline only, as before.
- **Harness host load.** One Haiku batch was stopped partway because two unrelated browser processes had saturated the CPU and the viewer timed out loading scenes. Its runs are not counted; the batch was re-run.

## Release review follow-up (2026-11-05)

The release review asked for Haiku as the default, Sonnet only where a small deterministic policy says so, three correctness fixes, and no large new benchmark.

**Model routing.**
- The proxy now answers with Haiku by default (`ASK_MODEL`). It uses Sonnet (`ASK_ESCALATION_MODEL`) only when the viewer asks for escalation. The client can ask for escalation but never name a model.
- The policy is `runAgent`'s `escalate` option. The default, `escalateDestructive`, routes a change whose contract marks its input destructive: deletion, replacement, whole-state restore.
- Routing happens only before a request's first change. The proposed change is dropped unrun, and the same round is asked of Sonnet, which keeps the request. Once a change has run, the request stays on its model, so nothing partly done is replayed.
- A host replaces the policy, or disables it with `() => null`.
- The result records why a request was routed (`escalated`), and the panel shows it.

**"Place a point".** The person did not ask for selection, so the benchmark no longer requires it. The `editAnnotation` notes say to select a point only when the person asks. `featureUnder` takes the selected point, or else the nearest in the annotation layer; selection stays `featureSelected`'s to require.

**Correctness.**
- **`eventRun {whole:true}`** is met only when the solver can promise "every" result:
  - a local search, not a deepest-only one, which is now unmet;
  - a step no coarser than the event kind's default step (the shortest event it should not miss);
  - one exact coverage window, spanned to within a step.
  A coarser step, disjoint or estimated coverage, and unknown coverage are inconclusive. Negative tests cover each case.
- **`legible`** now fails an object fully hidden behind a nearer body, using the same occlusion test as `inView`.
- **Verified for the changes vs verified for the request.** `RequestResult.intentStated` says whether the request stated what the person asked for. With `require: []`, a `verified` result covers each change's own result only, and the panel says so: "Each change checked in the viewer; the request as a whole was not stated, so not checked."

**Live check:** commit `394063ff`, Haiku with Sonnet escalation, estimated $0.10 for this round. The first batch's viewer served a stale build of `@cosmolabe/control`, so its pin-then-point runs were rerun on a fresh build and are not counted.

| Task | Result | Note |
| --- | --- | --- |
| bookmark-delete-declined | 3/3 | Turn 1 ran on Haiku. Turn 2, the deletion, was routed to Sonnet before it ran; the approval was asked and declined, and the bookmark remained. |
| psyche-earth-all | 6/6 | Haiku only. The search used the kind's 1-hour step over the single coverage window. |
| ingenuity-pin-point | 2/3 | Haiku only. In the miss, Haiku asked whether "a point" meant another pin or a saved point, and changed nothing. |

The rescoring also recognises "haven't" as a negation, so a clarifying question is no longer counted as a false success.

**Spend.** The whole review, including this round, is an estimated **$0.95** against the $2.00 ceiling. A routed request costs one discarded Haiku round, about $0.001 here. Haiku runs on these tasks cost $0.002–$0.006 each. The routed deletion turns cost $0.006–$0.031, nearly all of it Sonnet.

**Release decision, revised.** Haiku is the default. Sonnet answers only requests the routing policy names, decided before any change. Nothing is replayed after partial execution. Evidence for Haiku on its own is the tables above and the final-pass results. Its remaining measured misses are two:
- **"Closest" (1/5):** Haiku read "Psyche" as the asteroid 16 Psyche, not the spacecraft, and Ask reported the result as verified. The viewer checked the search it ran, but it cannot check which body the person meant. This is the residual risk of a Haiku default: an interpretation error with a confident answer.
- **"Place a point" (1/3):** Haiku asked a clarifying question and changed nothing.

## Efficiency pass (2026-11-05)

The review traced the seven-round Cassini–Titan request and asked for small changes only: no new Event Finder orchestration, planner or macro.

**Where the rounds went.** The final gate's Haiku trace ("when did cassini get nearest to titan? show me") was: `describeScene`; `getEventSearchOptions`; configure two searches, one per coverage window, with one invalid definition retried; run both; one result page each; present.
- **Necessary waits:** options, then configure, run, page, present. Each needs the result of the one before it: coverage, a saved search, results, and a result reference.
- **Avoidable:**
  - `describeScene` when the request names its bodies;
  - the invalid-definition retry, which was a model error;
  - on current code before this pass, two first-use refusals. `upsertEventQuery` and `presentEventResult` were each refused once just to show their notes.

**What changed.**
- **Notes come with the read that precedes the change.** A read now also returns the not-yet-seen notes of the other operations in its contract namespace. `getEventSearchOptions` therefore carries the event search, result page and present notes, so neither change is refused. Writes still return their notes instead of running if no read or description came first. Nothing runs before the model has seen its constraints, and no discovery call was added.
- **Reads resend no observation.** A read's model-facing receipt carries only its ID, status and warnings, because its data is the observation. The full receipt stays in the host trace and `getOperationResult`. `describeScene` had sent most of its scene a second time.
- **`getEventSearchOptions` with a kind** returns that kind's defaults only. An unknown kind still lists them all.
- **The Details view is no longer cut at 8,000 characters.** Each step is collapsible, with its input and full host result, and Copy full trace copies everything.

- **Seen means delivered (final review).** Notes count as seen only once a result carrying them has gone back to the model intact. A guided change in the same reply as the read or description that carries its notes is refused once. So is one after a result omitted for size. Two offline regressions cover these cases.

**Offline replay, $0.** The same call sequence, scripted against a fake host with eight event kinds:

| | Rounds | Refusals | Model input across rounds (chars) | describeScene result | getEventSearchOptions result |
| --- | --- | --- | --- | --- | --- |
| Before | 9 | 2 | 250,733 | 1,738 | 2,742 |
| After | 7 | 0 | 173,398 (−31%) | 735 | 2,108, including the domain notes |

`ask-engine.test.ts` keeps this as a regression test.

**Paid runs.** None were made, because the replay answers the question.

**What would take fewer rounds and was not done.** Five waits are inherent to the existing `eventControl` surface: options, configure, run, page, present. A model can already batch configure and run in one reply, since calls in a batch run in order. Going below five would need one operation that searches and returns ranked results, which is a new Event Finder API. Per the review, it is not in #351.
