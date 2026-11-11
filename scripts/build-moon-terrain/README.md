# Self-hosted Moon terrain (LOLA 118 m + south-pole LOLA residual)

One quantized-mesh pyramid for the Moon, consumed by the `quantized-mesh` path
in `packages/three/src/TerrainManager.ts`. MoonFall
(`scripts/build-moonfall-flights.mjs`) still streams the hosted Mars Hub
`moon_v14` until this pyramid is hosted (#137) and has passed a full-detail
GPU check at Shackleton.

```bash
./01-fetch-sources.sh                  # ~9 GB of public USGS-hosted GeoTIFFs into data/source/
./fused.sh                             # runs ./fuse.sh (~7 min, peak RAM ≈ 7 GB), then tiles ~45 min on 4 cores
node ../validate-terrain.mjs --preset moon-shackleton-fused
```

`./fuse.sh` alone writes the fused field (`data/fused/`) that every product
below tiles: `fused.sh` (geographic), `polar.sh` (#144 polar cap) and `cube.sh`
(#149 cube sphere).

Output: `apps/viewer/test-catalogs/data/moon-terrain-fused/` (`layer.json`,
`z/x/y.terrain`, `terrain-product.json`, `fusion.json`; 1.18 M tiles, ~11 GB; gitignored, not on the
deployed site yet — same hosting gap as Mars, #137).

A catalog streaming this pyramid near the pole needs `samplerMaxTiles` well
above the default 256 (MoonFall uses 4096): one polar view holds hundreds to
thousands of sliver tiles, and the CPU sampler must keep the ones under the
camera for picking and dolly clearance.

To switch MoonFall, replace the terrain block's source in
`build-moonfall-flights.mjs` and regenerate the catalog (`imagery` unchanged):

```js
terrain: {
  type: 'quantized-mesh',
  url: '<hosted moon-terrain-fused base URL>/',
  referenceRadiusOffsetKm: 0,
  datum: { verticalDatum: 'reference-sphere', heightConvention: 'radial' },
  sourceMetadata: { id: 'moon-lola-118m+south-pole-lola-10m-residual (scripts/build-moon-terrain/fused.sh)' },
  samplerMaxTiles: 4096,
  imagery: { ... },
},
```

Use an absolute hosted URL for production. Local catalogs can point at
`data/moon-terrain-fused/` relative to its catalog and run with
`npm --prefix apps/viewer run dev`; the development server exposes the repository
examples in that namespace. Production only contains examples when
`BUNDLE_TEST_CATALOGS=1` is set, and hosted builds rewrite published terrain
references to the data host.

## Square-tile polar cap (prototype, #144)

`./polar.sh` tiles the same fused field as a quadtree on the mosaic's polar
stereographic grid instead of geographic slivers, as 3D Tiles 1.1
(`apps/viewer/test-catalogs/data/moon-terrain-polar/tileset.json`, one `.glb`
per tile, 27.7 k tiles, ~4.2 GB, ~25 s). Every tile is a square 65² lattice with
no simplification, normals from the same one-ring differences, and skirts that
copy their edge normals. It covers only the 200 km mosaic square, so it loads
as `type: '3dtiles'` with `errorTarget: 2` (the quantized-mesh plugin's
recommended value, so both pyramids refine to the same on-screen error). It
has no CPU sampler support yet and is not joined to the global pyramid; see
#144 for the GPU comparison.

## Cube-sphere experiment (#149)

`./cube.sh` tiles the same fused field on the gnomonic cube of
`packages/three/src/surface/CubeSphere.ts` as 3D Tiles 1.1 (one `.glb` per tile)
plus a CPU height grid per tile (`cpu-grids.json`, `heights/`), into
`apps/viewer/test-catalogs/data/moon-terrain-cube/` (4,030 tiles, ~720 MB,
~12 min on 4 cores, 1 min 43 s on 14; gitignored, not hosted). All six faces to
level 3, then bounded detail: Shackleton to 13 m within 15 km, and one face
corner and one face edge to 212 m. Mixed-LOD cracks are covered by skirts sized
per edge from the gaps measured against every other level across it;
`--skirt-cells 0` builds without them, and the viewer can hide them at runtime
(`cubeSphere.skirts: false`) for diagnosis. It is an experiment beside the geographic and
polar products, not a replacement; see
[the ADR](../../docs/design/cube-sphere-experiment.md).

Each build also runs `dem.py cube-error`, which bounds every parent's distance
from its children on the emitted triangles and writes `tileset-measured.json`
(that bound, propagated through REPLACE, as geometricError) and
`mesh-error.json` beside the default `tileset.json` (0.25 × face-centre vertex
spacing). `--simplify FRAC` RTIN-simplifies the meshes (edges kept, CPU grids
unchanged); build it into its own directory so the baseline stays intact:

```bash
./fuse.sh && ./cube.sh                 # and ./polar.sh for the #145 baseline
CUBE_OUT=../../apps/viewer/test-catalogs/data/moon-terrain-cube-simplified-003 ./cube.sh --simplify 0.03
npm run build && node ../validate-cube-terrain.mjs     # gates + measurements → work/cube-terrain/validation.json
npm --prefix ../../apps/viewer run dev                 # then open:
#   http://127.0.0.1:5173/?catalog=test-catalogs/experiments/moon-terrain-cube
#   (…/moon-terrain-polar and …/moon-terrain-geographic for the baselines)
CHROMIUM_PATH=… node ../capture-cube-terrain.mjs --product cube   # and --product polar
```

In the demo, the body info panel's altitude readouts and the camera clamp
sample the CPU grids; the pick tool (click on the surface) shows the rendered
hit and the #148 CPU hit (`CPU hit`, `CPU vs rendered`); the debug panel's
`cube-face` and `cpu-coverage` views show faces and CPU residency.

## Cube-face imagery (#149)

`./cube-imagery.sh` builds imagery pyramids on the same cube faces for the
cube-sphere product, at their own levels: `CubeImageryLayer` drapes them on
whatever geometry tiles the renderer picked, so imagery refines (to 1.7 m texels
at the pole) without generating or loading more terrain.

```bash
PYTHON=python3 ./cube-imagery.sh fixtures   # synthetic grid + registration pyramids (~10 min, offline)
PYTHON=python3 ./cube-imagery.sh nac        # LROC NAC South Pole mosaic, read remotely by window (~10 min)
PYTHON=python3 ./cube-imagery.sh wac-nac    # global LROC WAC + NAC composite: MoonFall's imagery (6 GB WAC download once)
npm run build && node ../validate-cube-imagery.mjs
npm --prefix ../../apps/viewer run dev      # then open one of
#   http://127.0.0.1:5173/?catalog=test-catalogs/experiments/moon-terrain-cube-imagery-grid
#   …/moon-terrain-cube-imagery-registration, …/moon-terrain-cube-imagery-nac
CHROMIUM_PATH=… node ../capture-cube-imagery.mjs
```

Outputs (gitignored; `wac-nac` and `nac` are published, see docs/data-hosting.md): `apps/viewer/test-catalogs/data/moon-imagery-cube-{grid,registration,nac,wac-nac}/`
with `imagery.json` (tiles, layout, registration, provenance) and, for the grid,
`markers.json` (each control point's expected tile and pixel at every level).
The debug panel's `imagery-level` view shows the displayed imagery level per
pixel; `imagery-unlit` shows the raw texels. The registration convention and the
runtime design are in [the ADR](../../docs/design/cube-sphere-experiment.md#independent-imagery-2026-10-14).

## Sources (public, no auth)

### Independent optical layers (#147)

`optical.py` builds the ordinary cube imagery stack used by LRO and MoonFall:
WAC context, the original controlled NAC detail enabled by default, and optional
PSR observations disabled by default. `scripts/lib/lunar-optical-imagery.mjs`
also supplies the MoonFall generator. Terrain, source grids and simulation-time
Sun calculations are unchanged. WAC and NAC retain the previous catalog lighting
policy to preserve appearance; the PSR observation explicitly declares `baked`.

```sh
# Use the original WAC COG and the published composite's imagery.json as inputs.
# The composite supplies tile selection only; its JPEG pixels are never sampled.
python3 scripts/build-moon-terrain/optical.py split \
  --base scripts/build-moon-terrain/data/source/wac-global-100m-cog.tif \
  --baseline apps/viewer/test-catalogs/data/moon-imagery-cube-wac-nac/imagery.json \
  --out apps/viewer/test-catalogs/data
# Download ORIGINAL PDS IMG, not the lower-resolution GeoTIFF browse product.
python3 scripts/build-moon-terrain/optical.py psr \
  --source scripts/build-moon-terrain/data/source/NAC_POLE_PSR_SOUTH_STRETCH.IMG \
  --out apps/viewer/test-catalogs/data
python3 scripts/build-moon-terrain/validate-optical.py \
  --source scripts/build-moon-terrain/data/source/NAC_POLE_PSR_SOUTH_STRETCH.IMG \
  --product apps/viewer/test-catalogs/data/moon-imagery-cube-psr-nac-stretch
```

Run from the repository root. One worker and a 64 MB GDAL cache per process are
the defaults; an earlier 12-worker build exhausted memory. Use fresh output
directories. An interrupted `work/lunar-optical/psr-validity.tif` is incomplete
and must be removed before retrying. Source files and large generated products
are ignored by Git. Existing `publish-data.mjs` validates, uploads and verifies
immutable builds before recording their IDs in `datasets.json`.
The sampler vectorizes only the exact zero-origin, unit-scale spherical
south-polar projection. Tests compare it with GDAL and reject different
meridians, scales and pole origins; other projections retain the GDAL path.

Pinned inputs and source qualifications:

- **WAC:** the original baseline's `wac-global-100m-cog.tif`, SHA-256
  `fa1af0ace36c1d481b246c8362c3fd6128b7757ee5114a9d69ef98efdfecbdac`.
  It comes from `Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif` via the
  existing `cube-imagery.sh wac-nac` source preparation. Same overview policy,
  3x3 box quadrature, and JPEG quality 90 as the shipped composite. WAC retains
  the entire original tile selection, including deep polar fallback tiles.
- **NAC:** the exact [USGS mirror COG](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Lunar_safed/LMAP/SouthPolar/LRO_LROC_NAC_SPOLE-90_Mosaic_1m_controlled_cog.tif)
  sampled by `cube-imagery-composite-3f34a19541af7710`; 77,174,580,438 bytes,
  ETag `bed0aa45cad34ee85a59fa4084b4522d-9200`, checked before and after the
  build. 364214-square, 1 m, polar stereographic on the 1737400 m sphere,
  affine `[-182107,1,0,182107,0,-1]`; zero is transparent. No new stretch,
  balancing, registration shift, or attempt to unblend the shipped JPEGs.
  The mirror's modification time is December 2024; the old builder's November
  2025 release attribution was unsupported. The linked controlled-average
  product's 2023 README does not establish this mirror's exact release date.
- **PSR:** [original PDS product](https://pds.mcp.nasa.gov/data/store/img/lunar_reconnaissance_orbiter/pds4/lroc/lro-l-lroc-5-rdr/LROLRC_2001/DATA/BDR/NAC_POLE/NAC_POLE_PSR_SOUTH/NAC_POLE_PSR_SOUTH_STRETCH.IMG),
  v1.1, 3,696,944,006 bytes, SHA-256
  `7d8f3f48a439f673263a46e133fe37803203786597f35ee328b1621326383a1d`;
  60802-square at 10 m, affine `[-304010,10,0,304010,0,-10]`. Creation
  2022-12-02; acquisition 2012-08-01 to 2017-08-31. Valid display DN are
  **3–254**, including black 3 and clipped display white 254. NULL 0, LIS 1,
  LRS 2 and high saturation 255 are excluded **before** constructing area-average
  premultiplied DN/validity overviews. No-data remains transparent at every LOD.
  The supplied browse TIFF has 51810-square pixels at 11.735572 m and is not
  substituted for the original 10 m PDS raster. The built detail footprint is
  finite, finer near Shackleton/pole, not uniform 10 m coverage of 80–90°S.

[LROC's source description](https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_POLE_PSR_SOUTH)
documents 20–80x exposures, elongated effective footprints (10–40 by 1–4 m),
per-PSR stretch/gamma, arbitrary display values and **uncontrolled** placement.
Pixels inside a shadowed floor are indirect-light observations, not evidence of
sunlight at the selected epoch. Registration uses the LRO DE421 mean-Earth map
convention documented in [the frame audit](../../docs/validation/lunar-frames/README.md)
and [LROC's coordinate discussion](https://doi.org/10.3847/psj/ad54c6); spherical
polar projection is a map conversion, not an IAU-to-DE421 orientation transform.
Absolute registration accuracy remains unknown. LROC PDS data are
[public domain with requested attribution](https://www.lroc.im-ldi.com/about/terms).
ShadowCam outreach composites are not inputs to this build.

- **Canonical global:** LRO LOLA LDEM 118 m (Mar 2014), USGS Astrogeology
  mosaic. Int16 half-metres above the 1737.4 km sphere. This is the file
  `build-moonfall-flights.mjs` samples (nearest pixel) for the authoritative
  MoonFall waypoint elevations, so the waypoints and the canonical surface share
  one source.
- **South-pole control surface:** LOLA 87°S mosaic, 5 m/px (Barker et al. 2021,
  *PSS* 203, 105119; NASA PGDA product 81), mirrored by USGS on S3 as a COG.
  Polar stereographic on the same 1737.4 km sphere, heights in metres (the
  file's NetCDF `actual_range` says km; it is stale). Only the 10 m overview is
  fetched: the pyramid's deepest polar level samples 20 m. About 80% of the
  200 × 200 km square is data (≈86.6°S and poleward); the corners are NaN.
- **Cube imagery (#149 experiment only):** LRO LROC NAC South Pole controlled
  mosaic, 1 m/px (USGS control network, LROC team mosaic, released Nov 2025;
  PDS LRO-L-LROC-5-RDR-V1.0), polar stereographic on the 1737.4 km sphere,
  reaching 81.5°S, a COG on the same USGS S3 mirror. `cube-imagery.sh nac` reads
  only the windows it needs. Permanently shadowed floors (Shackleton's included)
  are black in the source.
- **Considered, not used:** the SLDEM2015 + LOLA merge (512 ppd, ±60° only — no
  polar coverage, and the MoonFall scene never leaves the south pole) and the
  LOLA 75°S 30 m polar DEM (superseded by the 87°S mosaic around Shackleton).
  No image-derived detail is used: nothing reaches the waypoints' needs that the
  LOLA mosaic does not already provide.

## How it is built

`../terrain/dem.py fuse` treats the polar mosaic as detail over LOLA 118 m:
residual = polar − global, tapered to zero over 2 km inside the mosaic's
coverage edge. The fitted planar bias is −0.24 m with slopes under
0.002 m/km — the two products are already co-registered — and is disclosed,
not removed (`--bias none`).

The mosaic is polar stereographic, so its residual, weight and the base
resampled onto its grid (`base.tif`) stay on that x/y grid. `dem.py tile`
writes height = (1 − w)·base(lon, lat) + w·base_xy + residual: where the weight
is 1 the surface *is* the polar mosaic, and the pole is single-valued. With the
base sampled in lon/lat alone, the 118 m kernel's longitude-dependent value at
the pole would spread the pole vertex by metres (the `dem.py selftest` polar case
fails by 7 m without the hand-over).

Zoom levels: global to z9 (≈167 m vertex spacing); then z10 over the whole
mosaic, z11 south of 87°S and z12 (≈21 m spacing) south of 88.5°S, which covers
every MoonFall waypoint. Each geographic tile row at the pole costs 2^(z+1)
tiles however thin, which is why the deep levels narrow.

## Known source defects

The LOLA 118 m global DEM carries isolated ±8 km spike clusters near the south
pole (a few hundred pixels, mostly 88–89°S; e.g. lon −60.9°, lat −88.97°).
They are why `fusion.json` reports residual maxima of ~3.9 km against a 3.6 m
RMS. All of them lie inside the mosaic's full-weight region, where the tiled
surface is the mosaic alone, so none reach the pyramid; isolated spikes
elsewhere on the globe (≈1e-7 of pixels) are in the base and would be in any
product built from it. No MoonFall waypoint was sampled on one.
