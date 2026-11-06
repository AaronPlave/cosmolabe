# Time-indexed imagery and the Earth GIBS pilot

Follow-on to streamed Globe imagery ([#123](https://github.com/AaronPlave/cosmolabe/issues/123), [catalog format](catalog-format.md#imagery-streamed-surface-imagery)); issue [#214](https://github.com/AaronPlave/cosmolabe/issues/214).

A **dated imagery layer** depicts one *observation (acquisition) day*. That is a different thing from the simulation epoch the Sun, bodies and spacecraft are drawn at. The viewer never shows an arbitrary day's image as if it were contemporaneous with the geometry: the day on screen is always named, and a day the source cannot supply is shown as missing, not replaced.

This is tiled raster imagery with a date. It is not a terrain streamer, a GIS panel, interpolation between days, change detection or an archive of past imagery.

## How a layer picks its day

`temporal` on a `Globe.imagery` layer (fields in the [catalog format](catalog-format.md#time-indexed-imagery)):

| Policy | Shows | Notes |
|---|---|---|
| `fixed` | the UTC `date` | Chosen in the catalog or from the Imagery section. Never swapped for another day. |
| `follow-simulation` | the simulation's UTC day | Throttled to the source cadence (below). |
| `latest` | the newest day the provider declares | `wmts-capabilities` sources only: it reads the WMTS time dimension, and without one shows nothing rather than guessing from the clock. |

`wmts-capabilities` here means a catalog-named single layer: the document configures that layer's tile grid and supplies its time dimension. It is not source or layer discovery, and layers are not added or removed at runtime; that is a separate workflow.

The legacy `time` field is a fixed date in the same system, so there is one date substitution: a `/default/YYYY-MM-DD/` URL segment or a WMTS `{Time}` dimension. A URL that carries neither logs a warning, because the label would otherwise name a day the pixels are not.

Source time is resolved by pure functions (`resolveImageryTime`, `ImageryTimeFollower` in `packages/three/src/ImageryTime.ts`). A day resolves to one of: *exact*, *nearest* (only with `outOfRange: "nearest"` in follow mode; the offset is labelled), or nothing, because it is *before the source's first day*, *after its last*, *later than the clock allows it to have been published* (`today − latencyDays`, whatever the declared range says), *in a gap the provider declares* (*no data*), or *invalid*.

## What changes on screen

* **Atomic day switch.** A new day replaces the layer's overlay. The old overlay is removed first, which aborts its queued fetches and releases its textures; a setup still in flight for an older day is retired by a generation counter, so a late response cannot attach an old day. A layer therefore never holds tiles of two days. While the new day loads, the layers beneath show through.
* **Throttled following.** A new day must hold 0.4 s, changes are at least 1 s apart, and one is forced after 3 s of continuous change. Fast playback or scrubbing requests a few days, not one per frame. Explicit choices (a typed date, a policy switch, re-enabling the layer) apply at once.
* **Bounded work.** One overlay per layer at a time; a hidden layer requests nothing and does not follow, and comes back showing the current day. Terrain geometry is never touched: it is the existing overlay path (enable, opacity, order unchanged).
* **Missing days.** Outside the range, or not yet published: the overlay is removed and nothing is requested (badges *Before data*, *After data*, *Not published*). A day inside the range whose tiles fail (404, CORS, rate limit): the layers beneath show through, with the layer's usual *Gaps* / *No imagery* state. No other day is fetched to stand in.
* **Not in snapshots.** A view snapshot / permalink records each imagery layer's visibility, opacity and order, but **not** its date policy or fixed day, so replaying one does not restore a chosen date (a following layer simply follows the replayed clock). Capturing it needs a script verb and snapshot field, which this PR does not add.
* **Time scripts and readiness.** `getImagery` reports `time` (policy, `date`, `requestedDate`, `state`, `offsetDays`, range, illumination) per dated layer, and `waitUntilReady` for an imagery layer is *partial* while a newer day waits out the throttle and *unavailable* while no day is shown.

The Imagery section shows `Acquired <date> · follows time | fixed | latest` under the layer name, and, in the expander, the date mode, a date picker for `fixed`, cadence, available range (and whether the provider declared it), the number of day changes, and: *acquisition date, not the simulation epoch; sunlight is baked in as acquired, and the viewer also shades the globe by the simulated Sun*.

**Lighting is not reconciled.** Daily true-colour imagery has the Sun of its acquisition baked into its pixels. The renderer does not remove it: imagery tiles are shaded by the simulated Sun like any other surface, so the two lightings stack and the day/night boundary will not match the image (`illumination: "baked"` records this; it does not change rendering). Making baked and reflectance imagery render differently belongs with the light/provenance contract (#204, #365).

## Earth pilot: `test-catalogs/earth-gibs-daily`

Open with `?catalog=test-catalogs/earth-gibs-daily` (or from the developer index). Layers, bottom to top: the static `earth-5k.jpg` map; streamed **Blue Marble** (no acquisition date); **MODIS Terra corrected reflectance, true colour**, daily, following simulation time. Viewpoints: *Earth from orbit* (default), *Regional close-up* (central California coast) and *Track ISS* (a 2011 TLE kept in this fixture, so the layer follows to 2011 when the clock is moved there; the ISS mesh is a Git LFS object).

**What the imagery shows.** One composite per UTC day of what MODIS on Terra recorded that day: clouds are real weather, not a cloud product. Expect black swath gaps between orbits (opaque in the JPEG, clearest from orbit), no data in polar night, sun glint, and imagery that is not matched to the simulated Sun's position.

**Cadence, range, latency.** Daily (UTC). The catalog declares a first day of 2000-02-24 and, from the clock, a newest day of yesterday (`latencyDays: 1`). Before that day, or from tomorrow, the layer shows nothing.

**Attribution.** NASA GIBS, MODIS Terra. NASA's standard acknowledgement, from memory and to be checked against GIBS's current wording before publishing, is: *"We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Observing System Data and Information System (EOSDIS)."* GIBS imagery is openly available; confirm the current terms before redistributing it.

The catalog also carries a second, **switched-off** layer, *MODIS daily (provider range)*: the same product through the capabilities document. Switch it on to take the first day, last day and gaps from GIBS and to choose **Latest available** (the newest declared day, less `latencyDays`). The default layer does not pay the 5.8 MB download; it relies on the catalog's own `start`, `latencyDays` and the service's 404s.

**Not in the pilot.** An optional cloud layer; a script verb for choosing a fixed date (use the Imagery section, or `BodyMesh.setImageryLayerTime`).

### Endpoint facts, checked against the live service (2026-11-06)

* `MODIS_Terra_CorrectedReflectance_TrueColor` exists under `epsg3857/best` with `GoogleMapsCompatible_Level9`, as the catalog's template uses it. Both `BlueMarble_ShadedRelief_Bathymetry` / `Level8` tiles and the MODIS tiles answer `200` with `access-control-allow-origin: *`, so browsers can fetch them cross-origin.
* The first day is 2000-02-24 (`200`); 2000-02-23 and 1999-12-31 answer `404` (with CORS headers), and so does tomorrow.
* Today's tile already exists but is partial (5 KB against 22 KB for yesterday at the same tile), which is why the catalog sets `latencyDays: 1`.
* Tiles are JPEG: swath gaps are opaque black, not transparent, so the layers beneath do not show through them (see the orbit view above). That is data, not a fallback failure.
* **Capabilities URL.** `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&request=GetCapabilities` (the same document is at `…/epsg3857/best/1.0.0/WMTSCapabilities.xml`; `epsg4326/best/wmts.cgi?…` works likewise). It is the whole service, about 5.8 MB, with CORS headers; per-layer paths such as `…/<Layer>/1.0.0/WMTSCapabilities.xml` return `400`. Layer `MODIS_Terra_CorrectedReflectance_TrueColor` lists `GoogleMapsCompatible_Level9`, a `Time` dimension with `Default` = today (`Current` false), and a `{Time}` tile template. In the viewer it loads in roughly 8 s on the sandbox connection, once per session and only when a layer that uses it is switched on.
* **The time dimension has gaps.** It is a list of `P1D` runs, not one span: 2000-02-24 → 2026-11-06 in 11 runs, with missing days between them (for example 2000-04-26 and 2025-11-09). The tile URL for such a day is a `404`, so the viewer reads the runs and reports *No data* for a day inside a gap, rather than asking for it (`outOfRange: "nearest"` picks the closest available day and labels it).
* Not checked: how rate limiting answers.

`node scripts/test-time-indexed-imagery.mjs --live` repeats the CORS, two-day and pre-start checks, and the same rendering checks, against the real service. It passes here: day changes follow the simulation clock, a scrub keeps one overlay, and a day before the product shows nothing.

## Public entry: Earth from Orbit (`iss`)

The public `iss` entry (`test-catalogs/iss.json`, issue [#368](https://github.com/AaronPlave/cosmolabe/issues/368)) uses the same contract with a VIIRS daily layer over Blue Marble, so it is the first view most people get of dated imagery. The `earth-gibs-daily` MODIS fixture above is unchanged.

* **Product.** NASA GIBS `VIIRS_NOAA20_CorrectedReflectance_TrueColor`, `epsg3857/best`, `GoogleMapsCompatible_Level9`, JPEG, with CORS headers. VIIRS's wide, overlapping swaths leave no regular black inter-orbit gaps in the global mosaic (checked on 2026-03-31 and 2026-04-01 at zoom 3); what remains is polar night, sun-glint streaks and real cloud. NOAA-20 was preferred over `VIIRS_SNPP_…` because its provider time dimension is one unbroken run, 2022-01-14 → present, while SNPP's has eight runs with missing days (for example 2024-06-01 to 2024-06-03 answer `404`), and because the SNPP mosaic of the first view's day showed black corners near the poles that NOAA-20's did not. The catalog declares `start: 2022-01-14` and `latencyDays: 1`; a day before the start shows *Before data* and requests nothing. Capabilities checked 2026-11-06.
* **Dates.** The layer follows the simulation day by default (`Acquired 2026-03-31 · follows time`); *Fixed date* in the Imagery section pins any day in range. Open **Surface layers** in the left rail. 2026-03-31 and 2026-04-01 were both served and differ visibly.
* **ISS.** The orbit is one TLE, epoch 2026-03-31 03:11:39 UTC (`1 25544U 98067A   26090.13309952 …`), and the ISS exists only within 3 days of it (`startTime` / `endTime` on the item; `windowDays` does not hide a body). Beyond that the imagery can still be explored but no ISS is drawn, instead of an extrapolated SGP4 position. The default time (2026-03-31 11:00 UTC) puts the ISS over the Atlantic off West Africa on the sunlit side. Checks: both line checksums are valid; Cosmolabe's own sub-point (11.35°N, 20.15°W) agrees with an independent SGP4 propagation; and the TLE's node, advanced by J2 precession to NASA's published ISS ascending node for 2026-11-06 13:30:24 UTC (`nasa-public-data` ISS OEM, Earth-fixed longitude 67.17°), lands at 68.07°, within the accuracy of a J2-only extrapolation over 220 days. The TLE text is the one already used in this repository's tests; its original download source was not recorded, so replace it with a fresh Space-Track or CelesTrak element set (and update the epoch and window) if a cited source is required.
* **Not claimed.** The imagery was captured by NOAA-20, not by the ISS. Sunlight is baked into the daily composite and the viewer also shades the globe by the simulated Sun (#204, #365), so the day/night boundary will not match the image. Blue Marble is a static composite, not contemporaneous.
* **Check.** `node scripts/test-earth-from-orbit.mjs [viewer-url] [dir]` (real GIBS, dev or preview): the first view, the date shown in the Imagery section, two days drawing differently, a fixed day ignoring the clock, a day before the product showing Blue Marble with no tile requests, and the ISS present only within its window.

## Verification

Automated (no network):

* `packages/three/src/__tests__/ImageryTime.test.ts`: source-time resolution, UTC day edges, range/clock rules, `latest`, the follower's debounce, max-wait and request budget.
* `packages/three/src/__tests__/ImageryTimeLayers.test.ts`: the real `TerrainManager`: atomic overlay replacement, retired overlays cannot fetch, obsolete setups cannot attach, bounded overlay builds under 60 fps playback, repeated seeks, hide/show, out-of-range, nearest, not-yet-published, base layer refusal, URLs that cannot carry a date, and a WMTS capabilities time dimension (provider range, `latest`).
* Readiness and snapshot tests in `apps/viewer`.

Real browser, `scripts/test-time-indexed-imagery.mjs` (needs `npm --prefix apps/viewer run dev`; software GL is enough). Default mode answers the GIBS host from the test with one solid colour per UTC day, so the pixels say which day was drawn and a mixture of days would show as a mixture of colours. It checks: the orbit and regional views draw only the simulation day; a one-day step changes once; a fixed date ignores the clock; a 40-days-per-second scrub requests a handful of days, keeps one overlay and does not grow textures; repeated seeks do not grow GPU textures; a day before the product shows nothing and keeps the layers beneath; a day the service 404s fetches no other day and keeps Blue Marble; hiding the layer removes its overlay; and the Imagery section states the acquisition date, cadence and lighting. It writes screenshots and `result.json` (renderer memory, tile cache bytes, request counts) to the output directory.

In the sandbox run (software GL, mock provider) the scrub rendered few frames because software GL is slow, so the 60 fps playback bound is asserted by the `TerrainManager` unit test, not by the browser run. The reported texture and cache numbers (≈45 → 84 textures across the scrub, ≈88 → 74 across 12 seeks, tile cache 19–44 MB of the 256 MB default) are from that run and are not GPU timings.

### Date-change test script (manual, with network)

`test-catalogs/earth-gibs-daily-tour.cosmo` (selectable from the developer index) steps 2024-06-01 → 2024-06-02, moves to the regional close-up, toggles the layer, and seeks 1999-12-31. By hand, comparing fixed date, one-day step, rapid scrubbing, layer toggles and fallback from both viewpoints:

1. *Earth from orbit*, open **Imagery → MODIS daily true colour**. The row reads `Acquired 2024-06-01 · follows time`.
2. Step the clock a day with the timeline controls: it changes once, to `Acquired 2024-06-02`, after a brief moment on Blue Marble.
3. In the expander choose **Fixed date** and pick another day; move the clock: the date does not follow. Choose **Follow simulation** to return.
4. Drag the timeline quickly across months: the row keeps its last day (and shows `loading <day>…` in the expander) until the scrub settles; the network panel shows a few days' tiles, not one per frame.
5. *Regional close-up*: same day, finer tiles. Toggle the layer: Blue Marble shows through; with the surface far away, the static map.
6. Seek a time before 2000-02-24: *Before data*, nothing drawn, no error, Blue Marble stays. Seek a time later than yesterday: *Not published*.
7. Block `gibs.earthdata.nasa.gov` in dev tools: the layer shows *Gaps* / *No imagery* and the globe stays textured.
