# Dingo Gap fixed registration and authority

Dingo Gap remains an **approximate visual reconstruction**. Its transform is
fixed and reproducible; its absolute Mars registration accuracy is unknown.
The quantitative checks below establish internal consistency and bounded
agreement with a particular DEM, not independent absolute ground truth.

## Original source and axes

The [NASA-AMMOS sample](https://github.com/NASA-AMMOS/3DTilesSampleData/tree/76444abbb4faff1b05f46a09b81ca2c24602b333/msl-dingo-gap)
is pinned to `76444abbb4faff1b05f46a09b81ca2c24602b333`.
Its Landform reconstruction combines rover cameras with orbital context. The
retained scene declares `sitedrive_0260184`; camera translations and
[Landform's rover coordinate conventions](https://github.com/NASA-AMMOS/Landform)
identify local **north/east/down, metres**. `gltfUpAxis: z` describes the tile
payload convention and does not establish planetary north or up.
The 5,149-node tileset has an identity root transform and no other tile
transforms. The audited root GLB has one untransformed mesh node. The root box
is centered at `[-0.378760,-0.244412,2.448431]` m with half axes
`[130.507503,129.619002,8.237398]` m. Original scene, tileset and root geometry
are retained in [evidence](evidence/); original-byte hashes are in the
[source report](source-registration.json).

## One estimated transform

Version `places-26-184-meg016-estimate-v1` maps local metres to `IAU_MARS`
kilometres. Its anchor is the MSL PLACES orbital-localized site 26, drive 184:
planetocentric latitude **−4.626550593°**, east longitude **137.407262581°**,
areoid elevation **−4486.740 m**. PLACES records are available through the
[MSL localization archive](https://planetarydata.jpl.nasa.gov/img/data/msl/msl_places/).
The exact used rows and hashes of the full acquired CSVs are retained in
[places-control-snapshot.json](evidence/places-control-snapshot.json).

For latitude φ, longitude λ and radius R, form
`U=(cosφ cosλ, cosφ sinλ, sinφ)`,
`N=(−sinφ cosλ,−sinφ sinλ,cosφ)`,
`E=(−sinλ,cosλ,0)`, and `D=−U`.
R is the sampled MEG016 areoid radius **3395633.417068942 m** plus the
unchanged PLACES elevation, giving **3391146.6770689418 m**. Thus
`bodyKm = (R*U + N*n + E*e + D*d)/1000`.
The complete column-major affine matrix is in the report and catalog. The
viewer applies its existing Z-up to Y-up conversion once, then body rotation.
The source's original absolute PLACES solution/version was not retained;
the radial tangent basis also approximates local gravity. Both position and
orientation uncertainty remain unknown. No scale, rotation, or altitude was
fitted to improve globe appearance. The legacy −4.5 km offset, terrain-following
shift and 5 m inset are removed.

Thirteen held-out site/drive camera translations agree with PLACES relative
translations to a maximum **0.526755 m**. These share operational provenance:
there are **zero independently identified absolute landmarks**. The origin is
an anchor and is excluded from held-out statistics. This is not a sub-metre
absolute accuracy claim.

## Actual Gale terrain evidence

The [USGS Gale merged DEM v3](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif)
contains valid original samples at this site. The retained 400×400 native
window has no invalid mask pixels; [dem-window.json](dem-window.json) records
the original dimensions, affine, exact window, ETag and Last-Modified value.
Its RasterPixelIsPoint tag is preserved. GDAL already supplies the correct
sample-center affine; no extra half-pixel adjustment or source resampling is
introduced by the executor.

The **1 m grid interval does not establish native HiRISE stereo fidelity** at
Dingo Gap. The mixed mosaic has no recovered per-pixel source index. The
separate Gale HiRISE DTM in #249 at 138.43–138.57°E does not cover Dingo Gap.
Imagery footprints are not evidence of physical terrain detail.

Seven root-mesh/DEM comparisons (origin, two offsets and four rover-epoch
horizontal locations) have maximum absolute radial disagreement **0.789 m**.
These use the coarse root mesh (`geometricError=4.192 m`); fine-LOD geometry
and independently controlled absolute accuracy remain unvalidated. The global
HRSC/MOLA base alone differs by roughly **7–12 m** at these sites, motivating
the finite Gale residual. Original DEM elevations are preserved with a 50 m
boundary taper and `--bias none`. The shared executor explicitly converts
planetocentric areoid elevation to body-fixed radial coordinates using MEG016,
then publishes ellipsoid/geodetic-normal query metadata. No unexplained
8.765 km correction is reused.

## SPICE discrepancy and physical ownership

Curiosity's trajectory, kernels and attitude inputs are unchanged. Four epochs
are exported in [spice-states.json](spice-states.json). Operational SPICE states
and PLACES/orbital localization disagree: near these dates the rendered rover
is about 100 m horizontally displaced and 16–18 m above local ground. This is
visible source disagreement, not calibrated rover clearance. Never snap the
rover or refit the mesh/DEM to hide it.

The catalog declares `physicalQueryPolicy: visual-only` and
`overlapPolicy: composite`. On the near hemisphere, loaded reconstruction
pixels composite over the globe, avoiding coincident globe/local depth
fighting. Selected local triangles also occlude models in the existing model
depth pass. Holes, absent tiles, failures and outside-footprint views reveal
the continuously available cube. The near-hemisphere gate prevents painting
through Mars. Priority orders coincident site groups; ordinary selected-tile
depth applies within the mesh pass. The source-local coverage box is a display
envelope, **not** a trusted physical-coverage mask.

The cube alone owns picking, measurement and surface navigation. Camera
clearance uses both its physical surface and currently drawn terrain. Local
rocks/overhangs are visual context and cannot establish query truth. Multiple
meshes each have an independent fixed transform, source pin, bounds, provenance,
uncertainty, priority and streaming/cache settings. A four-metre synthetic ENU
square proves the interface with different axes alongside the NED sample;
it is a test fixture, not another mission or control observation.

See [README](README.md) for validation, reproduction and rollback.
