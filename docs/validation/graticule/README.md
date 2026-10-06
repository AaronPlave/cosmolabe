# Issue 157: adaptive surface grid and geographic annotations

The production grid is a procedural overlay in surface materials. Shared core
body-fixed conversions keep it consistent with Point Probe, resident terrain
sampling and surface navigation. Spheres/rotational ellipsoids use geodetic
latitude; triaxial references use planetocentric latitude. Longitude is east-positive
and canonical in [−180°, 180°). The rotation model's declared frame is used when
available, otherwise `BODY_FIXED:<name>`. Model mesh pre-rotation does not change
these coordinates. Placeholder bodies, stars, spacecraft, barycenters, exaggerated
minimum-pixel bodies and general mesh bodies have no grid.

## Fixed geographic attachment

Each annotation has an immutable identity containing body, latitude/longitude
tier, axis/value and anchor latitude/longitude. Orbit, pan, roll and zoom never
rewrite those coordinates. Reprojection/body rotation move the anchor on screen;
only the glyph billboards towards the camera. Terrain registration can update its
height to the rendered surface without moving its latitude/longitude.

The pattern is geographic, independent of camera position:

- Latitude annotations use their fixed latitude lines and longitude bands spaced
  at four longitude steps, capped at 60°.
- Longitude annotations use their fixed meridians and latitude bands spaced at
  four latitude steps, capped at 60°, with a half-latitude-step offset. The two
  axes therefore do not share an anchor.
- Longitude labels above ±70° and all anchors above ±85° are suppressed. Text
  has a consistent small offset per axis and stays 12 CSS pixels, with DPR-aware
  rasterization. `Equator 0°` and `Prime 0°` remain distinguishable.

The camera only defines a search region for eligible fixed anchors. A nearby
resident-height sampling lattice supports cameras below the reference datum;
nearby entry refinement is bounded at six iterations and never chooses a far-side
exit. Enumeration is bounded at 12 × 8 anchors per axis before keeping at most
96 candidates. Tiny manual steps cannot allocate a planet-wide intersection grid.
Longitude/latitude values are canonicalized before constructing identities, so
searching across the seam produces the same anchor coordinates.

Suitable visible annotations remain in the candidate subset and win collisions.
A 100 ms entry dwell, separate entry/exit limb and viewport thresholds, and larger
entry collision clearance suppress flicker from small residual camera motion.
Annotations fade at their original locations. Collisions with body/event labels,
rail, timeline, panels, HUD and probe reservations hide annotations; they never
slide them onto another location. Sparse or empty regions are acceptable.

Tier changes introduce different fixed IDs. Matching coarse anchors can remain
through refinement; finer anchors retire when coarsening. Because nice steps are
not all nested, line membership is checked against both actual shader levels and
their crossfade weights. An unsupported coordinate label cannot remain visible
once its old line has faded. Labels can be much sparser than grid lines.

## Registration and visibility budgets

There are at most 24 allocated label sprites. Reference-globe visibility uses
current analytic intersections and surface normals. When geometry participates
in occlusion, every displayed annotation needs a current-frame geometry result;
a cached positive never permits drawing through terrain.

For terrain/overlays, one ray along the fixed coordinate's surface normal/radial
line registers the anchor on actual rendered geometry. A second ray from the
camera checks current occlusion against bodies, terrain and overlays. The same
local-overlay precedence as Point Probe is retained. Both latitude and longitude
must match the anchor. This rejects foreground ridges that happen to be on the
same latitude line. The height is reconstructed at the original coordinate,
independently of camera position.

Terrain views show at most three labels: six geometry queries validate them,
leaving two queries to discover another candidate. Reference views with other
occluders show at most six labels. The hard budget remains eight triangle queries
per body per frame, including discovery. Actual occlusion, unavailable current
results and UI overlap hide immediately; fades and visibility hysteresis never
override them. New terrain data/disposal invalidates the cache. GPU-only vertex displacement
is not represented by Three's triangle picker; those fallback globes keep the
surface shader but suppress labels instead of certifying undisplaced triangles
as visible terrain.

## Grid rendering and state

