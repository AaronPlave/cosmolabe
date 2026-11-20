# PR #382 review fixes

The two P1 reports were confirmed defects: coverage edges were warnings after selection and monotonic intervals returned no result; first observed periapsis was incorrectly identified as insertion. The result-hierarchy request was also confirmed: model prose still led. The Ingenuity–Belva report exposed a missing shared control read, despite the existing spatial resolver supporting the needed endpoints.

## Implementation

- Native `closest-approach` maximum searches evaluate interval ends with the same provider and aberration correction as interior extrema. A winning end becomes a real `coverage-boundary` event, ranked and selected through the existing result list, clock, camera and timeline. A monotonic window now has a result. Missing boundary measurements fail rather than certifying an interior winner. Global ranking uses the maximum direction; the configured range filter still applies.
- Guidance requires a genuinely sourced insertion epoch, or explicit scope **after the first observed periapsis in loaded data**, or one clarification. It does not infer insertion from a viewpoint name or periapsis. A truncated Juno case guards this distinction without mission-specific knowledge.
- Ask leads with typed quantity, km and UTC, then native selection/view status and one consequential limitation, using #339 typography roles. The selected result wins over other items on its page. Full model explanation and diagnostics expand separately. Plain chat, unsupported requests and comparisons keep their normal prose layout.
- `ViewerControl.getPlaceDistance(object, ref)` bridges a mapped Place anchor to the existing `SpatialEndpoint` / `resolveSpatialRelationship()` path. It returns current straight-line distance, epoch, declared frame/datum and position availability. Missing mapped height means zero on the declared reference shape. This is not rim distance or physical terrain; registration and accuracy remain unknown. Incompatible frames/datums and unavailable positions return no estimate. No geographic Event Finder was added; **when closest** remains explicitly unsupported.

## Acceptance method

Live Haiku, fixed shipped tools/permissions, Chromium SwiftShader; the user explicitly authorized public test-scene/tool projections to Anthropic. `ASK_BENCHMARK_SUITE=review382` reuses the actual three-turn Cassini and Clipper cases and adds a monotonic Clipper interval and the two-turn Ingenuity–Belva case. The harness records visible DOM text, exact native selected result/range/epoch, independent view projection and screenshots per turn. These are single observations, not reliability rates.

The harness now enables the optional Ask panel explicitly and reruns a renamed seed, because any native query upsert invalidates the previous run. It requires the test viewer's shipped proxy configuration (`VITE_ASK_ENDPOINT=http://127.0.0.1:8799`); it does not substitute embedding permissions.

The original efficiency measurements remain in [381-results.md](381-results.md). No broad cost savings are claimed, and no verification was removed to meet a token target.

## Validation

- 482 focused tests pass, including all control tests, maximum/boundary/ranking/filter cases, goal lifecycle, answer presentation, Place distance and the public capability contract.
- Build, lint and all three typechecks pass.
- Full suite with fixture TCP servers enabled: 4,180 passed; one previously documented CSPICE timing failure, `gf-reporting.test.ts` “keeps the first pass inside the first half while it runs”. Sandbox-only fixture-server failures were isolated by rerunning with local listeners enabled.
- Local deterministic/native browser checks are separate from real-model acceptance; software rendering is not a physical GPU certificate.

The native event callout and selected-result readout also distinguish **Farthest point** from **Boundary maximum** and lead with range for maximum searches. Ordinary closest approaches retain altitude-first native readouts. A no-change comparison receives the current native event identity separately from historical referents; the answer checker rejects the reproduced stale “Titan is still framed” claim while Saturn–Cassini is selected. This adds no persistent goal or navigation.

## Validation

Runtime implementation tested: `87ed58e5` (including `67f65c77`, `0ab62d23` and `135f7591`). All provider runs explicitly authorized by the user; `claude-haiku-5-5`, fixed tools, shipped Ask approval path, Chromium SwiftShader. No physical GPU acceptance or statistical reliability claim. Three useful final-run screenshots are retained below; raw traces stay outside the repository.

Reproduce with a viewer configured with `VITE_ASK_ENDPOINT=http://127.0.0.1:8799/`:

```sh
ASK_BENCHMARK_LIVE=1 ASK_BENCHMARK_MODELS=claude-haiku-5-5 \
ASK_BENCHMARK_SUITE=review382 CL_VIEWER_URL=http://127.0.0.1:5797/ \
node scripts/benchmark-ask.mjs
```

The harness waits for the intended catalog object and assessed coverage, enables the optional Ask tool, and reruns a renamed seed because `upsertEventQuery` invalidates its previous run. It records the visible answer separately from model text, plus native selected epoch, result range, query/window and camera projection. Native and layout checks without a provider:

```sh
CL_GPU=software node scripts/test-ask-382.mjs
```

