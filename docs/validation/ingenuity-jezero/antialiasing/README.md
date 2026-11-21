# Terrain seams and native line coverage

PR #292's `cd47748` change to double-sided cube terrain exposed dotted black
edges with MSAA and fragment-written logarithmic depth. Double-sided coverage
is needed for physical underside occlusion. Removing terrain back faces or
skirts would conceal the symptom by removing physical geometry.

The first published fix (`6d71adf`) disabled MSAA and raised low-density canvas
resolution to two pixels per CSS axis. The Cassini comparison demonstrated a
regression: native WebGL lines remained one framebuffer pixel wide, becoming
half as wide on a DPR 1 display. The GPU reports a supported line-width range
of `[1, 1]`; increasing material linewidth cannot correct that. The controlled
regression fixture measured approximately half the original line brightness.
An earlier, unpublished FXAA experiment also softened text and paths.

The replacement restores **native display density and hardware MSAA**, as on
main. It adds matching `centroid` interpolation qualifiers for the logarithmic
view-depth varying in both shader stages. At a partially covered MSAA pixel,
the pixel centre can lie outside the primitive. Centroid interpolation keeps
the interpolated value inside the covered primitive, avoiding extrapolated
depth across terrain edges. The existing high-precision logarithmic depth
formula is unchanged. The patch checks both declarations before changing either
and supports repeated calls and half-patched input.

This is a depth interpolation correction. It adds no fullscreen filter,
resolution floor, extra geometry, texture copies, draw passes, line-opacity
compensation, or temporal history. Native line rasterization, label layers,
compositing order and display-density handling retain their original behavior.
Terrain positions/normals/indices, CPU queries, imagery registration and source
alpha, trajectory samples, and lighting are unchanged. The full GPU acceptance
includes physical trajectory occlusion through opaque and fading terrain.

Centroid interpolation does **not** create independent fragment-written depth
for every MSAA sample, and it is not a universal solution for every intersecting
surface. The reported pose retains a few isolated double/front diagnostic
pixels; zero differences everywhere are not claimed. Three.js documents the
[broader fragment-depth/MSAA limitation](https://github.com/mrdoob/three.js/issues/22017).
Our local measurements, rather than that report alone, support this correction.

## Acceptance

The maintained Cassini regression freezes the supplied ET 141922255.9896023,
camera and viewport, waits for its actual SPICE trajectory cache, and compares
main, the supersampling regression fixture, and the corrected renderer. It
captures the complete scene and separately measures native lines using the same
materials, transforms, draw ranges and camera. Isolated line RGB sums are
normalized by canvas density squared to measure integrated brightness in CSS
area. The fixture must reproduce dimming; the correction must match main within
2%. The comparison includes DPR 1 and 2, both with equal-time assertions.
On the recorded GPU, corrected isolated line images are pixel-identical to
main at both densities. The regression retains 49.88% of main's integrated
brightness at DPR 1 and 99.75% at DPR 2.

The exact Ingenuity shared camera (ET 722439881.1, FOV 6) compares double-sided
terrain against a front-sided diagnostic using the same selected geometry.
The baseline removes only the centroid patch and must reproduce the seams.
FrontSide is never the production configuration. At DPR 1/2, the original
baseline had 561/1,246 significantly darkened backing pixels; centroid
interpolation reduces that to 15/17 at the same respective canvas dimensions.

All 925 renderer tests (79 files), package build, test/viewer type checks and
changed-file lint pass. The adversarial imagery replay samples 816 Ingenuity
and 864 MoonFall frames with zero base holes, extra imagery draws or clipped
imagery geometry in checked phases. Frame interval p95 is 22.8/19.9 ms and
imagery update p95 is 4.4/5.3 ms respectively in this workload. These are
measurements, not universal timing guarantees. Opaque and forced-fading terrain
both retain readable above-ground paths and zero below-ground trajectory
pixels. Three cold constrained-memory MoonFall instrument switches pass.

[Structured measurements](acceptance.json) and selected actual display captures
retain the results. [Terrain before](terrain-before-dpr1.png) and
[terrain after](terrain-after-dpr1.png) show the original pose.
[MoonFall](moonfall-dpr1-display.png) and
[Ingenuity](ingenuity-dpr1-display.png) include body labels, place labels and
paths. Cassini captures include [main](cassini-main-dpr1.png), the
[regression](cassini-regression-dpr1.png), and the
[correction](cassini-corrected-dpr1.png).

## Reproduction and limits

```sh
node scripts/test-trajectory-rasterization.mjs http://127.0.0.1:5175/ http://127.0.0.1:5176/ work/aa-cassini
node scripts/test-terrain-antialiasing.mjs http://127.0.0.1:5175/ work/aa-seams
node scripts/test-terrain-antialiasing.mjs http://127.0.0.1:5175/ work/aa-baseline --baseline-msaa
node scripts/test-render-density.mjs http://127.0.0.1:5175/ work/aa-density
node scripts/test-imagery-refinement.mjs http://127.0.0.1:5175/ work/aa-motion
node scripts/test-ingenuity-trajectory-visual.mjs http://127.0.0.1:5175/ work/aa-events --events
node scripts/test-ingenuity-trajectory-visual.mjs http://127.0.0.1:5175/ work/aa-fading --fading
node scripts/test-imagery-instrument.mjs http://127.0.0.1:5175/ work/aa-instrument
```

Serve main separately for the second Cassini URL, with the same ignored kernel,
model and texture assets. The recorded comparison uses an isolated source
snapshot of `origin/main`, not the unrelated feature branch served on the user's
port 5174. Main's pre-existing GL initialization error is recorded separately;
the measured rendered frames must have zero GL errors.

Run GPU workloads sequentially. Evidence uses Chrome / physical Apple M4 Max /
ANGLE Metal with emulated DPR 1 and 2. Physical external-monitor, Safari and
Firefox acceptance are not established here. Reload the page fully after the
renderer update: WebGL context antialiasing attributes cannot change through HMR.

The monitor-change regression changes DPR with CDP and explicitly dispatches a
`MediaQueryList` change event. This headless Chrome updates DPR and query matches
without emitting that event. The check exercises the registered handler and
rebind; it does not claim a physical monitor transition. The raster-density
report's alternating diagnostic density timings include `gl.finish` overhead,
not isolated GPU time or a proposed production density policy.
