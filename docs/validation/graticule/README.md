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

The pattern is geographic, independent of camera position and search bounds:

- Each tier defines latitude/longitude block strides as four corresponding major
  grid steps, capped at 60°. Strides and phase are always anchored to geographic
  zero; the cap is a tier rule, never a viewport adjustment.
- Each block has a latitude annotation at its zero-phase corner and a longitude
  annotation at its half-block latitude/longitude site. Axes have consistent
  small glyph offsets and do not share a site within a tier.
- Values intentionally repeat at those regular sites. There is no per-line winner,
  same-line replacement search, axis quota or requirement to fill the sprite pool.
  A view can show one axis or no useful annotations. Point Probe supplies precise
  coordinates when passive orientation labels are absent.
- Longitude labels above ±70° and all sites above ±85° are suppressed. Text stays
  12 CSS pixels with DPR-aware rasterization.

The camera only bounds the enumeration of nearby prescribed blocks. A contiguous
subset of their canonical integer indices bounds work at 12 × 8 sites per axis,
then at most 96 candidates. Enlarging/shrinking the search bounds never changes
geographic stride or phase. Nearby resident-height sampling supports cameras below
the reference datum, using at most six entry-refinement iterations and no far-side
exit. Longitude is canonicalized before constructing identities.

Existing visible sites receive priority for bounded queries and collisions;
visibility does not redefine pattern locations. A 100 ms entry dwell, separate
entry/exit limb, strength and viewport thresholds, and larger entry collision
clearance suppress residual-motion flicker. UI/text collisions, occlusion and
foreshortening hide the affected site. Another independently prescribed site may
naturally enter the view; no replacement is generated to preserve a coordinate
value's coverage. Sparse and empty regions are accepted.

Tier changes introduce/retire predetermined patterns over the grid's 180 ms
crossfade. Shared sites preserve their original anchor IDs when both their site
and coordinate line belong to the new pattern. Other old sites retire after the
crossfade even if their coordinate line survives. Full pattern membership and
actual line membership handle non-nested nice steps explicitly. Equivalent
annotations at the same geographic site are deduplicated across tiers; repeats
at different prescribed sites remain independent.

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
stays subdued. Labels share the shader's illumination, horizon and congestion
thresholds. Their opacity follows line crossfade weight, squared lighting strength
(the grid modulates both color and blend strength), limb attenuation and local
coordinate congestion. The inverse screen Jacobian approximates the shader's
coordinate `fwidth`, including rolled/skewed views. Entry/exit strength thresholds
avoid drawing bright text over an effectively suppressed line.

CPU annotation lighting approximates normalized diffuse irradiance from the
surface scene's ambient/directional lights, independent of imagery albedo. Local
overlays use their own scene lighting when the current geometry hit is an overlay;
a bright overlay scene does not brighten labels on uncovered night terrain.
This approximation does not sample GPU shadow/normal maps or read back pixels;
real shadowed/mixed-LOD terrain acceptance remains pending.

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

[Continuous attachment recording](regular-pattern/orbit-zoom-pan-tangent.mp4)
contains a rolled orbit, whole-globe/regional zoom, sustained pan, near-ground
zoom, nearly stationary residual damping and tangent view. [Frame diagnostics](regular-pattern/frames.json)
retain anchor IDs, geographic coordinates, opacity, projected positions and label
rectangles. [Motion metrics](regular-pattern/metrics.json) check that repeated IDs
never change latitude/longitude, settled sites obey the prescribed stride/phase,
equivalent sites are not duplicated, held-camera visibility does not toggle, labels
avoid controls, and query/candidate/pool limits hold. The displayed lunar craters
provide nearby surface features for checking attachment visually.

[Layout fixtures](regular-pattern/layout/metrics.json) cover polar/seam orientation,
six real-imagery zoom stages, regional Mars, small-globe/night-side and regular-repeat cases, a resident depression, actual free-look input and the same final
pose reached through different paths. Eligible fixed candidates at the same
tier/pose are deterministic; visible subsets may reflect short-lived hysteresis.

Code regressions cover viewport-independent stride/phase, intentional regular
repeats, sparse/one-axis/empty views, collisions without replacement selection,
shared-site preservation and retirement when an old line outlives its pattern
site. Existing regressions retain geographic attachment, day/night and overlay
lighting, non-nested tiers, residual-motion stability, canonical seams/poles,
bounded tiny-step enumeration, current-frame ridge/terrain disappearance
occlusion, the eight-query budget and upstream material fade/eviction.

Earlier motion/layout reports are historical evidence. Camera-band/edge placement
and per-line deduplication/axis-quota selection are superseded by the repeating
geographic pattern. The latest code validation passes all 141 suites / 1,572 tests,
full typechecking, lint and purity checks. Browser results are recorded in the
linked reports; sparse visibility is permitted and is not a failed coverage quota.
Sixteen browser fixtures pass, including the six-stage real-imagery zoom sequence, regular regional repeats, night-side, polar, below-datum, free-look and same-pose paths. The 601-frame recording passes with 1,254 repeated anchor observations and zero geographic changes, off-pattern settled sites, duplicate sites, control overlaps, browser/shader errors or grid-triggered requests. The 67 settled damping frames have zero visibility toggles (visible label counts: [2]). The fixed 30 Hz clock is offline validation, not a real-time performance claim.

## Remaining live acceptance

The imagery in the new recording is real, but the relief is synthetic. Generated
streamed terrain products (`moon-terrain-fused`, `mars-terrain-fused`, etc.) are
absent here. Live Shackleton/natural/flood-light terrain, mixed-LOD transitions,
real ground/tangent views and event/measurement collision captures remain pending.
The PR stays draft for those checks. Synthetic relief does not substitute for
streamed terrain acceptance. General mesh-body reference grids and DSK draping
remain unavailable.
