# Global geographic vectors: Natural Earth countries

Open `http://127.0.0.1:5188/?catalog=test-catalogs/geographic-vectors-earth-countries` in the regular viewer. Use **Display → Viewpoint** for Earth orbit, Europe and Africa, Pacific dateline, Antarctica, Rhine close, and Southern Africa holes. Cyan marks are selectable; click a country for gold, hover for white, and drag to rotate without selecting.

## Source and coordinate conversion

Made with [Natural Earth 1:110m Admin 0 countries, version 5.1.1](https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/), [public domain](https://www.naturalearthdata.com/about/terms-of-use/). The fixture retains all **177 features, 29 multipart features, 288 polygon parts, 289 rings, and the Lesotho hole in South Africa**. Its 10,654 source vertices are retained; normalized globe geometry has 10,651 after removing only the redundant polar map-cut closure. Coastlines are not simplified. This generalized dataset omits many small territories/islands by design; it is not a survey or a definitive list of countries. Natural Earth's default de facto boundary policy is retained.

The source `.prj` declares WGS84 geographic degrees (a=6378.137 km, inverse flattening=298.257223563). The catalog declares east-positive longitude, planetographic latitude and WGS84 ellipsoid radii [6378.137,6378.137,6356.752314245] km, matching the actual Earth globe. There are no source heights. Drawing clamps to the displayed triangles; it does not implement absolute datum-height drawing or establish terrain/datum accuracy.

We evaluated [GeoJSON already published by the maintainer](https://github.com/nvkelso/natural-earth-vector/blob/9380cca83db5f9aef52d5e762765100745f84b27/geojson/ne_110m_admin_0_countries.geojson). Its six-decimal rounding creates repeated vertices or self-intersections rejected in USA, Somalia, Sudan, Antarctica and Somaliland. For this all-features correctness comparison the committed fixture retains the full-precision official release. GeoJSON is the ordinary viewer input; Python/pyshp are used only to reproduce the fixture, never by the application. Other valid published GeoJSON can be loaded directly without a converter.

Antarctica's planar map cut closes its main coastline via A,pole,pole,A on the two sides of the ±180 seam. On the globe these meridians coincide. The shared importer removes only that zero-area closing spike (three redundant vertices) from normalized body-fixed geometry, preserving the full planar source in `Feature.original`. All coastline vertices and all eight Antarctic parts remain. Raster overlays consume the preserved planar representation; vectors use the normalized globe representation, from the same imported layer.

Reproduce the fixture (439,284 bytes, SHA256 `c49d510cea95f67d6ed22b311cb1a4b40895cf3928b7253b598b4bc427e8e5ed`):

```sh
curl -fL https://naciscdn.org/naturalearth/110m/cultural/ne_110m_admin_0_countries.zip -o /tmp/ne-countries.zip
python3 -m venv /tmp/natural-earth-venv
/tmp/natural-earth-venv/bin/pip install pyshp==2.3.1
/tmp/natural-earth-venv/bin/python scripts/prepare-natural-earth-countries.py /tmp/ne-countries.zip
```

The script verifies the release hash. Operations and the rejected published GeoJSON's pinned hash are recorded in [the source manifest](../apps/viewer/test-catalogs/geographic/natural-earth-countries.source.json). Tests and viewer loading use the committed fixture without third-party network access.

## Findings and bounded fixes

The original global fallback admitted all 177 countries with no budget diagnostics, but repeated broad padded candidates over the full surface. At 3840×2160 it took approximately **100 ms median / 116.7 ms p95** at the Rhine close-up and **50 / 50.1 ms** at Antarctica. Vectors disabled stayed near 16.7 ms. CPU submission was below 1 ms: this was fragment work, not GeoJSON parsing or picking.

The index now bounds polar primitives by their actual angular wedge and minimum/maximum radius. Triangles containing the pole and marks whose padding reaches it still span every longitude. It also packs one optional **256×128 global grid**, using the same padded-cell, bounded paging, footprint selection, source IDs and primitive records as the localized acceleration. Both polar and longitude/latitude primitives keep their own chart. Near seams, longitude bins wrap; exact pole rows clamp. When the screen footprint exceeds the grid's padding, the original coarse level remains available.

All references, including the optional global grid, share the existing one-million-reference limit. Finer indexing is skipped if it exceeds the storage limit or requires more draw pages. The 256-candidate loop, 100,000 primitives, 16 admitted pages/group and 2,048 surface draws/frame limits remain. No feature is removed to accelerate this fixture. There is no frame-by-frame rebuilding, per-country mesh, reduced coastline geometry or disabled picking.

This dataset has **20,149 primitives**, **265,164 coarse references**, **647,200 total references**, six coarse draw pages and two fine pages. The base globe submits six bounded draws/frame; unnecessary fine pages discard. Padded GPU texture allocation is **12,910,592 bytes**, versus 10,256,384 before refinement. These are base-index counts; active hover/selection adds at most two bounded sparse stroke indices and their passes.

A footprint guard now rejects unresolved strokes/points whose screen footprint exceeds the six-degree coarse padding. This also prevents partial MSAA coverage at a grazing edge from leaking a hidden stroke onto a foreground pixel; fills and resolved marks remain available. CPU picking applies the same padding policy. The software occlusion test reproduces the original one-pixel leak and passes with the guard.

The reported segmented border appearance and missing selected shared edges were renderer defects. A faint segment fringe could win before an adjoining segment's solid coverage; ordinary source/page order could cover a neighboring country's selected boundary. Equal-rank segments now union their strongest coverage. At most two sparse strokes-only views of the already-admitted index draw hover and selection after all ordinary pages. They share primitive objects and stable identities, need no parsing or triangulation, cache until the highlighted feature changes, and are included in GPU memory and the existing 2,048-draw frame budget. No additional features are admitted. The original 256-candidate and per-index storage/page bounds remain.

The border GPU regression samples vertices and three interior positions per segment on Chad, Germany and the Rhine close-up in both selection and hover states. It projects onto the actual displayed reference-globe triangles rather than assuming their screen positions equal the analytic ellipsoid. All 944 sampled positions show the correct highlight. The angular border shape is the coarse Natural Earth source; no smoothing alters its geometry.

The integration also exposed a camera-drag selection bug: the existing gesture guard covered probe/measurement tools, but ordinary geographic selection could run on mouse release. Active geographic layers now participate in that guard, including return-to-origin drags through the existing maximum-excursion tracking.

The bounded global path is suitable for this complete 1:110m workload on the tested desktop GPU. This does not establish support for arbitrary GIS layers, larger resolutions, or mobile hardware. Larger datasets still need explicit admission diagnostics and representative performance measurements.

## Hardware measurements

Apple M4 Max, ANGLE Metal, physical desktop GPU. Normal viewer with its normal rendering and pointer hover; 1920×1080 CSS at DPR 2, **3840×2160 drawing buffer**. Each viewpoint compares vectors off/on after warm-up. Frame intervals are 60 requestAnimationFrame samples after ten discarded samples. CPU measurements cover `renderFrame` and geographic picking. Twenty nonblocking `EXT_disjoint_timer_query_webgl2` queries measure the full scene's GPU elapsed time (including vectors), outside readback/screenshot capture; disjoint results are rejected. Frame-rate capping alone is not evidence of low GPU cost.

Final numerical results, pixel counts, interactions and screenshots live in [the hardware evidence directory](validation/geographic-vectors/global-m4-max/). Timing is device/workload specific, not a mobile benchmark.

| View | Frame median off/on (ms) | Frame p95 off/on (ms) | GPU median off/on (ms) | Render CPU median on (ms) |
|---|---:|---:|---:|---:|
| Earth orbit | 16.7 / 16.7 | 16.7 / 16.7 | 0.98 / 7.27 | 0.8 |
| Europe and Africa | 16.7 / 16.7 | 16.7 / 16.8 | 1.04 / 6.99 | 0.9 |
| Pacific dateline | 16.7 / 16.7 | 16.8 / 16.7 | 1.32 / 3.21 | 0.9 |
| Antarctica | 16.7 / 16.7 | 16.8 / 16.7 | 1.32 / 6.03 | 0.6 |
| Rhine close | 16.7 / 16.7 | 16.7 / 16.8 | 1.44 / 16.00 | 0.2 |

All visible runs retain 177 features with no diagnostics; picking CPU p95 is at most 0.3 ms. Pixel comparisons confirm visible vector drawing at every timed view. GPU times measure the entire renderer, not vectors alone. The uncapped GPU measurements show why identical 60 Hz frame intervals do not imply equal render cost.

## Correctness and automated coverage

`GeographicGlobal.test.ts` admits all source countries without diagnostics; exercises France and French Guiana, Germany, South Africa/Lesotho, Fiji on both sides of the dateline, Russia on both sides, Greenland, Australia, Japan, Antarctica and ocean misses; and checks vertices, edge midpoints and interior samples of **every primitive** against both coarse and fine candidate cells. Packed polar chart identities, cell loop bounds and total storage bounds are checked. Samples on each side of all shared France/Germany edges must pick the correct adjoining countries without a gap. Existing localized dense tests still verify every Jezero target at every local level.

`scripts/test-geographic-global.mjs` loads the regular catalog without `?test=1` or a test-only scene. It checks visible pixel differences against each unmarked baseline, retained feature counts, diagnostics, actual hover/click selection and camera drags at each view. Untimed isolation checks preserve the Lesotho hole before/after South African selection, verify its fill really draws elsewhere, hide backside Australia completely, and rotate Earth's actual body frame plus the camera to verify France stays registered. The isolated checks temporarily filter the already-loaded layer and restore all features afterward; the timed runs use the complete dataset.

The measured Jezero/Shackleton orbit-to-surface regression and the localized dense GPU/picking tests were rerun successfully; their fresh JSON results are included beside the Earth evidence. The final local full unit suite reports 2,266 passed, 7 skipped and one previously observed unrelated CSPICE progress-timing failure (`gf-reporting.test.ts`). Changed-area tests, build, lint and type checks pass. The final dense Jezero run retains 1,601 features: 16.7 ms median and p95 at detail; close median 16.7 ms with p95 33.4 ms.

The CI smoke uses Chromium software WebGL at 640×480 with the same rendering/interaction assertions and no timing threshold. Hardware profiling is separate. To run locally, start the viewer on 5188:

```sh
DEV_DATA_MODE=local npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5188 --strictPort
CL_GPU=hardware CL_MAX_FRAME_MS=50 CL_OUTPUT=/tmp/geographic-global node scripts/test-geographic-global.mjs
```

Set `CL_CHROMIUM` to an installed Chrome binary if needed. For an untimed software smoke after `npx playwright install chromium`, use `CL_SMOKE=1 CL_FRAMES=1 node scripts/test-geographic-global.mjs`. `CL_VIEWER_URL` changes the server and `CL_GEOMETRY_ONLY=1` runs only the untimed isolation checks.

Visual review includes orbit, regional, dateline, polar and close-up screenshots. Islands and Antarctica remain coherent and adjacent country boundaries share their source coordinates without visible extra cracks. At 120 km the 1:110m source's coarse straight borders are obvious; this is source cartographic generalization, not a claim of close-up geographic accuracy. The country outline need not coincide with a higher-resolution texture's coastline.

There is no measured Earth terrain pyramid configured in this checkout, so this catalog validates the WGS84 reference globe. Existing measured Jezero/Shackleton terrain and localized dense tests remain the terrain/LOD regressions; they do not establish global Earth DEM registration. A measured Earth catalog can reuse this layer once a compatible, provenance-recorded Earth terrain product is available. Physical mobile GPU testing remains owner-waived; absolute datum-height drawing remains deferred under #197.

## Mars geological regions follow-up

[USGS SIM 3292, Geologic Map of Mars (Tanaka et al., 2014)](https://pubs.usgs.gov/sim/3292/) is a suitable second scientific stress dataset: geologic-unit polygons, variable sizes, multipart geometry and polar regions, with a published scientific interpretation. Use the official downloadable GIS database and unit descriptions, not a tracing or raster-derived surrogate. The map is at 1:20,000,000; its geologic interpretations and uncertainty must remain attached to features.

Recommend a separate follow-up rather than extending #262. Pin the GIS release/checksum/license, inspect each source layer's WKT and latitude/longitude conventions, and inverse-project its native Mars coordinate system into geographic degrees using that declared Mars spheroid. Do not apply an Earth EPSG transform or infer the database CRS from the printed map projection. If the source uses Mars 2000 planetocentric/east-positive coordinates, declare those explicitly and let the existing importer convert centric latitude to the target displayed oblate datum; preserve original coordinates/provenance and state the horizontal datum choice. Reconcile 0..360 or ±180 seam cuts/polar closures explicitly, preserving unit IDs, hole rings, all polygon parts and source topology diagnostics.

Suggested structure: pinned source manifest and reproducible GIS converter, deterministic bounded fixture, `geographic-vectors-mars-geology.json` with orbit/Tharsis/dichotomy/polar/close views, known published unit picks, and the same on/off real-viewer benchmark on a reference globe plus measured MOLA/HRSC terrain. Start with the actual full layer and report any import/storage/draw-limit diagnostics; do not simplify away failures. Earth exposed and now covers the fundamental global index issue, so loading the Mars database is not required to finish this PR.
