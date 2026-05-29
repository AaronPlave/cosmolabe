# Self-hosted MOLA-aligned Mars terrain

Build a quantized-mesh tile pyramid for Mars from public, MOLA-aligned USGS
products. Output is consumed by the existing `quantized-mesh` terrain path in
`packages/three/src/TerrainManager.ts` (same code path used by
`apps/viewer/test-catalogs/msl-dingo-gap.json`).

## What this produces

- A global MOLA-correct Mars terrain at 200 m/px (USGS MOLA-MEX HRSC blend),
  with the Mars 2020 TRN HiRISE 1 m DTM composited in over Jezero.
- Output tree at `apps/viewer/test-catalogs/data/mars-terrain/{layer.json,
  z/x/y.terrain, ...}`, served by Vite at `/test-catalogs/data/mars-terrain/`.
- No code changes; the Ingenuity-at-Jezero catalog is rewired to point at the
  local URL after the pipeline runs and `referenceRadiusOffsetKm` is
  calibrated.

## Sources (public, no auth)

- **Global:** `Mars MGS MOLA - MEX HRSC Blended DEM Global 200m` — USGS Astrogeology.
  Same product Cesium Mars uses globally.
- **Jezero detail:** `Mars 2020 Terrain Relative Navigation HiRISE DTM Mosaic`
  (1 m/px, MOLA-aligned via DeltaGeoid correction) — USGS Astrogeology.
  Higher-resolution than Cesium's 20 m CTX inset and (a) registered to MOLA,
  (b) tiled by us instead of Cesium, eliminating the spatial drift we measured
  in Cesium's Jezero region.

See top of each numbered script for source URLs.

## Prerequisites

- `bash`, `curl`
- Docker (for `tumgis/ctb-quantized-mesh`)
- GDAL CLI tools (`gdalinfo`, `gdalbuildvrt`, `gdaladdo`, `gdallocationinfo`).
  On macOS: `brew install gdal`. The Docker image bundles GDAL too, so this is
  only required for sanity checks outside the container.

Disk: source GeoTIFFs are a few hundred MB to several GB; tile output is
~1-3 GB through zoom 15. None of this is checked into the repo
(`.gitignore`'d).

## Running

From this directory:

```bash
./01-fetch-sources.sh
./02-build-elevation-vrt.sh
./03-tile.sh
```

Then, **one-time calibration** (see "Calibration" below) to derive the single
`referenceRadiusOffsetKm` constant for the catalog.

## What each script does

- **`01-fetch-sources.sh`** — downloads the two source GeoTIFFs into
  `./data/source/`. Verifies each with `gdalinfo` (CRS, units, nodata).
  Idempotent — skips files that already exist.
- **`02-build-elevation-vrt.sh`** — composites the two GeoTIFFs into a single
  GDAL VRT (`./data/composite.vrt`), with HiRISE preferred where it has
  coverage and MOLA-HRSC filling in everywhere else. Both inputs are already
  in equirectangular geographic (`Eqc latTs0 lon0`), so no reprojection is
  needed. Then `gdaladdo` builds internal overviews so the tiler can sample
  efficiently at every zoom level.
- **`03-tile.sh`** — runs `tumgis/ctb-quantized-mesh` in Docker for two
  source-specific tiling passes (global MOLA z0-9, Jezero HiRISE z10-15),
  then invokes `04-write-layer-json.mjs`. Output goes to
  `apps/viewer/test-catalogs/data/mars-terrain/`.
- **`04-write-layer-json.mjs`** — walks the on-disk tile tree and emits a
  quantized-mesh-1.0 `layer.json` with accurate per-zoom `available` ranges.
  (Equivalent CTB command — `ctb-tile -l` on the global 1 m/px composite VRT
  — hangs trying to enumerate billions of theoretical tile positions.)

## Calibration (one number, derived once)

CTB encodes vertex z relative to an implicit Earth-WGS84 ellipsoid. The Mars
renderer expects Mars radii, so a single global offset corrects every tile —
analogous to how `msl-dingo-gap.json` uses `referenceRadiusOffsetKm: 8.765`
for the marshub Mars_v14 tileset.

To derive ours:

1. Open `http://localhost:5174/` and load the Ingenuity-at-Jezero demo.
2. Note the BodyInfoPanel "Above terrain" reading at the moment Ingenuity is
   at Wright Brothers Field (Flight 1 takeoff, before climb). Trajectory says
   altitude there should be ~0 m.
3. If reading is +X m, the terrain is X m too low → increase
   `referenceRadiusOffsetKm` by X / 1000 km. If -X, decrease by X / 1000.
4. Iterate once or twice; one constant should make all 72 airfields read
   correct. If different airfields need different constants, the source data
   has spatial drift — escalate to the Phase 2 Tao 2023 50 cm product.

## What this does NOT do

- Does **not** generate or replace imagery. Mars Trek WMTS overlays
  (`JEZ CTX`, `JEZ HiRISE`, optional global Viking color) stay as catalog
  configuration in `ingenuity-jezero.json` and are rendered separately by
  `ImageOverlayPlugin`.
- Does **not** support Mars-aware ellipsoid encoding in the tiles themselves
  — we use the standard CTB Earth pipeline and absorb the radius difference
  via `referenceRadiusOffsetKm`. Same trick the existing marshub catalog
  uses.
- Does **not** address smaller-scale registration drift inside the HiRISE
  product itself (USGS TRN-prep tolerance, typically ≤ a few meters). If
  measured residual exceeds that at any airfield, see the Tao 2023 escalation
  note in `~/.claude/plans/lazy-jumping-hanrahan.md`.
