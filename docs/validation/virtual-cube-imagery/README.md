# Virtual cube imagery: arbitrary-location imagery over coarse cube terrain (#136)

Ordinary XYZ / TMS / WMTS imagery services, geographic (EPSG:4326) or Web Mercator
(EPSG:3857), including time-indexed NASA GIBS layers, can now be drawn on cube terrain.
The browser resamples their tiles on demand into the registered cube tiles that
`CubeImageryLayer` (#272) already draws. There is no preprocessing step, no tile list
and no extra service. Imagery detail follows the view and the source's native
resolution. Terrain depth plays no part, and the geometry is never changed.

Cube products and virtual sources share one stack with one texture budget, one request
limit and the same controls: enable, order, opacity, bounds, status, cache diagnostics
and dates.

## Decision gate (A: browser-side virtual cube tiles vs B: build-derived cube tiles)

<!-- GATE -->

## How it works

* **Registration.** Every cube texel centre, including gutter texels, has a geocentric
  body-fixed direction (the `CubeImagery.ts` convention). That direction is converted to
  the source's declared latitude convention (`planetocentric`, or `geodetic` on the
  terrain body's ellipsoid), then projected into the source matrix's pixel grid. Pixel
  centres sit at +0.5, longitude wraps and latitude never does. Exact positions are
  computed on the texel-corner lattice. Sub-samples inside a texel interpolate its four
  corners, with longitude unwrapped across the antimeridian. Unit tests hold
  interpolated texel centres within 0.05 source pixel of the exact position at face
  centres, three-face corners, the antimeridian and the south pole, for both
  projections. When a pole lies within two texels of a tile, its sub-samples are
  computed exactly.
* **Detail.** Each cube tile reads the coarsest source matrix that is at least as fine
  as its finest texel on the meridian, capped at the source's deepest level. Where the
  source is finer than a texel along an axis (geographic sources at high latitude, or
  coarse levels), an anisotropic box filter of up to 4×4 sub-samples per texel prevents
  aliasing. Bilinear sampling uses premultiplied alpha. A virtual source offers cube
  levels down to the shallowest level whose face-centre texel is no coarser than the
  source's finest pixel. Screen-space error decides whether that depth is requested.
* **Availability without a tile list.** A tile exists when its level is inside the
  source's range and it can overlap valid source data: declared `bounds`, and the
  Mercator latitude limit. Lookups are computed and memoised, so a new region costs
  nothing up front and no planet-wide tile index is downloaded.
* **Read budget and poles.** A cube tile may read at most 9 × 512² decoded source pixels
  (nine 512-px or 36 256-px tiles). If a tile would exceed that at its wanted matrix, a
  coarser one is used and counted as *source-limited*. In a geographic source, a cap that
  contains a pole spans every longitude. Where even the first data matrix exceeds the
  budget there, the tile is *unavailable*, so the layers beneath show through and
  nothing is fetched. Web Mercator holds no data poleward of 85.05°, which is
  transparent and never a smeared top row.
* **Failures are never data.** A declared gap (HTTP 404/204) is cached as transparent.
  A failed or corrupt tile is drawn from its true parent, up to three levels up,
  upsampled. That cube tile is counted *degraded*, shows as *Lower res*, and never
  counts as native. If no parent loads, the cube tile fails, the resident ancestor stays
  on screen, and the tile is retried with backoff. A failed mandatory base keeps the
  static map (`baseUncoveredBlocks`). `retryFailed()` recovers explicitly.
* **Shared, bounded work.** One deduplicating source-tile cache is keyed by full request
  URL, which carries the source, matrix, tile and day. Its defaults are 96 MiB decoded
  and 8 concurrent requests. A request shared by several cube tiles is aborted only when
  all of them abandon it. Fetching, decoding, planning and resampling run in a worker,
  and finished tiles come back as transferred buffers. Hosts register the worker with
  `setVirtualImageryWorkerFactory` (the viewer does so in `loader.ts`). Without a
  registered worker, tiles are produced in-thread. Cube textures stay in the existing
  shared page budget.
* **Time (#214).** Dated layers keep the existing contract: `fixed`, `follow-simulation`,
  and `latest` for `wmts-capabilities`, plus the provider range, gaps, latency,
  throttling and labels. A day change replaces the layer's cube tiles atomically:
  in-flight work is aborted, old pages are released, and results that were already
  produced for the old day are retired. While the new day loads, the layers beneath
  show through. A URL that cannot carry a day fails closed and the layer reports
  *failed*. No other day is ever substituted.
* **Terrain independence.** Imagery owns no geometry. The tests below compare terrain
  tile ids, vertex buffers and CPU surface hits before and after imagery refinement and
  date changes.

### Three coverage states, kept apart

| State | Where it is reported |
|---|---|
| Native pixels the upstream source supports | `virtualSources[].coverage`: projection, latitude convention, finest matrix and its m/px, first data matrix, data bounds |
| Tiles fetchable for this configuration | Computed inventory: level range plus bounds/projection limits plus the read budget; never a published list |
| Tiles resident in the viewer | `cubeImageryStats` (textures, bytes, `displayedLevels`), `sampleAt()` per layer, `degradedResident` |

The requested GSD is a fourth, desired quantity and never counts as proof of any of
these three. Parent fallback is never counted as native.

## Evidence

<!-- EVIDENCE -->

## Limits and caveats

* **Upstream dependency.** Virtual sources need the upstream service to be reachable,
  with CORS, from the viewer: Esri `astro.arcgis.com` (CTX), NASA Trek (Viking, HiRISE)
  and NASA GIBS all send `Access-Control-Allow-Origin: *`. An outage degrades to the
  lower layers and is reported, and nothing is cached across sessions beyond the
  browser's HTTP cache. Upstream pixels can change under the same URL, so a virtual
  layer's identity is its configuration and day, not a content hash. For locked,
  reproducible science products, use built cube products (#251/#137).
* **Native detail is the source's, not the request's.** CTX at Gale shows the Murray
  Lab mosaic's own block-compression structure at native zoom; the same rectangles are
  visible in the original z12 tile. A displayed texel finer than the source pixel
  (e.g. 2.4 m texels over a 5.09 m source) magnifies the source and adds no detail. The
  evidence reports both values.
* **Valid coverage is discovered, not asserted.** The computed inventory covers the
  source's declared extent. Gaps inside it (CTX has some; GIBS has missing days and
  swaths) appear as declared 404s (transparent) or as black JPEG pixels, which are
  data. No global "native everywhere" claim is made beyond what the upstream serves.
* **Poles.** A geographic source cannot provide a tile containing a pole within the
  read budget at its data matrices (CTX starts at z5, 64 columns), so that small cap
  shows the layer beneath. Web Mercator sources hold nothing poleward of 85.05°.
* **Not covered.** WMS over cube terrain; publishing global overview or mission-region
  products (#137/#251, #246/#247); catalog migrations. Cube products stay the right
  choice for locked mission footprints and very high-resolution regional data.
* **Fixtures.** The coarse terrains are local validation fixtures. Mars is MOLA MEGDR
  16 px/deg on the #245 areoid-radial convention at global level 5 (~2.6 km vertices).
  Earth is ETOPO 2022 averaged to 4′ at global level 3 (~20 km vertices), with geoid
  heights used as ellipsoid heights (≤ ±110 m, negligible here). Neither is a
  published product.
* **Timing.** Numbers measured in this container use SwiftShader (software GL) on 4
  shared CPU cores, so they are not GPU timings. The same script measures Metal or
  hardware GL with `VIRTUAL_IMAGERY_GPU=metal|hardware`.

## Reproduce

Downloads, all public and requiring no authentication: MOLA MEGDR MEGT90N000EB and
MEGA90N000EB from `pds-geosciences.wustl.edu`, and ETOPO 2022 60″ surface from
`www.ngdc.noaa.gov`. The fixture products are local and gitignored.

```sh
/usr/bin/python3.12 scripts/terrain/coarse_cube_fixture.py mars  --source <mola dir>  --work <scratch>
/usr/bin/python3.12 scripts/terrain/coarse_cube_fixture.py earth --source <etopo dir> --work <scratch>
/usr/bin/python3.12 scripts/terrain/cube_imagery.py xyz --source <bluemarble-3857.json> \
  --out apps/viewer/test-catalogs/data/earth-bluemarble-cube --body Earth --frame IAU_EARTH --radius-km 6378.137 --global-level 3
DEV_DATA_MODE=local npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5196
node scripts/test-virtual-cube-imagery.mjs all work/virtual-cube-imagery     # software GL here
VIRTUAL_IMAGERY_GPU=metal node scripts/test-virtual-cube-imagery.mjs all work/virtual-cube-imagery-metal
/usr/bin/python3.12 scripts/compare-cube-imagery-delivery.py --browser work/virtual-cube-imagery/result.json --work work/gate --out docs/validation/virtual-cube-imagery/gate.json
npx vitest run packages/three/src/__tests__/ProjectedImagery.test.ts packages/three/src/__tests__/VirtualCubeImagery.test.ts
/usr/bin/python3.12 scripts/terrain/test_cube_xyz.py
```

`bluemarble-3857.json` is the GIBS `BlueMarble_ShadedRelief_Bathymetry`
`GoogleMapsCompatible_Level8` template with `"projection": "EPSG:3857"`,
`"latitudeConvention": "geodetic"`, `"ellipsoidRadiiKm": [6378.137, 6356.752314245]`
and a `cache` directory.
