# Lunar surface frames and absolute trajectories (#238)

The audited LOLA/LROC cube products represent **DE421 mean Earth/polar axis
coordinates**, not the truncated IAU text-PCK orientation. Use the exact SPICE
frame `MOON_ME_DE421`, implemented by `moon_080317.tf` plus
`moon_pa_de421_1900_2050.bpc`. `MOON_ME` is an alias defined by the furnished FK;
it is not an immutable realization identifier. DE440's ME421-aligned frame is
also a different named realization. No equivalence is inferred from `MOON_ME`.

## Source audit

| Input | Definition and limit |
| --- | --- |
| `Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif` | USGS distribution of the LOLA global DEM; signed half-metre elevations above a 1737.4 km reference sphere. The LOLA GDR specification names `MEAN EARTH/POLAR AXIS OF DE421`, planetocentric latitude, east longitude. |
| `ldem_87s_10mpp.tif` | 10 m overview of PGDA's `ldem_87s_5mpp_cog.tif`, improving south-pole LOLA topography. The pipeline reprojects and blends the supplied map coordinates; it does not transform lunar orientation. |
| `Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif` and controlled south-pole NAC mosaic | LRO map-product coordinates follow the DE421 MER system. Source registration uncertainty remains distinct from frame-transform error. The pipeline samples the projected maps directly onto geocentric cube directions. |

Authoritative definitions and source context:

