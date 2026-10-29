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

Curiosity's trajectory definition, attitude inputs and geometry remain unchanged.
The single mission demo now loads the existing orbital-localized position SPK
last; the original telemetry load order remains a reproducible audit case.
The complete read-only [pose-chain audit](pose-chain.json) resolves SPK segments
from their DAF descriptors and evaluates two source solutions at the **same five
epochs**, including the PLACES anchor's exact SCLK. This identifies a source
selection difference, rather than accepting the screenshot as unexplained error.

In the original telemetry audit case, the last overlapping position SPK is
`msl_surf_rover_tlm_0449_0583_v1.bsp`. It resolves NAIF **−76** through site 25
or 26 (`−76525`/`−76526`), then landing site `−76900`, to Mars center **499**.
The rover/site segments use `MSL_LOCAL_LEVEL` (frame `−76910`); the landing
position uses `IAU_MARS` (10014). The local frame is north/east/down relative
to the fixed landing tangent frame. `msl_tp_ops120808_iau2000_v1.tf` declares
the landing orientation at Gaussian latitude −4.643851°, longitude 137.441700°,
referencing the IAU2000/PCK00008 solution. The catalog uses PCK00011 for
inertial Mars orientation. Both alternatives are evaluated in the **same
IAU_MARS frame**, with `abcorr=NONE`; this comparison does not mix inertial
states or confuse Gaussian/planetodetic latitude with planetocentric latitude.
Changing the inertial Mars pole model is not an explanation for their different
body-fixed radial coordinates.

The already supplied `msl_surf_rover_loc_0000_2003_v1.bsp` was overridden by that
telemetry file in the original catalog. Its embedded NAIF pedigree explicitly identifies the PLACES
`localized_interp` data view, produced July 2018. Loading that **unchanged** SPK
last instead resolves −76 directly relative to 499 in IAU_MARS. This is a
defensible orbital-localized **position product**, not a newly
fitted position or an independent geolocation control. The downloaded PLACES
anchor is site 26/drive 184, sol 528, SCLK **444369371**, corresponding to
**2014-01-30T16:05:36.470 UTC** with the supplied clock kernel. Its exact original
localization revision is still unknown. Nearby UTC samples must not be labeled
as identical site/drive states merely because their mesh-origin distance is similar.

For each source, convert its own Cartesian position to planetocentric longitude
and latitude. Sample MEG016 areoid radius and the original Gale DEM at **that
same horizontal location**, then subtract their sum from the rover-origin
radius. The signed radial residuals are:

| UTC | Telemetry origin − DEM (m) | Localized origin − DEM (m) |
| --- | ---: | ---: |
| 2014-01-29 12:00 | +17.911 | −0.185 |
| 2014-01-30 16:05:36.470 (anchor) | +16.506 | −0.208 |
| 2014-02-01 12:00 | +16.506 | −0.208 |
| 2014-02-05 12:00 | +16.525 | −0.151 |
| 2014-02-08 12:00 | +15.859 | −0.342 |

These are **origin-to-ground radial residuals, not measured wheel clearance**.
The DEM/MEG016 comparison uses planetocentric rays; ellipsoid-normal altitude is
a separate convention in physical cube query metadata. It does not substitute
planetodetic latitude or add a second areoid/ellipsoid correction. The earlier
113–127 m mesh-origin distances combine horizontal motion and source differences;
they are not same-epoch geolocation error estimates.

Attitude remains the identical `MSL_ROVER` CK → local-level → IAU_MARS chain:
all five attitude matrices are unchanged when only the position SPK priority
changes. The FK defines the NAV origin midway between the middle-wheel rotation
axes, +X forward and +Z down. The art model keeps its existing 3 m overall-size
normalization, authored root, and `[0.7071,-0.7071,0,0]` mesh rotation, without
`meshOffset`. Its wheel-to-NAV-origin registration has not been independently
established, so even the localized visualization cannot measure wheel clearance.
The rendered localized states/attitudes are checked against independent NAIF
exports; the complete viewer frame chain introduces no fitted offsets.

The single **Curiosity at Mars** demo explicitly loads the unchanged localized
SPK last and retains the same telemetry attitude, art model, viewpoints, mesh
and terrain. The telemetry SPK remains an input, and the audit explicitly
replays its original priority before evaluating the localized default at all
five epochs. The persistent compact caption identifies the localized solution
and its limits. Absolute accuracy and model-origin uncertainty remain unknown;
this is not calibrated rover-on-ground alignment. No snapping or mesh/DEM refit
is applied. There is no second shipped source-comparison catalog.

The catalog declares `physicalQueryPolicy: visual-only` and
`overlapPolicy: composite`. On the near hemisphere, loaded reconstruction
pixels composite over the globe, avoiding coincident globe/local depth
fighting. Selected local triangles also occlude models in the existing model
depth pass. Holes, absent tiles, failures and outside-footprint views reveal
the continuously available cube. The near-hemisphere gate prevents painting
through Mars. In the site pass, selected planetary surfaces strictly closer
than the nearest site bounding envelope are redrawn in matching logarithmic
CRR depth, so foreground relief occludes distant site pixels. Within that
envelope, compositing remains an explicit visual policy, not a physical
ordering claim or trusted ground mask. Priority orders coincident site groups; ordinary selected-tile
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
