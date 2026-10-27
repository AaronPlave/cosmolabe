# October 27 review: estimated paths and physical occlusion

All work stays in PR #292. The five V12 scientific products and all 72 flight
files are unchanged. Production R2 upload, public HTTP verification and deployment
remain unperformed and require explicit authorization.

## Flight navigation and reconstruction detail

The timeline now has an opt-in sampled-arc navigator (`trajectoryPlot.timelineLabel`).
Ingenuity enables it as **Flight**. All 72 flights appear in a picker with date
and duration; previous/next buttons navigate from flights or parked gaps without
wrapping. Selecting pauses and frames the sampled interval with 10% time padding.
Expanding the timeline shows flight intervals on the transport's time axis.
Arc routing bounds include parked days; the navigator intersects them with the
actual sample bounds and excludes unsampled fixed-point landed arcs. Hiding a
trajectory line does not remove its interval. It changes neither flight
samples nor epochs and is absent in MoonFall.

The user-reported fine wiggles are not evidence of measured flight movements.
The current estimated height is the terrain sampled at each preserved mapped
horizontal vertex plus a modeled AGL profile. This can imprint small terrain
variations on the estimated vertical path. Dense bends in the mapped horizontal
source are also preserved. Flight 12's epoch-matched MMGIS polyline (the known
source label 13 anomaly) contains 5,068 horizontal vertices, with median segment
length about 0.089 m and frequent local direction reversals. Those small source
bends exist before adding any estimated height. Neither the model nor a screenshot establishes which
wiggles were actual helicopter motion; no smoothing or terrain modification was
applied in this navigation change. A revised vertical estimate must be explicitly
modeled and checked for physical plausibility and clearance, rather than simply
smoothing the drawn line or interpreting those variations as telemetry.

`node scripts/test-trajectory-timeline.mjs http://127.0.0.1:5174/` verifies the
real mission picker, previous/next, boundary buttons, all 72 overview marks,
desktop and 390px controls, and removal on switching to MoonFall. The October 27
run passed on Chrome / Apple M4 Max Metal with zero page or GL errors;
[metrics](timeline-acceptance.json), [desktop flight](timeline-captures/desktop-flight12.png),
[overview](timeline-captures/desktop-overview.png), and
[compact flight](timeline-captures/compact-flight12.png) retain the UI evidence.
These captures validate navigation, not imagery settling after a time jump.

CI also identified the missing schema entries for the already parsed `frame`
and `sampleInterval` plot fields. The schema now recognizes those and the new
timeline label; a shipped-catalog regression protects this contract.

### Reuse boundary

The UI honors the catalog label (Flight, Drive, etc.) and maintains separate
series per vehicle. The automated GPU check includes concurrent flight and
synthetic rover-drive controls; the drive fixture reuses existing sample bounds
and is not a claim about real rover data. Four helper regressions cover sampled
bounds, navigation, concurrent vehicle series and independence from line visibility.

This remains a **sampled composite-arc adapter**, not a general mission activity
model. It does not yet represent named operations with independent bounds,
overlapping activities, SPICE-defined phases or analytic surface-hop trajectories.
The `trajectoryPlot.timelineLabel` opt-in is a temporary placement, not a proposed
long-term catalog API. General mission activity records should belong to the
shared timeline/catalog model, separate from rendering and trajectory sampling.
Mission data importers (including plugins where appropriate) can supply those
records. Shared navigation and display should remain built into the viewer.
Do not infer or publish new MoonFall, Skyfall, Dragonfly or rover activities from
arbitrary cache or trajectory segmentation.
Focused catalog/timeline tests pass (96 tests), as do the shell/panel checks
(78 tests), package build, test/viewer/Svelte typechecks and changed-file lint.
The broader local package/viewer run passed 2,641 tests, skipped seven, and failed
only the unchanged `gf-reporting.test.ts:183` wall-clock reporting assertion;
that same assertion also failed in an isolated local run. No GF assertions were
changed. An initial unrestricted local test command was stopped after script
HTTP-host tests hit sandbox listener timeouts; it is not an acceptance result.

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
