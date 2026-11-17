# Ask follow-ups: goal lifecycle, requested quantity and result presentation (#381)

> Historical record at `bc6a17ca`, before the #382 review fixes. The measured before/after numbers below are retained. Boundary selection, insertion wording, result hierarchy and Place-distance readback are corrected in [382-review.md](382-review.md).

All live runs: `claude-haiku-5-5`, fixed tools, Chromium SwiftShader, `ASK_BENCHMARK_SUITE=followup` and
`ASK_BENCHMARK_SUITE=efficiency`. Estimated spend for every run in this work, including failed harness
attempts: about $0.13 (proxy estimate, not a bill). Single observations per cell, not success rates.

## What was wrong (minimized replay)

Two frozen three-turn cases reproduce the screenshot session. Before each, the harness runs the native
closest-approach search and presents its closest result, as the person had done.

| Case | Turns |
| --- | --- |
| `cassini-saturn-followup` | "Show me what Closest approach: Cassini / Titan found…" → "show me when cassini is furthest from saturn after initial orbit insertion" → "compare that with the Titan encounter" |
| `clipper-europa-followup` | Europa Clipper / Europa result → "show me when clipper is farthest from jupiter" → "compare that with the Europa encounter" |

Baseline failures, from the traces:

1. **Stated goals never expired.** A `checkGoal` predicate was held across every later request. An
   action's own `epoch` could not replace a stated one, so a new question about another time failed on the
   old clock or event unless the model remembered `release`. Haiku released some slots and not others.