- [LOLA RDR/GDR SIS](https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/document/rdrsis.htm), including explicit DE421 labels and radius/height distinctions.
- [USGS distribution of the 118 m DEM](https://astrogeology.usgs.gov/search/map/moon_lro_lola_dem_118m), including scaling and source references.
- [PGDA south-pole topography](https://pgda.gsfc.nasa.gov/products/81).
- [LROC team's coordinate/control discussion](https://doi.org/10.3847/psj/ad54c6), distinguishing MER from PA, source control accuracy, and DE440's alignment to the DE421 map system.
- [NAIF lunar FK](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_080317.tf). Its frame 31007 is a fixed rotation relative to `MOON_PA_DE421` (31006), using the specified 3-2-1 arcsecond angles `(67.92, 78.56, 0.30)`. The PA orientation itself requires the matching binary PCK. Do not implement these angles without the NAIF convention or replace the time-dependent PA orientation with a constant offset.

These establish the coordinate convention. They do **not** supply a validated
finite end-to-end geolocation bound for this exact fused terrain and WAC/NAC
composition. No claim of validated operational terrain placement follows from
transform agreement. In particular, uncontrolled imagery, residual fusion,
source resolution, raster interpolation and the two lunar ephemeris releases
must not be folded into the numerical closure bound below.

## Reproduction and results

```sh
npm run build
node scripts/audit-lunar-frames.mjs > /tmp/lunar-control-points.json
```

`control-points.json` records full matrices, ET, reference sites, all decompressed
kernel SHA-256 identities, and LRO samples. Required LRO kernels already belong
to this repository's fixture set; `bash scripts/fetch-lro-kernels.sh` restores
them when absent. The orientation pair covers 1900–2050, not arbitrary epochs.
All comparisons use geometric positions (`NONE`) unless a separate sky test
explicitly requests aberration corrections.

| UTC | IAU/DE421 rotation (arcsec) | Shackleton displacement (m) | Maximum displacement on 1737.4 km sphere (m) |
| --- | ---: | ---: | ---: |
| 2000-01-01 12:00 | 8.801464 | 64.657 | 74.136 |
| 2010-06-01 00:00 | 13.936823 | 106.043 | 117.392 |
| 2025-01-15 00:03 | 14.641334 | 80.710 | 123.326 |
| 2028-12-15 10:04 | 3.303898 | 14.933 | 27.829 |

The JSON also includes the south pole, prime-meridian equator, 90°E equator,
and 45°N/45°E. Displacements compare the same numerical surface coordinate
interpreted in each orientation; they are not measured errors in LOLA.

Three real LRO reconstruction samples (2025-01-15, 01-16 and 02-01) transformed
through `Universe` from `MOON_ME_DE421` agree with direct CSPICE ECLIPJ2000
positions within `7e-10 m` in this run. The regression tolerance is `1e-9 km`
(1 micrometre). This is numerical transform closure against the **same orbit
reconstruction**, not an independent orbit or terrain accuracy measurement.
The generic de440s planetary SPK supplies body centres while the DE421 PCK
supplies the declared surface orientation; these are explicitly separate inputs.

## Runtime and compatibility

- The MoonFall catalog explicitly selects DE421 orientation and requires the
  lunar FK/PCK through `base/lunar-surface.json`. Missing engine, FK, binary PCK
  or epoch coverage makes placement unavailable. A stale orientation is hidden,
  not relabelled as IAU or approximated analytically.
- `BODY_FIXED` resolves to the parent's declared target frame. Explicit
  `IAU_MOON` remains the text-PCK frame even when the rendered Moon uses DE421.
  CPU grids, rendered terrain, imagery and picks share the declared surface
  frame. New picks carry their frame through saved measurement endpoints.
- Only these immutable revisions receive an in-memory metadata erratum:
  `cube-fused-79895697c6b6-g3-m12-b6747ec9d`,
  `cube-imagery-nac-6db766f8beebcace`, and
  `cube-imagery-composite-3f34a19541af7710`. Their payloads sampled source map
  coordinates directly. Their original manifests remain preserved and the
  hosted objects remain immutable. This is a metadata correction, not a
  rotated/rebuilt heightfield. Unknown revisions get no correction.
- Future cube terrain and imagery builds require their audited frame to be
  stated by the production wrapper. A frame or generator change creates a new
  build identity. Rebuilding payloads is required if actual source coordinates,
  sampling or geometry change; changing a frame label alone cannot repair a
  product that was previously rotated into another frame.
- Old catalogs keep their declared attitudes. The LRO catalog is deliberately
  left for the subsequent migration requested by #238; its existing
  quantized-mesh product's frame/vertical reference needs its own audit.
  MoonFall's absolute waypoint numbers are unchanged. Its authoring cache stays
  pinned to the same terrain revision and its provenance says `synthetic-demo`.
- Geographic layers can declare `coordinates.frame`. Draping across different
  physical frames is explicitly unavailable rather than interpreting coordinates
  in the current attitude. The authored MoonFall sites and audited USGS LOLA 2011 gazetteer
  declare DE421. See [the source audit](../../planetary-nomenclature.md#verified-usgs-snapshots).
  The gazetteer had inherited IAU_MOON only because its frame was omitted;
  correcting that metadata preserves every source coordinate and restores
  MoonFall labels and Fly/Jump. It is not an IAU-to-DE421 coordinate rotation.
- Existing saved picks without `frame` retain legacy current-attitude semantics;
  they are not sufficient provenance for absolute operational placements.
- Non-lunar defaults and the legacy permissive `FrameRegistry.transform` API
  remain available. Strict placement uses `transformRequired`; named lunar
  realizations cannot silently fall through to identity.

## Reusable absolute input provenance

Existing catalog fields already describe trajectory frame, units, geometry and
waypoint absolute-altitude semantics. OEM/state records are already absolute
Cartesian inputs. No second trajectory format or runtime terrain adjustment
pipeline was added. The optional item-level `surfaceTrajectory` records the
missing reusable physical context for any absolute surface trajectory:

```json
{
  "trajectoryFrame": "MOON_ME_DE421",
  "surfaceTrajectory": {
    "frame": "MOON_ME_DE421",
    "positionUnits": "km",
    "datum": {
      "referenceShape": { "kind": "sphere", "radiusKm": 1737.4 },
      "verticalDatum": "reference-sphere",
      "heightConvention": "radial"
    },
    "purpose": "supplied",
    "terrainRevision": "revision-used-for-planning"
  }
}
```

Units describe the normalized trajectory positions; existing import adapters
remain responsible for source-unit conversion. Omit `terrainRevision` when
no terrain revision was involved in planning. A conflicting frame declaration
withholds placement. A resolvable frame difference, datum difference or planning
revision difference is diagnosed by `Universe.surfaceTrajectoryStatus` and the
body inspector; none adds offsets or re-clamps supplied positions. Supplied
absolute waypoints also bypass `surfaceLock` adjustment. Existing legacy
terrain-relative demo waypoints retain their opt-in behavior.

## Validation commands

```sh
npx vitest run packages/core/src/__tests__/lunar-frame-alignment.test.ts \
  packages/three/src/__tests__/TerrainManagerCube.test.ts \
  packages/three/src/__tests__/CubeImageryLayer.test.ts \
  apps/viewer/src/lib/moonfall-sun.integration.test.ts
npm run typecheck
npm run lint
# Start viewer separately on port 5186, then use a real Chrome installation:
CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  node scripts/test-lunar-frame-alignment.mjs
```

The browser driver reads the pinned **hosted** terrain and imagery through a
local test catalog, keeps metadata unchanged, records hashes and GPU evidence,
and captures Shackleton, pole, equator and compact layouts. `HOSTED=0` isolates
local-product behavior. Generated work files stay outside the durable report.

## Recorded validation (2026-10-28)

- `npm run typecheck`: package build, tests, viewer TS and Svelte all passed;
  Svelte reported zero errors and warnings. `npm run lint` and `git diff --check`
  passed. Shell/Python/Node syntax checks passed.
- Focused frame, terrain, imagery, catalog, DSK and measurement regressions:
  301 tests passed before the final structured-frame regression was added;
  that regression also passed in the broad run.
- Initial broad run: 2,752 passed, 7 skipped, with the known GF progress-throttle
  timing failure and ignored local-catalog inventory failure, plus three
  subsequently fixed regressions (DSK test fixture dependency and stale
  MoonFall generator `visible` field). The final broad run (GF test excluded,
  not changed) had 2,736 passed, 7 skipped, and only the ignored-catalog failure.
  `git check-ignore -v` confirms those five extra `moonfall-144-*` /
  `moonfall-fused-local` catalogs are local exclusions; they are not edited.
  Neither baseline assertion was weakened. This is not a clean full-suite claim.
- All 20 MoonFall flight/rest arcs retain exactly the same reference radius,
  epoch, absolute-altitude flag and waypoint values as the base commit.
- [Browser metrics](browser.json): Chrome on ANGLE Metal / **Apple M4 Max**,
  516 hosted payload requests, no exhausted network retries, no page errors,
  no GL errors. Frame orientation residuals are numerical roundoff. All three
  rendered surface picks report `MOON_ME_DE421`; imagery's required base has
  zero uncovered blocks. The polar screenshot uses an oblique eye aimed at
  the pole, so its first terrain intersection is near the pole, not exactly
  90°S. The separate numerical/CPU tests include the exact pole.
- A test-only catalog addition loads the real LRO reconstruction in that same
  scene. At 2025-01-15 00:03 UTC its rendered Moon-relative offset agrees with
  direct CSPICE within **0.0077 mm** (test tolerance 1 mm; floating-origin
  subtraction included). This addition does not alter the production LRO
  catalog. The body inspector displays a simulated terrain-revision conflict
  while its absolute input position remains unchanged. A simulated orientation
  gap hides the Moon; restoring the transform restores visibility.

Screenshots: [Shackleton](shackleton.png), [polar view](pole.png),
[390 px inspector](compact.png). These are registration/availability evidence,
not a new LOD, photometric or absolute geolocation validation claim.

Operational acceptance still requires a finite, independently justified source
geolocation/registration bound for these exact fused and composited products.
That bound is **unknown here**, not zero. The separate LRO production catalog migration remains an explicit follow-up.

A final kinematics check also verifies that sub-points and co-rotating speeds
use the selected lunar realization, including an explicitly IAU_MOON-stated
input transformed into DE421. The lunar/kinematics/invariants/reference suites
passed 28 tests; the final package, test, viewer and Svelte typechecks passed.

After merging main at `e7355942` (#278), the importer resolution preserves both
explicit frame metadata and user ownership. The new editing/export path retains
the selected lunar frame, rejects contradictory GeoJSON frame declarations,
and refuses a pick from another frame. The affected importer/editing/lunar and
terrain suites passed 144 tests; geographic-vector/place/imagery/DSK suites
passed 92 tests. Package/test/viewer/Svelte typechecks and lint passed again.
The hosted GPU run was repeated on the merged application: 871 payload requests,
no network/page/GL errors, and the same 0.0077 mm rendered LRO numerical residual.
`browser.json` and the screenshots contain this post-merge run.

The native Places check selects the USGS Shackleton record and verifies Fly
and Jump in MoonFall after the source frame audit. [Gazetteer place](gazetteer-place.png)
records that state. The source coordinates remain unchanged; genuinely mismatched
frames still withhold placement and navigation.

GDAL validation also passed: `dem.py selftest`, all three
`test_cube_ellipsoid.py` regressions, and all eleven `test_cube_xyz.py` regressions.

The final missing-transform check also withholds all surface trajectory lines
while the lunar frame is unavailable, then restores the body after recovery.
This prevents a previously oriented trail from remaining visible through a
transform failure. The focused lunar/plot/DSK suites passed 29 tests and full
typechecks passed after this safeguard.

The gazetteer follow-up passed 40 focused TypeScript tests and 12 converter
regressions. Chrome/Metal (Apple M4 Max) passed the complete Places browser
check and the hosted MoonFall check, including Jump to Shackleton, Jump to
Tycho, and Fly back to the same Shackleton surface pivot. The corrected
gazetteer frame does not relax the mismatched-frame placement guard.

## PR review follow-up: consistent path provenance and effective imagery frames

The marker, parent-relative samples and explicit composite-arc samples share
`Universe.trajectoryPlacementAvailable`. An inactive arc is checked against its
own source frame and center, not whichever arc is active at the sample epoch.
Trajectory lines recheck the placement contract before displaying existing
cached geometry, and gate their live/event samples and cache reads. Future
leads apply the same gate. Cached event glyphs are revalidated, and hidden
paths clear their event glyphs and separately attached span strokes. Worker
and synchronous cache sampling retain the same provenance constraints.

The numerical regression uses two distinct, resolvable frames and warms the
path and event caches before introducing a contradictory provenance frame.
It covers ordinary/composite paths, explicit plot frames, cached/live paths,
future leads, event glyphs/spans and recovery. The loaded MoonFall regression
uses actual `IAU_MOON` and `MOON_ME_DE421` kernels: a contradiction withholds
the marker, all five Polaris-A trails and its interval event, preserving the
supplied state. Restoring the declaration restores the path and annotation.
The Apple M4 Max/Metal run passed with 963 hosted payload requests and no
page, GL or network errors; `browser.json` records the current review run.

Imagery compatibility compares projection/scheme and the effective normalized
frame after revision-specific metadata errata, independently retaining body,
pixel convention, tile size and gutter checks. Regressions accept an audited
legacy/corrected DE421 pair in either layer order, preserve the original
manifests, and reject an unknown legacy revision. The six focused suites
passed 103 tests; full package/test/viewer/Svelte typechecks and changed-file
lint passed.
