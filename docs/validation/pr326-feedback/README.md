# PR #326 feedback verification

2026-10-31. Loaded real Ingenuity/Jezero and MoonFall catalogs in headless Chrome with hardware ANGLE/Metal on Apple M4 Max. Data loaded through the viewer's development asset fallback. Source geometry, coordinates, physical diameters and provenance were not changed.

## Landing-site framing

The browser reproduced the previous missing-diameter path by navigating to Airfield B's actual coordinates with generic automatic overhead range: **1016.858 km**. Navigating to the same catalog place through the shared place path now produces **0.500 km**, overhead and oblique. The actual 47.521198 km Jezero crater retains diameter fitting at **71.281797 km**. `local-receipt.json` includes camera poses and surface-navigation diagnostics; `airfield-b-overhead.png` and `jezero-crater.png` show both views. The point range is a navigation default, not an asserted landing-zone size. Surface eye height and explicit custom range behavior are preserved.

## Real Sonnet Flight 5 acceptance

The actual Ask input received “Show Flight 5, navigate to its landing location, and tell me what imagery is available.” Playback initially ran at 1×. The example loopback proxy requested and reported `claude-sonnet-5-5` in all five rounds; fallback was disabled (the response's fallback metadata was unknown). `sonnet-flight5.json` retains the wire tool trace, response, final selections/camera/clock, imagery inventory and separate usage counters without duplicating full model requests.

The run paused through the existing `setPlaying` tool, selected Flight 5, sought its start, navigated to Airfield B, queried imagery, and read the scene back. Final time **673687471 ET** exactly matched the activity start; playback was **false** and camera range **0.500 km**. The answer states paused playback, estimated timing, the name-match association rather than a direct reference, waypoint provenance and the four imagery layers. Both activity and place remain selected despite no selected object. No page errors occurred.

`sonnet-flight5.png` shows desktop acceptance. `sonnet-flight5-390.png` is the same completed run resized, not a separate mobile conversation. At that size the existing activity card partly overlaps the Ask answer; this change does not claim to resolve that layout limitation. The earlier run before clarifying that “show an activity” means inspection left playback running and disclosed it; the clarified prompt was then verified with the successful paused run above. Pause remains a model instruction through ordinary host tools, not an implicit behavior of `seekActivity`.

## Other feedback

- An actual browser wheel gesture between tool calls made the next camera write return `interrupted`; reads remain available. Manual input is now notified immediately, before the next animation frame; tests cover wheel, keyboard and typing exclusions, flight arrival, event relay/disposal and a new request after earlier input.
- Surface inventory no longer calls terrain memory accounting. Tests throw if the expensive model traversal is touched and exercise loaded/disposed residency. A loaded-browser sample of 100 Mars inventory reads took **2.2 ms total**, an observation on this device rather than a performance guarantee.
- The executable proxy listener was observed at **127.0.0.1:8788**, not a wildcard address. Scripted-provider proxy tests passed without any model calls.
- `surface-action-label.png` and `surface-action-label-390.png` verify “Checked surface datasets on Moon” in expanded Actions using a local scripted response (no model API). The playback label also reads the verb's actual `on` argument.
- Tests cover continuing playback, explicit pause, and a host refusing pause/seek. Existing clock ownership and seek semantics are preserved; no new selection or time store was added.

Validation: 557 distinct focused tests across control, Ask, viewer control/navigation/shell, all camera-control suites, terrain sampling/status and proxy adapters passed. Build and embed build, viewer/test/Svelte typechecks, changed-file ESLint and `git diff --check` passed. The full repository suite was not run.

#325 is still open, so #326 stays on its stacked base. Main-target CI remains a merge prerequisite after #325 lands; neither PR was merged or retargeted for this verification. Live OpenAI acceptance is outside this Sonnet follow-up and remains unverified here.
