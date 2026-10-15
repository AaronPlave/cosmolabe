# Rosetta geometry and review validation

PR #117 is part of #107: it implements mission geometry and Phases 1–5, not
Phase 6 completion. Required package/observation/comparison/script work is
tracked in #229–#232, with generic capabilities owned by #28, #175 and #14/#153.
Surface-image projection remains #150. Generalized DSK LOD, lazy loading and a
full instrument suite are not merge prerequisites.

## Coordinate origins and the antenna mount

The archived bus DSKs `ROS_SC_BUS_LR_V02.BDS` and `ROS_SC_BUS_V01.BDS` both
identify centre **-226000**, frame **ROS_SPACECRAFT**. That is the bus structure
origin, not spacecraft centre of mass **-226**. The previous catalog placed
those vertices at -226 while the arrays/HGA were correctly located using
`ROS_STRUCT_V8.BSP` plus `ROS_COG_V4_RESAMPLED.BSP`. The resulting bus/component
misregistration was about **1.33 m**, visible at the antenna attachment.

The catalog now follows -226000 for the bus and declares that actual NAIF
origin. Child component offsets are relative to -226000. This uses the
SPICE-derived, time-dependent structure/CoM translation, including the cruise
and comet-phase arcs; there is no hand-adjusted mesh offset. Known DSK centre
or direct Spice-frame mismatches fail loading instead of drawing incompatible
coordinates. The ID-times-1000 equivalence was removed.

Measured structure-minus-CoM positions in ROS_SPACECRAFT axes, metres:

| UTC | X | Y | Z |
|---|---:|---:|---:|
| 2004-03-02 12:00:00 | 0.030355 | -0.002769 | -1.327272 |
| 2010-07-10 15:44:55 | 0.030355 | -0.002769 | -1.327272 |
| 2014-11-12 08:35:14 | -0.035974 | -0.002269 | -1.329681 |
| 2014-11-12 08:35:16 | -0.035977 | -0.002269 | -1.329681 |
| 2016-09-30 10:39:29 | -0.049688 | -0.002320 | -1.337629 |

The arrays identify centres -226010/-226020 in ROS_SA+Y/ROS_SA-Y; HGA identifies
-226070 in ROS_HGA; Philae identifies -226800 in ROS_LANDER. All match their
catalog trajectories. `scripts/verify-rosetta-geometry.mjs` checks the real
archive descriptors, catalog targets and component offsets at those epochs.

![Corrected bus and HGA attachment](img/rosetta/hga-mount.png)

## Textures and Philae's apparent surface gap

The selected spacecraft assets are native DSK plate meshes. This path supplies
positions/plates and computed normals, with catalog solid colours; it supplies
no UVs or texture images. Rosetta and Philae's untextured appearance is expected
for these assets, rather than failed texture downloads. A textured art model
would be a different asset choice and is not silently substituted.

At 2014-11-12 18:00 UTC, the archived Philae origin is
`[2.4473, -0.0627, -0.3486] km` in `67P/C-G_CK`. Its nearest point on the actual
`ROS_CG_K200_OSPGDLR_N_V1.BDS` mesh is **4.008156 m** away. This is an
origin-to-triangle distance, not an asserted foot clearance. It establishes
that the gap exists between the supplied ephemeris and selected surface
product; it is not caused by the bus-origin error. A coarse global mesh need
not resolve the local landing geometry. Preserve the official position;
no snapping, invented attitude, or synthetic surface patch is applied.

## Visibility and trails

Custom BodyVisualizer objects now inherit their BodyMesh's presence and user
visibility, and skip updates while absent. Tests cover leaving/re-entering
existence independently of user hiding. Main's refactored picking still skips
hidden/absent body meshes. Sensor clipping and imagery changes from main are
retained.

A body/model/label/sensor disappears outside its existence window. Trail
samples are bounded by that window, but completed history remains until its
configured duration has elapsed; it does not represent a still-present craft.
A regression checks both the historical range and eventual disappearance.