Focused automation covers larger edges, monotonic-only maxima, global maximum ranking, unavailable boundary evaluation, range filters, actual selected epoch, boundary-vs-interior metadata/callouts, truncated non-Cassini periapsis semantics, selected result vs page-tail values, current-view comparison contradictions, and mapped-point frame/datum/coverage/unknown accuracy/current-vs-time-minimum separation.

- 515 focused tests pass across control, Ask/result presentation, Event Finder callouts, spatial readback, core event kinds and the public capability contract.
- Build, lint and test/viewer/Svelte typechecks pass.
- The broader local suite passed 4,180 tests with the existing `gf-reporting.test.ts` timing assertion failure, before the final selection-claim regressions. That test file is unchanged from main. Local fixture server tests require permission to listen on TCP; the unrestricted run removed the sandbox-only failures.
- The earlier measured efficiency numbers in [381-results.md](381-results.md) are preserved as historical evidence. No savings claim is made for these review fixes.

## Final live outcomes

The actual three-turn sequences, the distinct monotonic interval, and the two-turn mapped-point case all completed. [Compact native evidence](382-evidence.json) verifies selected UTC against the native clock and typed range/UTC against the selected native event. Presentation failures below are retained as failures; the numerical result is not flattened into a successful view.

| Case | Native result and visible answer | Outcome |
| --- | --- | --- |
| Cassini / Titan saved search | 3,749.030235 km center range, 2004-10-26 15:30:04.770 UTC. The reply also identifies the closer 2005 result from the other coverage piece, without claiming it is selected. | Verified |
| Cassini farthest from Saturn | 9,095,760.600003 km, 2004-08-27 08:56:46.152 UTC. Explicitly searched after the first observed Saturn periapsis in loaded data; no insertion epoch is established. | Verified; comparison leaves this selection/time unchanged and says so |
| Clipper / Europa then Jupiter | Europa minimum 1,584.733930 km at 2031-10-23 21:46:27.619 UTC; Jupiter maximum 968,920,639.494380 km at 2026-07-08 09:44:54.026 UTC. | Europa verified; Jupiter view fails truthfully because Clipper is not drawn; comparison retains the current 2026 view |
| Clipper / Jupiter, 2030-01-01 to 2030-01-02 | **One candidate, the boundary maximum:** 59,655,586.022130 km at 2030-01-01 00:00:00 UTC. This is selected in the native lane/readout and labelled Boundary maximum. | Correct boundary and epoch; view remains incomplete because Clipper is not drawn |
| Ingenuity / Belva current distance | 5.222686 km at 2021-07-05 09:00:08 UTC, `IAU_MARS`, zero height on the declared Mars ellipsoid, geodetic-normal datum; available at this epoch, accuracy unknown. | Native read succeeds; camera/clock unchanged |
| Ingenuity / Belva “when closest?” | Geographic-point time search is unsupported. No numerical minimum, accuracy or closest epoch is invented. | Truthful limitation; no search/navigation |

Numerical digits above identify the programmatic readback; they are **not** source-accuracy estimates. The stored screenshot readouts use bounded display precision. The full model explanation remains expandable. The native event title/readout and the main quantity, UTC, current-view outcome and limitation were inspected in these actual final-runtime answers:

- [Cassini farthest result](382-images/cassini-farthest.png)
- [Clipper boundary maximum with incomplete drawing disclosed](382-images/clipper-boundary.png)
- [Ingenuity mapped-point distance with datum and unknown accuracy](382-images/belva-current.png)

Local native readout checks at 1280 px / CSS zoom 100%, 125%, 150% and 420 px / 100% show no measurement overflow and keep the composer in view. With the native inspector and several event lanes open, Ask requests a 65 cqh docked height through the shared panel component and scrolls completed results to their quantity/value rather than their diagnostics. The shared dock remains at scrollTop zero in the native layout checks.

Final four-case rerun: 31 model requests, 502,798 processed tokens (80 uncached input, 446,454 cache-read, 43,319 cache-write, 12,945 output), estimated $0.01636, actual billing unknown. These numbers describe only this final rerun, excluding earlier diagnostic attempts; they are not a before/after efficiency comparison. The earlier measured before/after table remains untouched. One observed Clipper explanation called computed candidates “hourly samples”; a focused contradiction check now rejects that phrasing, preserving the distinction between GF turning points and uniform profile samples. A mixed event/range-rate regression ensures genuine sampled-profile evidence is still allowed; all nine retained live answers also pass the final checker.

## Scientific limits

All extrema remain step-limited searches in the declared covered interval, not certified global extrema. Internal coverage gaps remain explicit. A first observed periapsis supplies an explicitly disclosed search scope, never proof of orbit insertion. A selected result at the right time can still fail visual presentation when the catalog does not draw the spacecraft there. Place distance means the mapped reference anchor (zero height on its declared reference surface when absent), with unknown source registration and positional accuracy; it is neither crater-rim distance nor physical terrain clearance. A geographic-point closest-time solver remains unavailable.