2. **No native "farthest".** "Furthest from Saturn" became reference-ellipsoid or sphere height
   (the screenshot's 9,035,981 km), a 32-sample profile, or the closest point reported as "a flyby"
   (80,246 km). The host's fact summary only described minima, so it relabelled a sampled maximum as a minimum.
3. **"After orbit insertion" had nothing to ground on.** The catalog has SOI only as viewpoint names.
4. **Coverage gaps refused explicit intervals.** Cassini's kernels have a 6-second gap at 2005-04-07, so
   an explicit post-insertion interval could not be searched at all.
5. **Presentation.** The panel showed whatever text survived plus "N viewer changes completed",
   "Checked in the viewer." and "Viewer check: …; ." lines, with slot names in failures.

## What changed

- **Goal lifecycle** (`outcome.ts` `carryOver`, `agent-loop.ts`). Earlier requests' goals arrive as
  `prior`. They are still checked, but any change in the new request on the same slot or domain supersedes them,
  as does selecting or running a different search. `keep: true` (the person said keep, leave or stay)
  keeps stated rank and still refuses contradicting changes. A stopped or failed request leaves only `keep`
  goals. Camera or clock moves between requests retire those domains.
- **Farthest point** (`closest-approach` kind `extremum: maximum`, GF `LOCMAX`/`ABSMAX`;
  `findClosestApproach` `extremum: 'farthest'`; `range-descending` ranking). The operation checks the coverage edges.
  When the range is larger at an edge than at every turning point, it publishes a `range-edge` fact and a
  limitation instead of calling the turning point the farthest. Explicit intervals search each covered piece
  and disclose internal gaps. Uncovered ends are still refused. Ranking follows the search's own extremum.
- **Derivation, not catalog names.** The guidance says to take the first range minimum in loaded coverage as
  insertion and search the farthest point from there. "Distance from X" means center range, never a height metric.
- **Panel** (`lib/ask/result.ts`). The answer comes first. One outcome line is built from typed facts
  ("Showing farthest point · Saturn → Cassini · 2004-08-27 08:56 UTC"). At most one limitation is
  phrased in user terms ("Shown at the right time, but Europa Clipper not drawn at this time"). A host account
  is labelled. Checks, goal changes and raw ET appear only under Action details.

## Final-head outcome

| Turn | Cassini | Clipper |
| --- | --- | --- |
| 1, saved result | verified · Titan 3,601.5 km center range, 2005-04-16 19:11 UTC, not called a flyby | verified · Europa 1,584.73 km, 2031-10-23 21:46 UTC, not called a flyby |
| 2, farthest | **verified** · insertion derived as first periapsis 2004-07-01 02:38 UTC; farthest 9,095,761 km center range at 2004-08-27 08:56:46 UTC; searched to the 2005-07-24 end of coverage | **failed (truthful)** · 968.9 million km at 2026-07-08 09:44 UTC; paused there, but the catalog draws Clipper only from 2030, so the pair cannot be framed, and the answer says so |
| 3, compare | no change, no stale goal; distinguishes the two ranges | no change, no stale goal; distinguishes the two ranges |

Baseline turn 2 on the same harness: Cassini reported the 80,246 km periapsis as the answer and failed on
the stale event goal. Clipper found no result.

## Efficiency: pinned set, before (merge base `1cc09faf`) and after

Columns: rounds / raw processed / uncached input / cache read / cache write / output tokens / est. USD / seconds.

| Task | Before | After | Status before | Status after |
| --- | --- | --- | --- | --- |
| pause-select (routine) | 3 / 40,729 / 8 / 37,221 / 3,010 / 490 / 0.0010 / 6.7 | 3 / 40,732 / 8 / 37,305 / 2,928 / 491 / 0.0010 / 6.0 | done | done |
| cancel-after-write (interruption) | 2 / 26,359 / 6 / 23,974 / 1,637 / 742 / 0.0008 / 5.0 | 2 / 25,571 / 6 / 24,074 / 969 / 522 / 0.0006 / 4.7 | cancelled | cancelled |
| voyager-neptune-none (missing data) | 4 / 64,117 / 12 / 56,574 / 6,126 / 1,405 / 0.0020 / 12.7 | 5 / 77,732 / 14 / 70,960 / 5,501 / 1,257 / 0.0020 / 12.5 | verified | verified |
| earth-moon-switch (two turns) | 5 / 66,647 / 14 / 61,379 / 4,298 / 956 / 0.0016 / 8.5 | 5 / 66,355 / 14 / 61,425 / 4,086 / 830 / 0.0015 / 7.1 | verified ×2 | verified ×2 |
| clipper-discover (exploration) | 4 / 55,857 / 10 / 50,911 / 3,856 / 1,080 / 0.0015 / 8.9 | 4 / 55,615 / 10 / 52,099 / 2,508 / 998 / 0.0013 / 8.5 | verified | verified |
| cassini-saturn-followup | 11 / 182,883 / 30 / 158,922 / 18,655 / 5,276 / 0.0066 / 32.0 | 10 / 160,080 / 28 / 140,683 / 14,288 / 5,081 / 0.0057 / 30.4 | turn 2 failed | all verified |
| clipper-europa-followup | 11 / 164,974 / 28 / 149,160 / 11,564 / 4,222 / 0.0051 / 27.9 | 12 / 191,776 / 30 / 173,733 / 13,201 / 4,812 / 0.0058 / 30.9 | turn 2 failed (no result) | turn 2 failed (undrawn, truthful) |

Reading it: cost is flat on routine tasks. The gain is correctness on the follow-ups, not tokens. The
capability hunting seen in the first baseline (8–10 rounds and 150–250k tokens on turn 2) came from the missing
farthest operation. With it, turn 2 now takes 4–6 rounds. The run-to-run spread on single cells is as large as the
before/after difference, so no savings percentage is claimed. Verification and safety checks were not removed.
The legacy `toolMode` check and the Voyager `noEncounterPresented` check fail identically in both arms; they are
harness/rubric issues unrelated to this change.

## Validation

- `npx vitest run`: all pass except `cspice-wasm/src/gf-reporting.test.ts` "keeps the first pass inside the first half",
  which fails identically on the merge base.
- `npm run typecheck:tests`, `typecheck:viewer`, `typecheck:svelte`: clean. `node scripts/test-ask-status-ui.mjs`: passes.
- New: `packages/control/src/goal-lifecycle.test.ts` (Titan → Saturn farthest, rotate-around, another search,
  partial result, keep across time change, conflicting keep refused, user clock takeover, cancellation, scene reload)
  and farthest/edge/gap/incomplete-presentation cases in `closest-approach.test.ts`.
- Fixture screenshots at 100%, 125%, 150% and a 420 px window: no horizontal overflow, composer stays in view.

## Known limitations

- The farthest search finds turning points at the Event Finder step (1 h default). The edge check covers
  monotonic ranges. Neither is a certified global maximum, and the answer says "in loaded coverage".
- Deriving insertion as the first periapsis is a heuristic the answer discloses. It is wrong for missions whose
  loaded data starts after insertion.
- A spacecraft that the catalog does not draw at the result time cannot be framed. Ask reports it rather than
  substituting another view.
- `keep` depends on the model marking enduring constraints; ordinary goals no longer depend on it remembering `release`.
