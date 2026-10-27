# Terrain seam regression and antialiasing scope

The reported dotted black terrain lines were introduced by PR #292's
`cd47748` change to double-sided cube terrain. That fixed physical underside
coverage and occlusion, but exposed the interaction between hardware MSAA and
fragment-written logarithmic depth at intersecting/back-facing triangles.
[Three.js's upstream report](https://github.com/mrdoob/three.js/issues/22017)
describes the same class of failure. The local same-camera GPU comparisons,
rather than that report alone, establish this regression.

The final fix disables hardware MSAA and uses a minimum raster density of two
pixels per CSS pixel on each axis when `antialias` is enabled. DPR 1 renders at
2x width/height and the browser resolves it to the display; DPR 2 retains native
2x density, and higher densities stay native. `antialias:false` retains native
density, including deterministic `test=1` captures. Monitor changes use the same
policy. This is spatial supersampling relative to CSS pixels, not four hardware
samples per physical pixel on every display.

There is **no FXAA, SMAA, temporal history, fullscreen blur or neighborhood edge
filter** in the final pipeline. A local FXAA experiment did remove the seams,
but softened small text and thin paths and could filter fine imagery. It was
removed before publication. Moving only text after that filter would not have
addressed its wider effect. The final fix preserves the original rendering
passes and label layers; body labels, trajectories, models and imagery are
rasterized at the selected density. Standard sample coverage and browser spatial
resolve can differ from MSAA; pixel-identical output is not claimed.

No authored terrain, physical normals, indices, CPU surface queries, imagery
source/registration/alpha, trajectory samples or Sun lighting were changed.
Double-sided physical coverage and fading-terrain depth remain enabled. Higher
raster density can increase fragment work and imagery demand, which is why the
mission loading and residency tests were repeated. The additional pixel work is
not free: DPR 1 rasterizes four times as many pixel positions as native DPR 1;
DPR 2 does not increase its previous raster dimensions. This replaces the former
MSAA allocation/resolve rather than adding a separate image/depth pass.

## Reproduction and acceptance

The exact shared ET 722439881.1 Ingenuity camera, FOV 6, is embedded in the
maintained regression. It compares double-sided and front-sided diagnostics
without removing skirts or changing the selected geometry. FrontSide is not a
production solution. The baseline fixture restores only hardware MSAA and the
former native pixel ratio; it must reproduce the dotted seams.

```sh
node scripts/test-terrain-antialiasing.mjs http://127.0.0.1:5174/ work/aa-seams
node scripts/test-terrain-antialiasing.mjs http://127.0.0.1:5174/ work/aa-baseline --baseline-msaa
node scripts/test-render-density.mjs http://127.0.0.1:5174/ work/aa-density
node scripts/test-imagery-refinement.mjs http://127.0.0.1:5174/ work/aa-motion
node scripts/test-ingenuity-trajectory-visual.mjs http://127.0.0.1:5174/ work/aa-events --events
node scripts/test-ingenuity-trajectory-visual.mjs http://127.0.0.1:5174/ work/aa-fading --fading
node scripts/test-imagery-instrument.mjs http://127.0.0.1:5174/ work/aa-instrument
```

Run GPU workloads sequentially. Evidence was recorded with Chrome / physical
Apple M4 Max / ANGLE Metal, using emulated DPR 1 and 2, not a physical external
monitor or all browsers. A full page reload is required when moving from the
previous renderer so WebGL creates a new context without MSAA.

[Structured acceptance](acceptance.json) retains the measurements, exact source
camera, selected mesh count and tests. [Before terrain](terrain-before-dpr1.png)
and [after terrain](terrain-after-dpr1.png) show the reported seams. The
[MoonFall low-density display](moonfall-dpr1-display.png) and
[Ingenuity low-density display](ingenuity-dpr1-display.png) include body labels,
place labels and trajectories at actual CSS display size, rather than presenting
a large backing-store image as if it were a low-density capture.

The exact-pose double/front comparison had 561 dark backing pixels at DPR 1
and 1,246 at DPR 2 with the former MSAA strategy. The fix has one isolated
backing-pixel difference at either density, with the repeated dotted seams gone.
The new DPR 1 backing store has four times the pixel count, so these counts
are explicitly backing pixels, not a claim of equal CSS-area units.

The final stress replay sampled 816 Ingenuity and 864 MoonFall frames, with zero
base imagery holes, extra imagery draws or clipped imagery geometry in checked
motion phases. Both missions passed delayed/out-of-order responses, missing
parents, allocation failure, reversals, seams/corners and context restoration.
Frame interval p95 was 23.7 / 20.9 ms and imagery CPU p95 6.9 / 8.2 ms respectively
in this workload; these are measured results, not universal frame-time bounds.
Paired raster-density timings at the same fixed views are in the structured
report: 25 frames per alternating density block, with `gl.finish` after each.
They include synchronization cost and are not isolated GPU timer measurements.

The monitor-change check uses CDP to change DPR and explicitly dispatches a
`MediaQueryList` change event. In the tested headless Chrome, CDP changed DPR
and query `matches` without emitting that event. The regression checks the actual
registered event handler and rebind, rather than silently treating this as a
physical monitor transition. Physical external-monitor, Safari and Firefox
acceptance remain untested here.

After integrating the concurrently published `6079283` branch updates (including
CPU-grid transfer retry), the package build and all 919 renderer tests passed.
The exact-camera seam and two-mission display-density/monitor-event checks were
repeated on that integrated source and passed. The stress-motion and physical
occlusion evidence predates that integration; the intervening renderer change
only completes CPU-grid response bodies inside their fetch retry boundary.
