# Global geographic vectors: Natural Earth countries

Open `http://127.0.0.1:5188/?catalog=test-catalogs/geographic-vectors-earth-countries` in the regular viewer. Use **Display → Viewpoint** for Earth orbit, Europe and Africa, Pacific dateline, Antarctica, Rhine close, and Southern Africa holes. Cyan marks are selectable; click a country for gold, hover for white, and drag to rotate without selecting.

## Source and coordinate conversion

Made with [Natural Earth 1:110m Admin 0 countries, version 5.1.1](https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/), [public domain](https://www.naturalearthdata.com/about/terms-of-use/). The fixture retains all **177 features, 29 multipart features, 288 polygon parts, 289 rings, and the Lesotho hole in South Africa**. Its 10,651 vertices are not simplified. This generalized dataset omits many small territories/islands by design; it is not a survey or a definitive list of countries. Natural Earth's default de facto boundary policy is retained.

The source `.prj` declares WGS84 geographic degrees (a=6378.137 km, inverse flattening=298.257223563). The catalog declares east-positive longitude, planetographic latitude and WGS84 ellipsoid radii [6378.137,6378.137,6356.752314245] km, matching the actual Earth globe. There are no source heights. Drawing clamps to the displayed triangles; it does not implement absolute datum-height drawing or establish terrain/datum accuracy.

Two representation issues must be addressed during Shapefile-to-GeoJSON conversion. These are recorded in [the source manifest](../apps/viewer/test-catalogs/geographic/natural-earth-countries.source.json):

- Seam endpoints within 1e-10 degrees of ±180 are canonicalized to -180. Russia contains two source coordinates at 180.00000000000006, outside a strict longitude domain.
- Antarctica's planar map cut closes its main coastline via A,pole,pole,A on the two sides of the ±180 seam. On the globe these two meridians coincide. Remove only that zero-area closing spike (three redundant vertices); the closed coastline then winds around the south pole and uses the existing polar chart. All actual coastline vertices and all eight Antarctic polygon parts remain.

The original planar closure is not an ordinary physical coastline or a valid nondegenerate polygon in the renderer's spherical topology. This is an explicit representation conversion, not a silent fix to source geography. No other geometry is repaired, rounded, buffered, or omitted. Source `NE_ID` becomes the stable string ID; `NAME`, `ADMIN`, `ADM0_A3`, `ISO_A3` and `NE_ID` properties remain. The importer adds its normal `string:` prefix to the feature identity.

Reproduce the 439,236-byte fixture (SHA256 `03bde95a34084c9c48bb4c496c1e490f810a4360b112cc46f4344a8e33d7a089`):

```sh
curl -fL https://naciscdn.org/naturalearth/110m/cultural/ne_110m_admin_0_countries.zip -o /tmp/ne-countries.zip
python3 -m venv /tmp/natural-earth-venv
/tmp/natural-earth-venv/bin/pip install pyshp==2.3.1
/tmp/natural-earth-venv/bin/python scripts/prepare-natural-earth-countries.py /tmp/ne-countries.zip
```

The converter rejects an archive whose SHA256 differs from the pinned official release. It preserves source double precision, part order, and pyshp's exterior/hole grouping. Normal viewer loading and all tests use the committed fixture; third-party network access is not required.

## Findings and bounded fixes

The original global fallback admitted all 177 countries with no budget diagnostics, but repeated broad padded candidates over the full surface. At 3840×2160 it took approximately **100 ms median / 116.7 ms p95** at the Rhine close-up and **50 / 50.1 ms** at Antarctica. Vectors disabled stayed near 16.7 ms. CPU submission was below 1 ms: this was fragment work, not GeoJSON parsing or picking.

The index now bounds polar primitives by their actual angular wedge and minimum/maximum radius. Triangles containing the pole and marks whose padding reaches it still span every longitude. It also packs one optional **256×128 global grid**, using the same padded-cell, bounded paging, footprint selection, source IDs and primitive records as the localized acceleration. Both polar and longitude/latitude primitives keep their own chart. Near seams, longitude bins wrap; exact pole rows clamp. When the screen footprint exceeds the grid's padding, the original coarse level remains available.

All references, including the optional global grid, share the existing one-million-reference limit. Finer indexing is skipped if it exceeds the storage limit or requires more draw pages. The 256-candidate loop, 100,000 primitives, 16 admitted pages/group and 2,048 surface draws/frame limits remain. No feature is removed to accelerate this fixture. There is no frame-by-frame rebuilding, per-country mesh, reduced coastline geometry or disabled picking.

This dataset has **20,149 primitives**, **265,164 coarse references**, **647,200 total references**, six coarse draw pages and two fine pages. The globe submits six bounded draws/frame; unnecessary fine pages discard. Padded GPU texture allocation is **12,910,592 bytes**, versus 10,256,384 before refinement. These counts are invariant across the five views.

The integration also exposed a camera-drag selection bug: the existing gesture guard covered probe/measurement tools, but ordinary geographic selection could run on mouse release. Active geographic layers now participate in that guard, including return-to-origin drags through the existing maximum-excursion tracking.

The bounded global path is suitable for this complete 1:110m workload on the tested desktop GPU. This does not establish support for arbitrary GIS layers, larger resolutions, or mobile hardware. Larger datasets still need explicit admission diagnostics and representative performance measurements.

## Hardware measurements

Apple M4 Max, ANGLE Metal, physical desktop GPU. Normal viewer with its normal rendering and pointer hover; 1920×1080 CSS at DPR 2, **3840×2160 drawing buffer**. Each viewpoint compares vectors off/on after warm-up. Frame intervals are 60 requestAnimationFrame samples after ten discarded samples. CPU measurements cover `renderFrame` and geographic picking. Twenty nonblocking `EXT_disjoint_timer_query_webgl2` queries measure the full scene's GPU elapsed time (including vectors), outside readback/screenshot capture; disjoint results are rejected. Frame-rate capping alone is not evidence of low GPU cost.

Final numerical results, pixel counts, interactions and screenshots live in [the hardware evidence directory](validation/geographic-vectors/global-m4-max/). Timing is device/workload specific, not a mobile benchmark.

| View | Frame median off/on (ms) | Frame p95 off/on (ms) | GPU median off/on (ms) | Render CPU median on (ms) |
|---|---:|---:|---:|---:|
| Earth orbit | 16.7 / 16.7 | 16.8 / 16.8 | 1.03 / 5.35 | 1.3 |
| Europe and Africa | 16.7 / 16.7 | 16.8 / 16.8 | 1.03 / 5.59 | 0.8 |
| Pacific dateline | 16.7 / 16.7 | 16.7 / 16.8 | 1.51 / 4.73 | 0.9 |
| Antarctica | 16.7 / 16.7 | 16.8 / 16.8 | 1.35 / 5.99 | 1.2 |
| Rhine close | 16.7 / 16.7 | 16.8 / 16.8 | 1.41 / 13.82 | 0.3 |

All visible runs retain 177 features with no diagnostics; picking CPU p95 is at most 0.3 ms. Pixel comparisons confirm visible vector drawing at every timed view. GPU times measure the entire renderer, not vectors alone. The uncapped GPU measurements show why identical 60 Hz frame intervals do not imply equal render cost.

## Correctness and automated coverage

`GeographicGlobal.test.ts` admits all source countries without diagnostics; exercises France and French Guiana, Germany, South Africa/Lesotho, Fiji on both sides of the dateline, Russia on both sides, Greenland, Australia, Japan, Antarctica and ocean misses; and checks vertices, edge midpoints and interior samples of **every primitive** against both coarse and fine candidate cells. Packed polar chart identities, cell loop bounds and total storage bounds are checked. Samples on each side of all shared France/Germany edges must pick the correct adjoining countries without a gap. Existing localized dense tests still verify every Jezero target at every local level.

`scripts/test-geographic-global.mjs` loads the regular catalog without `?test=1` or a test-only scene. It checks visible pixel differences against each unmarked baseline, retained feature counts, diagnostics, actual hover/click selection and camera drags at each view. Untimed isolation checks preserve the Lesotho hole before/after South African selection, verify its fill really draws elsewhere, hide backside Australia completely, and rotate Earth's actual body frame plus the camera to verify France stays registered. The isolated checks temporarily filter the already-loaded layer and restore all features afterward; the timed runs use the complete dataset.

The measured Jezero/Shackleton orbit-to-surface regression and the localized dense GPU/picking tests were rerun successfully; their fresh JSON results are included beside the Earth evidence. The full local unit suite has one previously observed unrelated CSPICE progress-timing failure (`gf-reporting.test.ts`); the changed-area tests, build, lint and type checks pass.

The CI smoke uses Chromium software WebGL at 1100×760 with the same rendering/interaction assertions and no timing threshold. Hardware profiling is separate. To run locally, start the viewer on 5188:

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
