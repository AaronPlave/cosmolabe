# Mars cube foundation (#245)

The bounded experiment builds the existing #50 MOLA/HRSC + Jezero residual
field into the shared cube renderer. It changes neither that field nor its
registration fit. It does not switch any production catalog or flight data.

## Coordinate and datum audit

The canonical [USGS MOLA/HRSC product](https://astrogeology.usgs.gov/search/map/mars_mgs_mola_mex_hrsc_blended_dem_global_200m)
uses east-positive longitude, planetocentric latitude and areoid topography.
The [Jezero TRN DTM's source label](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.lbl)
explicitly declares `LatitudeType = Planetocentric`, positive-east longitude,
and a 3396190 m spherical equirectangular map. A spherical map projection does
not make the physical surface spherical.

The [MOLA MEGDR definition](https://pds-geosciences.wustl.edu/missions/mgs/megdr.html)
defines topography as planetary radius minus areoid radius. The
[MEG016 areoid label](https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg016/mega90n000eb.lbl)
states planetocentric coordinates, a 16 pixel/degree global grid, signed
big-endian integer metres, and a 3396000 m offset. This is GMM3 / mgm1025
evaluated to degree/order 50, not a constant ellipsoid correction. The label
describes model truncation and uncertainty; neither that uncertainty nor
interpolation/source errors become a certified bound in this implementation.

For each geocentric cube ray `d`, the Mars builder explicitly computes:

```
source lon/lat = atan2(d.y, d.x), atan2(d.z, hypot(d.x, d.y))
r = bilinear(MEG016 areoid radius, source lon/lat) + existing fused height
P = r * d
stored payload = float32(r - 3396190), in metres
```

The PDS3 map scale is rounded to 3.705 km. Its exact 1/16 degree angular grid
is read from the known MEG016 product definition, avoiding a spurious map
scale shift introduced by deriving angles from GDAL's projected transform.
Longitude interpolation wraps; latitude clamps at the outer pixel centres.
At the exact pole there is one canonical cube direction/longitude.

`datum` describes the public physical query coordinates: IAU_MARS,
`[3396.19, 3396.19, 3376.2]` km, ellipsoid-normal height and planetographic
latitude. `geometry` separately describes radial storage. A CPU sample casts
the declared geodetic normal through the actual Cartesian lattice, including
triangle chord sag. It never reports a radial payload value as normal height.
Arbitrary rays intersect that same CPU lattice independently of rendered
residency. Hits remain provisional (`coarse`); source uncertainty and physical
mesh error remain unknown. Raw radial samplers return no public height.

The optional `ellipsoid-normal` builder convention supports explicitly
planetographic normal-height sources by solving their surface on the fixed
cube rays. Synthetic fixtures check this against independent forward geodetic
coordinates and an ellipsoid closest-point calculation, including negative
heights and a 2:1 flattened body.

## Product and runtime contract

All six faces have roots. Every refinement emits all four children. Full
lattices, shared dyadic directions, radial skirts and subtree boxes reuse the
lunar builder. Ellipsoidal simplification is disabled for this foundation.
The existing `cube-error` pass measures parent/child emitted-triangle error
and propagates it through REPLACE; the experiment uses `tileset-measured.json`.

Product identity hashes source raster bytes, residual bytes, fusion metadata,
the areoid label and external image, generator, shape, frame, body, source
convention, layout and skirt parameters. The CPU grids, product metadata and
tileset share one revision. The public datum and the conversion description
are recorded together. Multi-GB inputs are hashed in bounded memory.

`renderedLatticeRoundingBoundKm` bounds the displacement between the CPU
lattice and local float32 glTF vertices with the same topology. It excludes
source/datum error and subsequent GPU transforms. The separate per-tile
representation estimates compare interpolated radial payloads with the finest
converted field; they are sampled estimates, excluding chord sag, and cannot
certify physical surface accuracy.

Ellipsoidal products return a zero horizon occluder, disabling the spherical
horizon test while keeping conservative frustum culling. No Mars-only renderer
was added. Diagnostic imagery fixtures accept body/frame and an angular
distance metric; their directions stay planetocentric. This does not enable
new observational imagery products.

## Reproduce the bounded build

Use the original #50 `data/fused` directory, including its unchanged
`fusion.json` and `residual.tif`. It was located in the adjacent
`../cosmolabe/scripts/build-mars-terrain` checkout during development.

Download the 33 MB official datum grid into a local source directory:

```sh
mkdir -p /tmp/mola-meg016
curl -fL https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg016/mega90n000eb.lbl -o /tmp/mola-meg016/MEGA90N000EB.LBL
curl -fL https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg016/mega90n000eb.img -o /tmp/mola-meg016/MEGA90N000EB.IMG
MARS_TERRAIN_ROOT=/absolute/path/to/existing/scripts/build-mars-terrain \
MARS_AREOID=/tmp/mola-meg016/MEGA90N000EB.LBL \
  bash scripts/build-mars-terrain/cube.sh --workers 4
npm run build
node scripts/validate-cube-terrain.mjs \
  --dir apps/viewer/test-catalogs/data/mars-terrain-cube-jezero \
  --site 18.65,77.4 --out work/cube-terrain/mars
python3 scripts/terrain/validate_mars_cube.py \
  --dir apps/viewer/test-catalogs/data/mars-terrain-cube-jezero \
  --base /absolute/path/to/existing/scripts/build-mars-terrain/data/source/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif \
  --fusion /absolute/path/to/existing/scripts/build-mars-terrain/data/fused \
  --areoid /tmp/mola-meg016/MEGA90N000EB.LBL \
  --out work/cube-terrain/mars/source-validation.json
python3 scripts/terrain/test_cube_ellipsoid.py
python3 scripts/terrain/dem.py selftest
```

The wrapper refuses to overwrite an existing output directory. It emits 78
tiles: level-0 roots globally and a bounded Jezero chain to level 11 (51.8 m
face-centre spacing, smaller locally). The unlisted catalog
`test-catalogs/experiments/mars-terrain-cube-jezero` opens it in the viewer.
The dataset is registered as `localOnly` in `scripts/data-hosting/datasets.json`.
Its product directory and diagnostic catalog remain available in development
and are omitted from both local-data and hosted deployment bundles. No full
rebuild or upload is part of this workflow.

## Evidence and limits

See [the recorded measurements](../benchmarks/mars-cube-foundation.json).
The unchanged field agrees with 73 MMGIS scalar controls to 0.0182 m maximum;
these controls share source provenance and do not independently establish
absolute terrain accuracy. The bounded triangles differ from the finest field
by up to 2.92 m at those controls and 8.74 m at sampled blend-band points.
The radial conversion checks 390 emitted-grid values with less than 0.001 m
error. Neither the original fitted plane nor the taper was changed.

All tested mixed-level rendered edges have skirt coverage. CPU grids omit
skirts. Ray queries enumerate incident closed tile/face footprints and pass
rejected parent hits to the finer owner. Finer interiors supersede parents;
when finer triangles have no intersection, an actual shared outer-edge hit
from a resident ancestor can supply provisional boundary support. This is an
intersection of an existing lattice triangle, not an interpolated bridge or a
skirt. The returned tile ID identifies that support; it may differ from the
half-open point sampler's finest tile. Finest-owned hits take priority over
ancestor boundary support. Coordinate-scaled floating-point tolerances retain
real edge/vertex intersections at planetary coordinate magnitudes.

All 96 targeted boundary rays now hit, including the 10 formerly unavailable
rays. Exact replay asserts each hit against the emitted tile's surface-only
triangles and retains coarse/unknown accuracy. Missing resident coverage still
returns `unavailable`; finite marching/loading budgets and partial-product
metadata still prevent a certified nearest-hit or miss claim. Representation,
nearest-hit and source uncertainty remain explicit. Global roots intentionally have coarse
geometry; this bounded product is not a global Mars accuracy claim.

The legacy `fused.sh` metadata states that areoid numbers were placed as IAU
ellipsoid heights. `tile_job` also passes source map latitudes into a geodetic
ECEF converter. `build-ingenuity-flights.mjs` repeats the geodetic assumption.
That is not the convention declared by the USGS DTM label. This foundation
retains source-coordinate scalar registration, not the old erroneous
Cartesian interpretation. Mission trajectory/image placement must be audited
with their own coordinate provenance before #244 switches production catalogs.

## Production migration acceptance for #246

The #245 foundation does not accept the following behavior for production.
Before switching Ingenuity catalogs under #246/#244:

- Exercise point elevation, picking, fly-to-point, navigation/clearance, and
  measurements during cold loading and refinement as well as after settling.
  Decide explicitly whether rendered or CPU geometry governs placement and
  clearance, and verify transitions. Coarse rendered/finest CPU differences
  reach 291 m at sampled boundaries and 224 m in the overview capture. The
  recorded nominal 50 m camera clearance falls to 30.24 m above the rendered
  pair at sampled boundaries. Settled-scene agreement alone cannot accept
  these operations.
- Audit mission and image coordinate provenance independently, including
  planetocentric/planetographic latitude and areoid/ellipsoid heights.

The boundary regression for #245 is retained in
`scripts/terrain/fixtures/mars-cube-boundary-rays.json`. It requires the original
bounded product; offline CI additionally covers an extracted physical edge
triangle and synthetic parent-child, cube face/corner, pole and antimeridian
queries without a renderer or skirts.

```sh
node scripts/validate-cube-terrain.mjs \
  --dir apps/viewer/test-catalogs/data/mars-terrain-cube-jezero \
  --site 18.65,77.4 \
  --boundary-regression scripts/terrain/fixtures/mars-cube-boundary-rays.json \
  --out work/cube-terrain/mars-boundary-replay
```