Density uses local latitude/longitude projection derivatives sampled every
150 ms, rather than whole-body diameter. Independent nice steps range from 30°
to 0.001°, with a 60–180 pixel hysteresis band around a 100 pixel target. Levels
crossfade over 180 ms, starting with the previous grid on the transition frame.
Fragment derivatives handle antialiasing, longitude seams and congestion. Major,
minor and equator/prime strengths are 22%, 7% and 35% before lighting/density/horizon
modulation. Widths are in CSS pixels and colors are restrained. Lighting is
normalized by albedo so dark daytime imagery remains useful while the night grid
stays subdued.

The shader follows rendered fragments without extra grid geometry or data
requests. Existing imagery, shadow and atmosphere hooks compose with it. Tile
materials retain identity for upstream fade tracking and eviction; shared
materials use per-object model-view matrices and a camera-to-body uniform.
Local overlays preserve physical coordinates in the camera-relative pass.

Scope, pinned bodies, per-body visibility/labels, Auto/manual density and minor
lines persist through preferences, scripts, snapshots and camera JSON. `G` is the
master switch. Default tracked-body scope retains the origin body's grid during
free-look and follows the next focus. Exact coordinates remain available through
the existing explicitly activated Point Probe. Hover probing is a separate
follow-up, not part of this change.

## Reproduce and inspect

Start the viewer Vite server:

```sh
npm --prefix apps/viewer run dev -- --host 0.0.0.0
```

With Chromium and FFmpeg installed, run these harnesses sequentially (they share
a temporary fixture page and baseline module):

```sh
node scripts/graticule-motion-validation.mjs
node scripts/graticule-layout-validation.mjs
```

`CHROMIUM_PATH`, `GRID_VIEWER_URL` and `GRID_CAPTURE_DIR` override defaults.
Harnesses remove their temporary page/module. The motion harness uses repository
lunar imagery plus synthetic resident relief, with a fixed 30 Hz application
clock and every rendered frame encoded. It validates attachment between discovery
plans despite slower software rendering; it is not a real-time performance claim.

[Continuous attachment recording](fixed-anchors/orbit-zoom-pan-tangent.mp4)
contains a rolled orbit, whole-globe/regional zoom, sustained pan, near-ground
zoom, nearly stationary residual damping and tangent view. [Frame diagnostics](fixed-anchors/frames.json)
retain anchor IDs, geographic coordinates, opacity, projected positions and label
rectangles. [Motion metrics](fixed-anchors/metrics.json) check that repeated IDs
never change latitude/longitude, held-camera visibility does not toggle, labels
avoid controls, and query/candidate/pool limits hold. The displayed lunar craters
provide nearby surface features for checking attachment visually.

[Layout fixtures](fixed-anchors/layout/metrics.json) cover polar/seam orientation,
regional Mars, a resident depression, actual free-look input and the same final
pose reached through different paths. Eligible fixed candidates at the same
tier/pose are deterministic; visible subsets may reflect short-lived hysteresis.

Code regressions cover persistent IDs/coordinates across navigation, nested and
non-nested tier changes, residual-motion stability, UI collisions without
relocation, seam canonicalization, bounded tiny-step enumeration, current-frame
ridge/terrain disappearance occlusion, the eight-query budget and upstream
material fade/eviction. Earlier before/after images, draped-line comparisons and
motion/layout reports remain archived in this directory; their former camera-band
and edge-placement model is superseded by the fixed geographic pattern.

The latest validation passes all 141 suites / 1,568 tests, full typechecking,
lint and purity checks. The 601-frame, 20-second recording contains 1,540
repeated anchor observations with zero latitude/longitude changes. Its 67 settled
residual-damping frames have zero visibility toggles. Browser/shader errors,
control overlaps and grid-triggered requests are zero. The below-datum fixture
produces 62 candidates, three visible terrain labels and 0.02° spacing on both
axes; actual free-look retains the origin body's grid.

## Remaining live acceptance

The imagery in the new recording is real, but the relief is synthetic. Generated
streamed terrain products (`moon-terrain-fused`, `mars-terrain-fused`, etc.) are
absent here. Live Shackleton/natural/flood-light terrain, mixed-LOD transitions,
real ground/tangent views and event/measurement collision captures remain pending.
The PR stays draft for those checks. Synthetic relief does not substitute for
streamed terrain acceptance. General mesh-body reference grids and DSK draping
remain unavailable.
