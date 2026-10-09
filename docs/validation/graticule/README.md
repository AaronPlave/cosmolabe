# Issue 157: adaptive surface grid and geographic annotations

## Current one-band review pass

The latest [PR feedback](https://github.com/AaronPlave/cosmolabe/pull/163#issuecomment-6048743556)
asks for one fixed latitude ruler and one fixed longitude ruler, large labelled
cells, and at most one quiet subdivision level. The current implementation
selects one predetermined geographic carrier per axis, decouples caption
spacing from line spacing, and caps visible captions at 24. The selection
target is 180 CSS pixels between active lines, with discrete-step hysteresis.

The [final browser layout metrics](one-band/metrics.json) pass with one grid
instance per fixture, matching visible sprite and diagnostic counts, no duplicate
sites, and no browser errors or grid requests. Inspect the [small night-side
globe](one-band/small-globe-night-side.png), [regional rulers](one-band/regional-coordinate-lattice.png),
and [wide close view](one-band/wide-fine-line-labels.png). The
[601-frame motion metrics](one-band/motion-metrics.json) and
[fixed-altitude optical zoom metrics](one-band/optical-metrics.json) also pass.
These fixtures use the real BodyMesh/render path but do not reproduce the full
viewer UI or live streamed terrain; those remain visual acceptance work.

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

- At globe scale, consecutive 30° latitude values follow the fixed 5°E meridian;
  consecutive longitude values follow the fixed 3°N parallel. These reproduce the
  old grid's two geographic rulers, with canonical E/W formatting and distinct
  zero latitude and zero longitude values.
- At finer tiers, predetermined meridian and parallel carriers repeat over the
  body, but only one complete band per axis is displayed. The selected bands
  stay fixed until the camera footpoint moves far enough to choose another
  carrier. The old bands retire as a whole; individual captions never slide or
  trigger same-line replacements. One-axis and empty views are valid.
- Caption values use a separate stride from grid lines. Fine major lines can
  therefore appear without a caption on every line. Point Probe supplies exact
  coordinates.
- Sites above ±85° are suppressed. Text is 14 CSS pixels with DPR-aware
  rasterization.

Camera-dependent discovery only enumerates nearby pieces of these prescribed
carriers. Contiguous canonical integer indices bound work at 24 sites per
axis, then at most 96 candidates. Search bounds never change stride or phase.
Nearby resident-height sampling supports cameras below the reference datum,
using at most six entry-refinement iterations and no far-side exit. Longitude is
canonicalized before constructing identities.

Existing visible sites receive priority for bounded queries and collisions;
visibility does not redefine pattern locations. A 100 ms entry dwell, separate
entry/exit limb, strength and viewport thresholds, and larger entry collision
clearance suppress residual-motion flicker. UI/text collisions, occlusion and
foreshortening hide the affected site. Another independently prescribed site may
naturally enter the view; no replacement is generated to preserve a coordinate
value's coverage. Sparse and empty regions are accepted.

Tier changes introduce and retire predetermined patterns over the grid's 180 ms
crossfade. An outgoing band does not remain visible alongside the incoming
band. Pattern membership handles non-nested nice steps explicitly.

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
leaving two queries to discover another candidate. Reference views can use the
analytic surface intersection and test foreign occluders whose bounds intersect
the anchor ray. The hard budget for terrain registration remains eight triangle
queries per body per frame, including discovery. Actual occlusion, unavailable
current results and UI overlap hide immediately; fades and visibility hysteresis
never override them. New terrain data/disposal invalidates the cache. GPU-only vertex displacement
is not represented by Three's triangle picker; those fallback globes keep the
surface shader but suppress labels instead of certifying undisplaced triangles
as visible terrain.

## Grid rendering and state

Auto chooses one major step from a nested set and renders at most one quieter
minor subdivision. Equator and prime remain distinct reference lines. Manual
spacing keeps the existing nice-step choices, including non-nested ones.

At globe scale Auto keeps the old 30° rulers. Globe/regional hysteresis uses the
projected reference silhouette diameter relative to the viewport's shorter side:
exit globe mode above 2.3 viewport diameters, re-enter at or below 1.95. Projection
matrix magnification includes field of view and lens zoom; altitude is not a veto.
Inside the reference bounding sphere the view is regional. Optical zoom can
introduce finer tiers and fixed carriers.
Within regional views, independent local latitude/longitude projection derivatives
are sampled every 150 ms. The selection target is 180 CSS pixels, with hysteresis.
The outgoing and incoming configurations crossfade over 180 ms, starting with
the previous grid on the transition frame.

Reference equator/prime lines use distinct restrained colors. Active major lines
are stronger than the one optional minor subdivision. Coincident line weights
combine by maximum rather than accumulating.

Fragment derivatives antialias each axis and measure its own local projected
spacing, including longitude seams and polar suppression. Minor detail fades
before it becomes compressed near the horizon. Horizon attenuation spans
incidence 0.12–0.45. This operates locally per
fragment alongside the view's adaptive spacing, rather than drawing a uniformly
dense lattice into the distance.

The grid remains visible across the day/night boundary. Labels share its
horizon and major-line congestion thresholds, with an inverse screen Jacobian
approximating coordinate `fwidth` in rolled/skewed views. Their opacity follows
line crossfade weight, limb attenuation and local congestion, capped at 72%.
Entry/exit strength thresholds suppress captions where their coordinate lines
cannot be interpreted. Real shadowed/mixed-LOD terrain acceptance remains pending.

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
node scripts/graticule-optical-validation.mjs
node scripts/graticule-carrier-validation.mjs
node scripts/graticule-layout-validation.mjs
node scripts/graticule-motion-validation.mjs
```

`CHROMIUM_PATH`, `GRID_VIEWER_URL` and `GRID_CAPTURE_DIR` override defaults.
Harnesses remove their temporary page/module. The motion harness uses repository
lunar imagery plus synthetic resident relief, with a fixed 30 Hz application
clock and every rendered frame encoded. It validates attachment between discovery
plans despite slower software rendering; it is not a real-time performance claim.

The following captures document the earlier `098434b` presentation and are kept
as historical comparisons. For this revision's results, use the one-band links
at the top of this document.

[Fixed-altitude optical zoom](optical-zoom/metrics.json) reproduces the review:
a radius-100 reference sphere, camera at `[300, 0, 0]`, target `[100, 0, 0]`,
and an 800 × 800 viewport. [60° FOV](optical-zoom/wide-60.png),
[10° FOV](optical-zoom/region-10.png), [1° FOV](optical-zoom/close-1.png),
then [10°](optical-zoom/return-10.png) and [60°](optical-zoom/restored-60.png)
use the same body and camera position throughout. The narrowest view refines
both axes below one degree; widening restores the same nonempty eligible ruler
sites. Visible subsets may reflect the existing collision entry/exit hysteresis.
The regression also checks finer detail uniforms and FOV boundary hysteresis.
All five optical captures pass with zero browser/shader errors or grid-triggered
requests. Both axes use 30° → 5° → 0.2° → 5° → 30° as FOV narrows and widens.

The following carrier, layout and motion captures were recorded at `098434b`;
the optical sequence above is the additional validation for this FOV fix.

[Matching-camera comparisons](carrier-rulers/comparison/metrics.json) include the
old/new globe, old/new regional Mars, rolled regional and synthetic-resident-relief
ground/tangent views. Compare [old globe](carrier-rulers/comparison/old-globe.png)
with [new globe](carrier-rulers/comparison/new-globe.png), and
[old regional](carrier-rulers/comparison/old-regional.png) with
[new regional](carrier-rulers/comparison/new-regional.png).
The [rolled region](carrier-rulers/comparison/new-oblique.png) follows the same
fixed carriers. Caption-free [tangent grid](carrier-rulers/comparison/tangent-grid.png)
and [surface-only](carrier-rulers/comparison/tangent-surface.png) captures permit
inspection of the horizon without text. Their [coverage diagnostic](carrier-rulers/comparison/tangent-coverage.json)
measures actual surface pixels in distant/foreground bands, excluding sky;
it is diagnostic evidence, not a visual acceptance quota.

[Continuous attachment recording](carrier-rulers/orbit-zoom-pan-tangent.mp4)
contains a rolled orbit, continuous whole-globe/regional/near-ground zoom at a
fixed geographic target, sustained pan, nearly stationary residual damping and a gradual
tilt/roll into a physically oriented tangent view.
[Frame diagnostics](carrier-rulers/frames.json) retain anchor IDs, coordinates,
opacity, projected positions and label rectangles. [Motion metrics](carrier-rulers/metrics.json)
check immutable coordinates, settled carrier stride/phase, duplicate sites,
held-camera visibility, UI overlap and query/candidate/pool limits. Fixture
UI checks reserve the control footprints rather than rendering live viewer panels.
Lunar craters
provide surface features for visually checking attachment. Bright/dark imagery
and day/night captures accompany the recording.

[Layout fixtures](carrier-rulers/layout/metrics.json) cover polar/seam orientation,
six real-imagery zoom stages, regional Mars, small-globe/night-side, a resident
depression, actual free-look input and the same final pose reached through
multiple paths. Same-pose comparison requires a nonempty set of eligible anchors
at the tested manual tier; visible subsets may reflect short-lived hysteresis.

Code regressions cover consecutive ruler values, viewport-independent carriers,
sparse/one-axis/empty views, collisions without replacements, shared-site retention,
obsolete-carrier retirement even when a line survives, nested Auto versus manual
nice steps, globe transition hysteresis, zoom-out restoration, geographic attachment,
lighting, residual-motion stability, seams/poles, bounded enumeration, current-frame
ridge/terrain occlusion, eight-query limits and upstream fade/eviction.

Earlier reports are historical evidence. The block-corner/half-block arrangement
in `regular-pattern/` is superseded by these ordered carriers. At `098434b`, code
validation passed all 141 suites / 1,575 tests, full typechecking, lint and purity
checks. All six matching-camera comparison captures
pass without browser/shader errors. The globe/regional captures show seven/ten
captions respectively. With captions disabled, the actual distant surface band
has no grid contribution above the diagnostic pixel threshold; 3.75% of foreground
pixels change. This is a local-suppression diagnostic, not a coverage quota.
All sixteen layout fixtures pass, including nonempty same-pose eligible-anchor
comparison, the six-stage real-imagery zoom, polar views, resident depression
(72 candidates, 0.02° per axis), and actual free-look input.

The 601-frame recording passes with 1,377 repeated anchor observations,
zero coordinate changes, off-pattern settled sites, duplicate sites, reserved-control
overlaps, browser/shader errors or grid-triggered requests. The 67 settled damping
frames retain three captions with zero visibility toggles. The fixed 30 Hz clock
is offline validation, not a real-time performance claim.

## Remaining live acceptance

The imagery in the new recording is real, but the relief is synthetic. Generated
streamed terrain products (`moon-terrain-fused`, `mars-terrain-fused`, etc.) are
absent here. Live Shackleton/natural/flood-light terrain, mixed-LOD transitions,
real ground/tangent views and event/measurement collision captures remain pending.
The PR stays draft for those checks. Synthetic relief does not substitute for
streamed terrain acceptance. General mesh-body reference grids and DSK draping
remain unavailable.
