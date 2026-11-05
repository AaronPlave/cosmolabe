# Ask final pass: intent before change, bounded context (#345, PR #351), 2026-11-05

This pass answers the review after the [2026-11-04 final gate](2026-11-04-final.md). In five of Haiku's six misses there, the model left the person's intent out of the goal, so an otherwise valid action was verified against an incomplete objective. The review also asked that the model's context stay bounded as operations are added, and for a subtraction pass. Per-run data, with every answer: [2026-11-05-final-pass-runs.json](2026-11-05-final-pass-runs.json).

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
