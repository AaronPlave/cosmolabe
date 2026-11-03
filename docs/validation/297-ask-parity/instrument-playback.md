# Instrument playback clock/render regression

Review: [P1 report](https://github.com/AaronPlave/cosmolabe/pull/334#issuecomment-6611477619).

The clock and renderer have independent animation callbacks. Instrument pointing
now describes the last successful rendered frame (or actual evaluated unavailable
state), with its explicit `observedEt`. `fresh` checks the current clock separately;
render errors do not advance the successful receipt or invent a pointing failure.
Paused seeks can show Updating; ordinary playback retains its last frame. Missing
state/attitude still gives its real reason. Probe observation publication moved
after the marker draw. Event/probe readbacks retain the prior epoch between clock
ticks; camera/viewport invalidation and exact-epoch deterministic readiness remain.

## Browser acceptance

Ordinary local viewer, dedicated port 5797 verified against this checkout;
Chrome with ANGLE Metal / Apple M4 Max (also observed in the ordinary modern-scene
acceptance). No provider calls. `scripts/test-instrument-playback.mjs` checks:

- Cassini ISS NAC at ET 152077771.2473141, tracking Cassini / looking at Titan.
- Europa Clipper EIS NAC at its catalog default epoch.
- Four seconds each at 1x and 30x in both catalogs: 175 sampled clock/panel reads
  per interval, including the clock/render gap, advancing actual observed epochs,
  no unavailable pointing/reason, render error or opaque unavailable overlay.
- Pause/seek/resume and NAC/WAC switching in both catalogs. Immediate seek reads
  retain the preceding pointing and epoch with `fresh: false`; paused observation
  subsequently becomes fresh.
- A controlled missing `MissionStateRotation` attitude source on the selected
  sensor, using the real model/pointing path: observed unavailable reason and
  opaque overlay, then recovery after restoring the source. This fixture is not
  evidence of an actual mission CK gap.

[Observations](instrument-playback.json), [Cassini panel](instrument-playback-cassini.png),
[controlled missing-attitude overlay](instrument-missing-attitude.png).
These checks establish successful native drawing and absence of the false
overlay, not visible celestial targets or calibrated image data.

## Checks and repeat

52 focused renderer tests, 320 control/adapter tests, all configured package/test/
viewer/Svelte type checks (zero warnings), changed-file lint, unchanged 108-operation
capability coverage and production viewer build pass. Renderer tests cover failed
draw publication, genuine unavailable-state receipts, clock gaps, and retained
camera/viewport invalidation. The build retains its existing large-chunk advisory.

`CL_VIEWER_URL=http://127.0.0.1:5797 node scripts/test-instrument-playback.mjs`

`CL_VIEWER_URL=http://127.0.0.1:5797 CL_MODERN_MODES=cassini node scripts/test-modern-scene-automation.mjs`

The latter passes real SPICE search, sensor observation, corrected stale-clock
assertion and terminal search outcomes. The full modern-scene run passed ordinary
Ingenuity, then its separate test harness timed out waiting for streamed imagery
to become drawn. That broader run is not claimed as passed; default harness
coverage and strict readiness have not been weakened. `CL_MODERN_MODES` only
allows a targeted repeat; its default still runs ordinary, harness and Cassini.

## Probe readback re-review

[P2 re-review](https://github.com/AaronPlave/cosmolabe/pull/334#issuecomment-6613880332):
`drawn` now requires a non-null observed epoch for the current pin as well as the
matching view and native marker visibility. Replacing visible pin A with B
invalidates its observation even while the overlay retains A's visibility;
clock advancement after B renders still preserves B's prior observed epoch.
`SemanticSurfacePoint.test.ts` covers that complete sequence.

Ask's instrument read includes a bounded `pointingUnavailable` reason, separately
from `fresh` and `renderError`. Known native attitude, state and mounting messages
use fixed diagnostic text without catalog names; unapproved fault details remain
local. Agent tests cover physical failures, stale-clock reads, render-only
failure, and withholding private fault text.

Validation for this small follow-up: 252 tests across all control suites and the
three instrument/event/probe renderer suites, configured package/test/viewer/Svelte
type checks, changed-file ESLint and diff checks pass. The browser evidence and
full modern-scene timeout above are from the preceding playback pass; these
browser harnesses were not rerun for this readback-only follow-up.
