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

121 focused JavaScript tests (68 renderer/manager, 24 catalogs, 29 publisher)
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
