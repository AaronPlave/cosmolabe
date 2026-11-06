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

The legacy `time` field is a fixed date in the same system, so there is one date substitution: a `/default/YYYY-MM-DD/` URL segment or a WMTS `{Time}` dimension. A URL that carries neither logs a warning, because the label would otherwise name a day the pixels are not.

Source time is resolved by pure functions (`resolveImageryTime`, `ImageryTimeFollower` in `packages/three/src/ImageryTime.ts`). A day resolves to one of: *exact*, *nearest* (only with `outOfRange: "nearest"` in follow mode; the offset is labelled), or nothing, because it is *before the source's first day*, *after its last*, *later than the clock allows it to have been published* (`today − latencyDays`, whatever the declared range says) or *invalid*.

## What changes on screen

* **Atomic day switch.** A new day replaces the layer's overlay. The old overlay is removed first, which aborts its queued fetches and releases its textures; a setup still in flight for an older day is retired by a generation counter, so a late response cannot attach an old day. A layer therefore never holds tiles of two days. While the new day loads, the layers beneath show through.
* **Throttled following.** A new day must hold 0.4 s, changes are at least 1 s apart, and one is forced after 3 s of continuous change. Fast playback or scrubbing requests a few days, not one per frame. Explicit choices (a typed date, a policy switch, re-enabling the layer) apply at once.
* **Bounded work.** One overlay per layer at a time; a hidden layer requests nothing and does not follow, and comes back showing the current day. Terrain geometry is never touched: it is the existing overlay path (enable, opacity, order unchanged).
* **Missing days.** Outside the range, or not yet published: the overlay is removed and nothing is requested (badges *Before data*, *After data*, *Not published*). A day inside the range whose tiles fail (404, CORS, rate limit): the layers beneath show through, with the layer's usual *Gaps* / *No imagery* state. No other day is fetched to stand in.
* **Time scripts and readiness.** `getImagery` reports `time` (policy, `date`, `requestedDate`, `state`, `offsetDays`, range, illumination) per dated layer, and `waitUntilReady` for an imagery layer is *partial* while a newer day waits out the throttle and *unavailable* while no day is shown.

The Imagery section shows `Acquired <date> · follows time | fixed | latest` under the layer name, and, in the expander, the date mode, a date picker for `fixed`, cadence, available range (and whether the provider declared it), the number of day changes, and: *acquisition date, not the simulation epoch; lit as acquired, not relit to the simulated Sun*. Daily true-colour imagery has the Sun of its acquisition baked in; it is not physically relit, and coordination with the light/provenance contract (#204) should carry that qualification if the labels change.

## Earth pilot: `test-catalogs/earth-gibs-daily`

Open with `?catalog=test-catalogs/earth-gibs-daily` (or from the developer index). Layers, bottom to top: the static `earth-5k.jpg` map; streamed **Blue Marble** (no acquisition date); **MODIS Terra corrected reflectance, true colour**, daily, following simulation time. Viewpoints: *Earth from orbit* (default), *Regional close-up* (central California coast) and *Track ISS* (the 2011 TLE of `iss.json`, so the layer follows to 2011 when the clock is moved there; the ISS mesh is a Git LFS object).

**What the imagery shows.** One composite per UTC day of what MODIS on Terra recorded that day: clouds are real weather, not a cloud product. Expect swath edges and gaps between orbits, no data in polar night, sun glint, and imagery that is not matched to the simulated Sun's position.

**Cadence, range, latency.** Daily (UTC). The catalog declares a first day of 2000-02-24 and, from the clock, a newest day of yesterday (`latencyDays: 1`). Before that day, or from tomorrow, the layer shows nothing.

**Attribution.** NASA GIBS, MODIS Terra. NASA's standard acknowledgement, from memory and to be checked against GIBS's current wording before publishing, is: *"We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Observing System Data and Information System (EOSDIS)."* GIBS imagery is openly available; confirm the current terms before redistributing it.

**Not in the pilot.** An optional cloud layer (its product name and temporal behaviour were not verified); `wmts-capabilities` for GIBS (the capabilities document is large; the machinery is implemented and tested against a time dimension, and `latest` needs it); a script verb for choosing a fixed date (use the Imagery section, or `BodyMesh.setImageryLayerTime`).

### Unverified endpoint facts

This work was developed in a sandbox whose network policy blocks `gibs.earthdata.nasa.gov`, so **none of these have been checked against the live service**:

* the product `MODIS_Terra_CorrectedReflectance_TrueColor` exists under `epsg3857/best` with tile matrix set `GoogleMapsCompatible_Level9` (the catalog follows the pattern of the `BlueMarble_ShadedRelief_Bathymetry` / `GoogleMapsCompatible_Level8` layer already in `iss.json`);
* its first day (2000-02-24) and the publication lag (`latencyDays: 1`);
* that browsers get CORS headers on tile requests;
* that a day before the first returns no tile, and how rate limiting answers.

Run `node scripts/test-time-indexed-imagery.mjs --live` against a viewer with network access before relying on them; it checks CORS, that two days differ, and that a pre-start day has no tiles, and then runs the same rendering checks against the real service. Correct `url`, `levels`, `start` and `latencyDays` in the catalog if it disagrees.

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
