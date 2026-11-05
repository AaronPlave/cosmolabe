## Current review acceptance — 2026-11-01

`current-acceptance.json` records fresh real Sonnet 5.5 requests through the visible Ask form after the metadata and activity-query fixes. Each scenario started in a fresh loaded browser scene; all provider-visible tool results parsed as JSON and no page errors occurred.

- Duration: all 72 flights were ranked before paging. Flight 12 (169.5 s, estimated catalog interval) was selected, paused and sought once to its start; `frameObject(Ingenuity)` presented the vehicle. No extra seeks. The answer retained estimated timing and the missing place link for Airfield H.
- Ambiguity: “longest flight” asked duration versus distance, without selection, time or camera writes.
- MoonFall: the selected synthetic mission landing waypoint was distinguished from the gazetteer crater and overview. The answer named LOLA terrain plus LROC WAC/NAC imagery and reported current-view coverage as unknown. The receipt retains model-visible source/revision/attribution, radial/reference-sphere datum and runtime status; no endpoints or raw traces.
- `compact-ask.jpg` now shows the real Flight 12 answer/input at 390×844 with the overlapping inspector suppressed. `current-moonfall.jpg` shows the actual answer at the dark polar waypoint; it is dataset/interaction evidence, not a new terrain appearance claim.

The exact-value built-in public policy also approves reviewed Jezero imagery attribution and NASA/JPL timing limitations. Custom catalog metadata and resource paths remain withheld. Alt navigation retains its 0.2× speed; Cmd/Ctrl shortcuts are excluded. The proxy distinguishes raw tokens processed from estimated USD, with independent optional guards and unknown-model pricing explicitly unavailable. Python bytecode is removed and ignored.

Validation: 238 focused tests passed; the CI-filtered surface planner passed 9 tests (3 skipped). Package/embed builds, test/viewer/Svelte typechecks, ESLint and purity lint passed. The local full suite passed 3305 tests with 7 skipped; two unchanged local failures remain: GF-reporting progress timing at `gf-reporting.test.ts:183` (also reproduced alone) and the shipped-catalog inventory including five ignored experiment catalogs. These tests/files were preserved. Clean main-target CI is checked separately after push.

The historical evidence below predates these changes.

# PR #326 feedback verification

2026-10-31. Loaded real Ingenuity/Jezero and MoonFall catalogs in headless Chrome with hardware ANGLE/Metal on Apple M4 Max. Data loaded through the viewer's development asset fallback. Source geometry, coordinates, physical diameters and provenance were not changed.

## Landing-site framing

The browser reproduced the previous missing-diameter path by navigating to Airfield B's actual coordinates with generic automatic overhead range: **1016.858 km**. Navigating to the same catalog place through the shared place path now produces **0.500 km**, overhead and oblique. The actual 47.521198 km Jezero crater retains diameter fitting at **71.281797 km**. `local-receipt.json` retains measured ranges; `airfield-b-overhead.jpg` shows the corrected point framing. The point range is a navigation default, not an asserted landing-zone size. Surface eye height and explicit custom range behavior are preserved.

## Real Sonnet Flight 5 acceptance

The actual Ask input received “Show Flight 5, navigate to its landing location, and tell me what imagery is available.” Playback initially ran at 1×. The example loopback proxy requested and reported `claude-sonnet-5-5` in all five rounds; fallback was disabled (the response's fallback metadata was unknown). `sonnet-flight5.json` retains a concise historical receipt: response, final selections/range/clock, model and usage counters.

The run paused through the existing `setPlaying` tool, selected Flight 5, sought its start, navigated to Airfield B, queried imagery, and read the scene back. Final time **673687471 ET** exactly matched the activity start; playback was **false** and camera range **0.500 km**. The answer states paused playback, estimated timing, the name-match association rather than a direct reference, waypoint provenance and the four imagery layers. Both activity and place remain selected despite no selected object. No page errors occurred.

`sonnet-flight5.jpg` shows historical desktop acceptance. The original resized compact capture exposed an activity-inspector/Ask overlap, addressed in the subsequent follow-up below. The earlier run before clarifying that “show an activity” means inspection left playback running and disclosed it; the clarified prompt was then verified with the successful paused run above. Pause remains a model instruction through ordinary host tools, not an implicit behavior of `seekActivity`.

## Other feedback

- An actual browser wheel gesture between tool calls made the next camera write return `interrupted`; reads remain available. Manual input is now notified immediately, before the next animation frame; tests cover wheel, keyboard and typing exclusions, flight arrival, event relay/disposal and a new request after earlier input.
- Surface inventory no longer calls terrain memory accounting. Tests throw if the expensive model traversal is touched and exercise loaded/disposed residency. A loaded-browser sample of 100 Mars inventory reads took **2.2 ms total**, an observation on this device rather than a performance guarantee.
- The executable proxy listener was observed at **127.0.0.1:8788**, not a wildcard address. Scripted-provider proxy tests passed without any model calls.
- The earlier desktop/compact browser check verified “Checked surface datasets on Moon” in expanded Actions using a local scripted response (no model API). The playback label also reads the verb's actual `on` argument.
- Tests cover continuing playback, explicit pause, and a host refusing pause/seek. Existing clock ownership and seek semantics are preserved; no new selection or time store was added.

Validation: 557 distinct focused tests across control, Ask, viewer control/navigation/shell, all camera-control suites, terrain sampling/status and proxy adapters passed. Build and embed build, viewer/test/Svelte typechecks, changed-file ESLint and `git diff --check` passed. The full repository suite was not run.

#325 is still open, so #326 stays on its stacked base. Main-target CI remains a merge prerequisite after #325 lands; neither PR was merged or retargeted for this verification. Live OpenAI acceptance is outside this Sonnet follow-up and remains unverified here.

## Subsequent review follow-up

The branch now incorporates `main` after #325 merged. The preceding text records the original verification context; the stacked-base statement above is historical, not current integration status.

Model-facing reads now project metadata explicitly: no resource endpoints, source segments or arbitrary source fields; provenance defaults to withheld except for a closed scientific vocabulary. Trusted hosts can approve exact public metadata values/attribute pairs. Local control reads retain rich metadata. Regression coverage inspects the next model request with nested private identities, path-embedded secrets, private field keys/values and private descriptions/attributions. Approved public identity/revision/attribution, datum, timing and runtime observations survive projection.

`compact-ask.jpg` and `compact-receipt.json` verify the loaded Ingenuity catalog at 390×844 with Flight 5/Airfield B selected and a local scripted answer. The active compact Ask sheet suppresses the timeline inspector so the answer/input remain usable. Closing Ask restores the inspector with selection intact. This is not a new model acceptance run. No browser page errors; sheet scrollTop stayed zero.

Evidence was reduced to two representative historical acceptance/framing JPEGs plus the new compact capture. Original PNGs and redundant label/crater captures were removed. Historical JSON receipts retain provider/model/usage, answer, final state and measured ranges, without raw tool dumps or resource paths.

Follow-up validation: 488 focused tests passed across agent/control, viewer/Ask/shell, camera controls, terrain status and proxy suites; 9 locked surface-planning tests passed (3 unrelated cases skipped by the CI pattern). Package/embed builds, viewer/test/Svelte typechecks, purity lint and changed-file ESLint passed. The local full suite finished with 3296 passed, 7 skipped and one failure: five ignored MoonFall experiment catalogs are included by the shipped-catalog inventory test. Those files were preserved. Clean main-target CI is checked separately after push.
