# Self-hosted Moon terrain (LOLA 118 m + south-pole LOLA residual)

One quantized-mesh pyramid for the Moon, consumed by the `quantized-mesh` path
in `packages/three/src/TerrainManager.ts`. MoonFall
(`scripts/build-moonfall-flights.mjs`) still streams the hosted Mars Hub
`moon_v14` until this pyramid is hosted (#137) and has passed a full-detail
GPU check at Shackleton.

```bash
./01-fetch-sources.sh                  # ~9 GB of public USGS-hosted GeoTIFFs into data/source/
./fused.sh                             # fuse ~7 min (peak RAM ≈ 7 GB), tile ~45 min on 4 cores
node ../validate-terrain.mjs --preset moon-shackleton-fused
```

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
`VITE_BUNDLE_TEST_CATALOGS=1` is set, and hosted builds rewrite published terrain
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

## Sources (public, no auth)

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
