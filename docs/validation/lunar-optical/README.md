# Lunar optical layers (#147)

LRO and MoonFall use independent WAC context and NAC detail, with NAC enabled
by default. The optional PSR layer is real stretched, indirectly lit photography;
it starts disabled. [Source pins, builder and licensing](../../../scripts/build-moon-terrain/README.md#independent-optical-layers-147).

## Reproduce

Start this checkout's viewer on port 5198, then run:

```sh
node scripts/test-lunar-optical.mjs http://127.0.0.1:5198 --baseline
node scripts/test-lunar-optical.mjs http://127.0.0.1:5198
# Production preview on 127.0.0.1:5173, with hosted catalogs:
CHROMIUM_HOST_RESOLVER_RULES='MAP localhost 127.0.0.1' \
  node scripts/test-lunar-optical.mjs http://localhost:5173 --production
```

The baseline is the original composite at `bcecc2ec`; override with
`LUNAR_OPTICAL_BASELINE_REF`. Cameras and calendar epoch are fixed. Raw captures
and reports stay in ignored `work/lunar-optical/`. The production replay loads
the immutable payloads directly from the public host at its allowed localhost
origin. The optional `--hosted` mode uses Vite's normal proxy on other ports.
The publisher also verifies URL revisions, payload types, immutable headers and
allowed CORS origins. No live Moon Trek imagery is used.

## Appearance and source qualification

Apple M4 Max / ANGLE Metal, 1280 x 900. Mean maximum-channel difference per
pixel, in 8-bit display levels, separated default versus the shipped composite:

| Camera | Natural | Flood |
| --- | ---: | ---: |
| Shackleton | 0.115 | 0.458 |
| Pole | 0.006 | 0.421 |
| Boundary | 0.010 | 0.232 |
| Orbit | 0.010 | 0.099 |

Both stacks use the original source rasters. Of 27,305 WAC-only tiles outside
the polar face, 27,189 are byte-identical to the shipped composite. The other
116 differ in stored raster pixels, before rendering: offline resampling/
encoding differences, mostly in coarse levels. Mean decoded error across those
27,305 tiles is 0.0059 DN; the largest individual coarse-pyramid error is 29 DN.
Partial-alpha edges also differ slightly because the ordinary layer compositor
blends in linear light while the old offline composite mixed display DN.
No material new radial streak, tile seam or registration shift was observed at
these four cameras and their orbit-to-surface history. The old geographic polar
artifact does not reproduce in this cube replay; no renderer correction was made.

PSR brightness bands and abrupt photographic footprint edges remain visible.
These are source radiometry in the released long-exposure, per-region stretched
product, not tile cracks or simulated sunlight. Valid white 254 is retained;
NULL 0, LIS 1, LRS 2 and high saturation 255 become transparent before overviews.
The native 30 km square around Shackleton is only 40.786% valid observations.
The overlay must not be read as complete photographic coverage of the floor.

Independent native-to-cube checks pass on 960 pixels, including 288 gutters and
84 partially covered pixels: maximum DN error 0.500, alpha-byte error 0.497.
This checks raster conversion, not absolute geolocation. The PSR mosaic is
uncontrolled; absolute registration accuracy remains unknown. The original PDS
10 m product is used, not its 11.74 m browse TIFF.

Native Surface Layers checks cover NAC toggle/opacity, PSR toggle, restoration,
visible acquisition/provenance labels and 390 px layout. A disabled PSR makes
zero requests, including its manifest, and holds no PSR texture entries. All
sources share the existing texture pool and authoritative terrain geometry.

Default appearance: [before](before.png), [separated default](default.png).
Optional photographic observations: [PSR enabled](psr.png).
The [compact controls](controls.png) retain acquisition years and indirect-light labeling.

## Verification

220 focused JavaScript tests (68 renderer/manager, 24 catalogs, 29 publisher,
99 viewer-control)
and six GDAL raster tests pass. Package build, test/viewer/Svelte typechecks,
changed-file lint, production build and the hosted catalog rewrite pass.
All three public products verified before their registry pins were written.
Production packaging retains the normal deploy exceptions for the unpublished
Mars terrain and Rosetta kernels; neither is used by these lunar checks.

The final production MoonFall run passed all 13 states and the compact controls,
with actual public-host payloads on the physical GPU. LRO passed separate cold
and normal sessions: Track LRO, Moon Overview, LRO Close-up, Lunar North Pole,
LROC WAC instrument view and Shackleton Close-up, including physical terrain
picks. No page or asset errors were recorded. Phone/integrated GPU performance
and independent absolute geolocation are unmeasured.

## PR review follow-up

A failed optional manifest now retries when the user disables and re-enables
its layer (or restores opacity from zero). Changing opacity while already active
and unchanged visibility do not retry. Overlapping activations share a request;
there is no frame-driven retry. The fail → disable → enable regression passes,
alongside 93 focused renderer/manager/catalog tests, package build, test/viewer
typechecks and changed TypeScript lint.

WAC metadata distinguishes the June 2013 **mosaic edition** from its November
2009–February 2011 source acquisitions ([LROC product description](https://data.lroc.im-ldi.com/lroc/view_rdr/WAC_GLOBAL/)).

### Default-stack performance

Reproduce against this checkout's viewer:

```sh
node scripts/test-lunar-optical.mjs http://127.0.0.1:5198 --hosted --baseline --performance
node scripts/test-lunar-optical.mjs http://127.0.0.1:5198 --hosted --performance
```

The two sequential runs use fresh Chrome caches, the same current renderer,
1280 × 900 viewport, fixed paused epoch and 50° FOV. Only the catalog imagery
stack changes: original composite at `bcecc2ec` versus default independent
WAC + NAC. PSR stays disabled. Both use public immutable payloads through the
normal Vite data proxy. After orbit settles, 360 animation frames interpolate
the same eye/target from orbit to Shackleton (zoom and tilt); 120 stationary
frames follow full refinement. The camera then returns to orbit and repeats
the path with the accumulated cache. Frame intervals are browser rAF intervals;
CPU timings wrap the normal renderer call, without extra renders or a blocking
GPU finish. They measure CPU submission, not GPU execution time. Residency is
reported separately from allocated image-pool capacity. Counts include manifests,
tiles and aborted requests, and can vary with asynchronous arrival/refinement.
This is one focused desktop comparison, not a device-wide performance bound.

Measured on Apple M4 Max / ANGLE Metal (one sequential pair). All median frame
intervals were 16.7 ms; p95 intervals were 16.7–16.8 ms in both stacks.
CPU render-call timings below are median / p95 in milliseconds:

| Stage | Composite CPU ms | WAC + NAC CPU ms | Composite peak resident MiB | WAC + NAC peak resident MiB | Cumulative imagery requests, old / new |
| --- | ---: | ---: | ---: | ---: | ---: |
| Orbit settled | 8.9 / 10.3 | 9.4 / 10.9 | 63.1 | 64.2 | 179 / 188 |
| Cold zoom / tilt | 9.8 / 12.1 | 10.6 / 13.2 | 127.6 | 126.2 | 372 / 372 |
| Shackleton settled | 9.5 / 11.0 | 9.7 / 11.3 | 181.9 | 183.3 | 518 / 526 |
| Warm zoom out | 10.6 / 12.4 | 11.2 / 13.1 | 197.5 | 206.7 | 563 / 594 |
| Warm zoom / tilt | 9.7 / 10.8 | 10.3 / 11.4 | 202.8 | 214.1 | 587 / 623 |

Both pools allocated **513.3 MiB** throughout (same 512 MiB configured budget,
plus table/transition overhead). After final refinement, composite residency was
575 tiles / **203.8 MiB**, versus 612 tiles / **215.9 MiB** for WAC + NAC.
Final imagery requests were **587 versus 623** (+6.1%); resident bytes increased
by **12.1 MiB** (+5.9%). Median CPU submission increased 0.2–0.8 ms across these
stages. This run shows measurable incremental CPU/network/residency cost without
a frame-cadence or allocated-pool regression on this GPU. Neither stack reported
GPU errors, failed tiles or uncovered base blocks; PSR requests remained zero.
Raw per-stage reports remain in ignored `work/lunar-optical/*-performance-browser.json`.