## Kernel accuracy and deployment

SPK verification now compares **velocity as well as position**, at deterministic
random epochs, coverage edges and both sides of discontinuities. Default
velocity tolerance is 1 mm/s. The full comet-phase SPK has 263 preserved breaks:
maximum position error **0.82 m**, velocity error **0.968835 mm/s**. The rebuilt
structure-origin SPK measures **0.06 m** and **0.001409 mm/s** respectively.

CK thinning now preserves source angular velocity as well as quaternion
accuracy. Attitude-only thinning failed the new rate check in the Philae
window (0.000218 rad/s); retaining rate-sensitive samples reduces that window's
worst error to about **0.000005 rad/s**, below the default **0.00001 rad/s**.
The full array run also exposed a shorter rate change missed by a regular
sampling grid (0.0000495 rad/s error). Type-3 reduction now includes the
source CK record epochs, with SPICE still resolving file precedence and frames.
The pulse regression deliberately puts a rate excursion between grid samples.
Verification compares recovered rates and state-transform derivative matrices,
including random epochs, sampled slews and covered-interval edges. The derivative
bound includes the allowed orientation error rotating a nonzero source rate.
Synthetic CLI regressions check rate preservation despite constant quaternion
samples and a short off-grid pulse, coverage gaps, and rejection of an SPK that passes position tolerance
but fails velocity tolerance.

Rosetta is registered as an unpublished dataset in the data-hosting manifest.
Archive copies retain ESA upstream URLs; derived files retain source URLs and
hashes of the generating scripts. With DATA_BASE_URL configured, Pages still
builds/bundles this unpublished set locally until a verified hosted build is
explicitly pinned. Nothing is published to the data host by this change.

## Reproduce

```sh
npm run build
bash scripts/fetch-rosetta-kernels.sh
node scripts/verify-rosetta-geometry.mjs
# Start a current-checkout viewer, then:
CL_VIEWER_URL=http://localhost:5173 node scripts/test-rosetta-viewer.mjs
```

The browser script captures all 17 named mission viewpoints (launch/cruise,
flybys, wake-up, 67P operations, Philae descent/final site, impact) and an HGA
close view. It checks 10 epochs including hibernation, separation ±1 second,
landing/bounce/final-site context and impact ±1 second. It requires all initial
assets to settle without failure and no browser errors, records visibility and
positions, and writes captures plus `report.json` to a temporary directory
(or ROSETTA_CAPTURE_DIR). These are visual/geometry checks, not observation-image
registration acceptance. At impact's exact endTime the body remains present;
it is absent at +1 second.

Mission milestones stay as viewpoints in this PR. The current event timeline
consumes computed geometry-analysis results, not catalog-authored mission
records. Adding a new mission-record ingestion model here would broaden scope;
observation timeline delivery remains explicitly required in #230/#28. No
viewpoint is relabelled as a fake observation or computed event.

CI at `ffb8c78` passed **1,962 tests**, including the fetched external
Cosmographia fixtures (no skips). The local full suite passed 1,919 with
7 skipped; subsequent focused regressions passed as recorded in the PR.

The complete rebuilt set passed: +Y / −Y arrays and HGA elevation / azimuth
all measure **0.250°** maximum attitude error and **<0.000005 rad/s** rate error.
Each was verified at 6.2–7.3 million source/sample/random/edge epochs. Full Rosetta
attitude additionally passes 20,000 independent random rate probes (maximum
**0.000005673 rad/s**); 67P rotation measures **0.000000121 rad/s**.

Preserving rates increases the shipped Rosetta set to **173,114,063 bytes**
(compressed where large; 42 files), plus the shared planetary ephemeris. This is
a deliberate precision/size tradeoff; it is no longer the original 56 MB set.
Catalog progress-byte hints and the browser listing reflect the rebuilt sizes.
The empty-output rebuild used cached official ESA source files; it was not a
new 700 MB network download. The subsequent full warm build finished with all
42 files present, no fetches and no reductions rerun.
