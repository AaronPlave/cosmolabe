# October 27 renderer review closeout

The independent source/face hierarchy and page-table architecture remain.
This closeout supports the complete #246/#257 scope in PR #292; it is not a
separate foundation slice. Production publishing/deployment is still unperformed.

## Shared terrain materials

Two distinct physical terrain addresses intentionally reuse one material, then
one tile is removed/replaced. A conflicting address/face basis receives an
isolated material binding, using the original compile chain and the same shader
program key. Removing that tile restores its original material and disposes the
owned clone. Same-address reuse retains existing uniform objects. There are no
imagery-block meshes/materials or extra imagery draws. Ordinary mission terrain
with unique input materials follows its existing path.

The deterministic regression fails the original implementation's overwritten
address. The actual default-mission Metal test normalizes non-imagery fade/style
properties for the comparison: independent, intentionally shared, and replaced
inputs produce **zero changed terrain-pass pixels**. Both address uniforms and
face bases remain independent, and shader program keys stay equal. Comparing
unlike original fade/style properties is not a valid sharing-only A/B.

## Hidden sibling residency defect

The longer flight-view sequence found an additional real failure at flight 72:
while stationary, the renderer made 1,809 imagery requests and 1,621 evictions,
with one waiting group, zero queued requests, and `budgetLimited: false`.
Downloaded shallow pages were immediately evicted in favor of deeper pages,
then requested again. Sibling traversal used geometric visibility while final
cover publication/eviction excluded opaque upper footprints. This admitted
hidden lower siblings that could never become displayed references.

Sibling admission now uses **the same proven opaque upper-coverage predicate**
as final publication. Alpha, bounds and opacity must still prove coverage;
transparent/unknown alpha cannot suppress lower imagery. A deterministic
partial-footprint fixture fails before the fix by requesting a hidden sibling
and passes afterward. Existing transparency/order/visibility regressions remain.

The same actual flight 1→12→72 camera sequence now settles all fifteen phases.
At flight 72 cruise, cumulative requests/evictions are 257/69, with zero waiting
or queued/in-flight work. Visible physical/source fidelity is retained. The
960 MiB target did not change to mask this defect.

## Continuous motion recordings

All four default Mars layers remain enabled, opacity one, original order.
Each recording starts cold, zooms/tilts/reverses, and repeats the camera path.
MoonFall's repeat camera motion runs at twice the initial speed. Accelerated
mission playback is tested separately by the adversarial regression.

- Ingenuity [normal](motion/ingenuity-jezero-normal.webm) and
  [imagery levels](motion/ingenuity-jezero-levels.webm).
- MoonFall [normal](motion/moonfall-shackleton-normal.webm) and
  [imagery levels](motion/moonfall-shackleton-levels.webm).

These are continuous physical GPU recordings, without artificial crossfades.
The paired modes use the same scripted pose/time path in independent cold
contexts, so response timing is not frame-identical. Inspection used half-second
contact frames across all four movies plus selected full-resolution frames;
recordings preserve intervening frames for review. This is not an exhaustive
proof against a single-frame artifact on every device.

The captures retain genuine finite HiRISE/CTX footprint/radiometry boundaries.
Those boundaries recur at the same surface locations on repeat visits and must
not be smeared away. Normal movement did not reproduce the persistent wrong
coarse rectangles or repeated sharp/coarse disappearance in the earlier reports.
Initial network refinement and discrete correct LOD changes are still visible.
The level-debug view explicitly shows desired spatial LOD bands at oblique views.
The independent [history](imagery-history.json) and [horizon](imagery-horizon.json)
reports preserve the earlier matched before/after failure evidence.

## Residency targets and measured cost

Ingenuity uses **960 MiB**, MoonFall **512 MiB** as residency **targets**, not hard
ceilings. Displayed pages, usable ancestors and transition reservations are
protected. `Image / target`, `Image GPU`, and `Image reserve` diagnostics distinguish
payload, allocated array/page-table bytes, and protected/transition overage.
A live reduction preserves the existing valid cover, reports pressure, and retires
unreferenced history. Cold constrained runs defer detail without inventing pixels.
Allocation failure retains the previous usable GPU cover; context restoration
reuploads referenced data. These paths are exercised on the actual Metal GPU.

The new 1440×900 video workloads include cold loading and continuous scripted
motion **while recording**. Mars normal/debug frame-interval p95 is 34.0/30.2 ms,
with imagery CPU p95 13.6/11.8 ms; Moon normal/debug is 19.2/20.5 ms, imagery CPU
10.8/12.6 ms. Maximum Mars intervals are 93.2/97.8 ms, not a claim of constant
60 FPS. Peak Mars payload is 1,025,784,942 bytes and allocated pool/table
1,025,801,326 bytes; Moon allocations are 538,271,744 bytes.

These are a new recording workload, **not a matched performance improvement**.
The original architecture's increased initial CPU/cold latency and the later
matched Surface Flight pacing improvements remain separately disclosed in
[gpu-comparison.json](gpu-comparison.json) and
[surface-flight-pacing.json](surface-flight-pacing.json). The current full
mission/pacing checks and code hashes are in the
[final review evidence](../ingenuity-jezero/review-acceptance.json).

## Reproduction

```sh
node scripts/capture-imagery-motion.mjs http://localhost:5173/ work/imagery-motion
node scripts/test-imagery-material-sharing.mjs http://localhost:5173/ work/material-sharing
node scripts/test-imagery-filtering.mjs http://localhost:5173/ work/history --history --hidpi --expect-default --assert-recovery
node scripts/test-imagery-refinement.mjs http://localhost:5173/ work/refinement
node scripts/test-imagery-instrument.mjs http://localhost:5173/ work/instrument
node scripts/test-ingenuity-jezero.mjs http://localhost:5173/ work/mission
node scripts/test-surface-flight-pacing.mjs http://localhost:5173/ work/pacing
```
