# October 27 review: estimated paths and physical occlusion

All work stays in PR #292. The five V12 scientific products and all 72 flight
files are unchanged. Production R2 upload, public HTTP verification and deployment
remain unperformed and require explicit authorization.

## What the below-surface reproduction showed

The original default four-layer mission at its default epoch drew nine Ingenuity
arcs with one-year trail durations. Some caches represented entire flights with
two endpoints. Those are real presentation defects, but the apparent line forest
persisted after disabling **all** trajectories and other line objects. Imagery
level debug colored the strips: they were physical terrain/skirt surfaces exposed
when the top faces were culled from below. This catalog uses cube terrain in the
main scene; its SurfaceTileOverlay pass is empty. Moving that separate pass was
not the fix.

The [original recording](review-captures/below-before.webm) and
[original below-surface frame](review-captures/below-before.jpg) preserve the
reproduction. Known cube terrain now draws both sides of its original triangles.
[Level debug from below](review-captures/below-levels.jpg) identifies the filled
underside. Ordinary solar lighting can make that underside dark; remote physical
edges can remain visible outside it during the deliberately bypassed clamp.
They are not flight trajectories. Normal camera controls retain the physical
surface clamp, including focused cube parents.

Fading terrain can disable depth writes. A depth-only pass borrows its exact
selected geometry with opaque, two-sided logarithmic depth before trajectories;
steady opaque terrain adds no depth-pass draws. Physical vertex, normal, index,
CPU-grid and picking data are unchanged. The preexisting model depth pass keeps
its linear-depth defaults.

## Plot policy and coordinate registration

Ingenuity explicitly declares `duration: "300s"`, `frame: "BodyFixed"`, and
`sampleInterval: "0.05s"`. Flight data coverage caps each plotted arc; the
composite body's parked position/routing remains intact. Five minutes after a
flight ends there is no historical arc. Generic inertial spacecraft defaults
remain unchanged.

Cache vertices use anchored native Mars XYZ coordinates. The **current** Mars
orientation rotates the whole path; historical epochs select estimated positions
within that frame. This avoids historical planetary rotation turning parked
surface samples into inertial trails. A globe's Y-up geometry permutation must
not be applied to native trajectory XYZ. The cache window advances at the authored
interval instead of retaining a five-minute window and bridging most of a short
flight with a single chord. Sampling is a display policy, not new telemetry. Event glyphs and highlighted
spans share that current transform. Surface-event glyphs draw with the physical
logarithmic scene depth; ordinary inertial annotations keep their existing
on-top policy. A synthetic selected interval on actual flight 12 verifies
registration within four micrometres and zero changed pixels below terrain.

The final cache contains 430,556 points across 72 flights, compared with sparse
endpoint caches in the original reproduction. This adds real initialization and
memory work; it is not a trajectory speed optimization.

## Dense numerical evidence

[Per-flight clearance report](rendered-path-clearance.json) retains all 72 rows,
negative sample counts, worst coordinates/epochs, interpolation deviations,
segment lengths/time gaps, frame names, input hashes and declared gates.
It covers **2,786,880 samples**: all actual runtime Hermite knots plus 15 interior
samples per interval, every actual drawn Float32 vertex and three interior points
per plotted segment. All 73 landing controls are represented; consecutive flight
end/start positions coincide exactly. This is dense sampling, not a formal
continuous clearance proof.

Worst negative clearance against the unchanged fused source is approximately
8.34 micrometres. Native CPU and emitted GLB triangle clearance reaches
**-0.085276 m** at ground contact around flights 70/71. The explicit 0.1 m native
representation tolerance qualifies this difference; it is neither a source
absolute-accuracy bound nor measured flight accuracy. No vertical correction is
applied. Maximum plotted-chord deviation from the actual Hermite curve is
**0.027491 m** (flight 11), below the 0.05 m plot gate. Native triangle topology
and the emitted GLB's Float32 offsets/translation are checked independently.

Original horizontal paths, landings and flight epochs remain observations;
vertical/time profiles remain estimates. The previously documented flight 12/13
label anomaly and flights 1/71/72 summary-statistic ambiguities remain in
`data/ingenuity/reconstruction.json`. No new precision is inferred from them.

## Physical GPU acceptance

[Flight recording](review-captures/flight-visibility.webm) and selected
[flight 12 above](review-captures/flight12-above.jpg) /
[below](review-captures/flight12-below.jpg) frames use the actual default four-layer
mission on Chrome / Apple M4 Max Metal. Flights 1/12/72 are checked at takeoff,
cruise, landing and a parked interval. Cruise trajectory toggles change
40 / 1,247 / 106 canvas pixels above the surface and **zero** below it; parked
intervals have zero visible Ingenuity arcs. Below-surface poses explicitly bypass
only the camera clamp. These final acceptance poses differ from the original
forensic recording and are not presented as pixel-matched before/after views.

A separate forced-fading fixture exercises the physical depth pass on flight 12,
retaining an above-ground path and zero below-surface trajectory pixels. GPU
captures read synchronously after rendering and assert nonempty terrain: reading
a non-preserved WebGL drawing buffer after browser compositing had produced a
false initial zero-pixel result, which is excluded from acceptance.

[Structured final evidence](review-acceptance.json) records exact source hashes,
GPU checks and full-mission/corridor regression results. The reusable imagery
[review closeout](../imagery-refinement-257/review-followup.md) includes continuous
motion, material sharing, opacity/residency pressure and performance disclosure.

## Reproduction

```sh
node scripts/export-ingenuity-path-audit.mjs http://localhost:5173/ work/path-samples
PYTHONDONTWRITEBYTECODE=1 python3 scripts/terrain/audit_ingenuity_rendered_paths.py \
  --samples work/path-samples --fusion work/ingenuity-246/clean-fusion \
  --areoid work/ingenuity-246/cache/c5988b54f637beb04bb57c093bf4a7fea6eeeced7e86771c3392d5e09c76b108/inputs/areoid/MEGA90N000EB.LBL \
  --terrain apps/viewer/test-catalogs/data/ingenuity-cube/terrain-3846907d293e9e5d0b0243ce \
  --out work/path-clearance.json
node scripts/test-ingenuity-trajectory-visual.mjs http://localhost:5173/ work/path-visual
node scripts/test-ingenuity-trajectory-visual.mjs http://localhost:5173/ work/path-fading --fading
node scripts/test-ingenuity-trajectory-visual.mjs http://localhost:5173/ work/path-events --events
```
