# SPICE oracle retirement and validation

Issue #226 retires the second CSPICE build and binding package. Runtime queries,
scene composition, worker behavior and the core injection contract are unchanged.
The supported route remains `cspice-wasm` → `@cosmolabe/frames`, injected into core
(ADR M-0002). Core gains no runtime dependency.

## Independent reference provenance

`packages/frames/src/__fixtures__/cspice-reference.json` contains 187 successful
call results captured on 2026-10-15 from **TimeCraftJS 2.0.0**, through the former
wrapper at commit `8f8af27fd04475f4b219cbe31f905d3dd443a223`.
This is a separately compiled CSPICE implementation and binding layer, not output
from the engine under test. These are regression references, not a claim of
independent physical truth: existing authoritative NAIF and Horizons checks remain.

Capture procedure: at that commit, furnish the original differential suite's
kernel lists in their original order, wrap only the legacy engine's synchronous
query methods, record each argument tuple and returned value, then run all 31
original differential tests. All 31 passed before removal. Furnish was forwarded
without recording buffers; unsuccessful calls were discarded. The JSON key is
`JSON.stringify([methodName, arguments])`; the value's `result` is the unrounded
return value. The supported engine was never used to populate the reference map.
A missing reference now fails the test; no update flag can generate an expectation
at assertion time. To reproduce, use an isolated checkout of the recorded commit
and this capture procedure, then review numerical changes before replacing data.
There is no legacy build, library or installation requirement in the current tree.

Kernel identity is pinned by SHA-256 in
`packages/frames/src/__fixtures__/reference-kernels.json` (hash the actual binary
bytes, not LFS pointers). Generic and Cassini kernels moved byte-for-byte to
`kernels/test-data/`; MSL's versioned clock and telemetry CK remain with the viewer.
The generic kernels are NAIF's `naif0012.tls`, `pck00010.tpc`, and `de425s.bsp`;
the Cassini files are mission archive products with versions in their filenames.
Fixture data remains under NAIF's terms in NOTICE; historical TimeCraftJS attribution
is retained for the captured reference provenance.

Each call key explicitly records target/observer, epoch, frame, correction, method
and search window wherever applicable. Baseline epoch: **2004-07-01 02:00:00 UTC**,
converted with the pinned LSK to ET seconds past J2000 TDB. The state sweep covers
2004-07-01 00:30 through 2004-07-02 12:00 UTC (13 samples). Frames include J2000,
ECLIPJ2000, IAU_EARTH, IAU_SATURN, IAU_TITAN, CASSINI_SC_COORD and CASSINI_ISS_NAC.
Position corrections: NONE, LT, LT+S, CN, CN+S, XLT+S; state corrections: NONE, LT+S.
Units are CSPICE's km, km/s, seconds, radians and row-major dimensionless matrices;
CK coverage uses ET seconds or SCLK ticks as explicitly selected. Local solar time
uses planetocentric longitude in radians. GF confinement and returned endpoints
are ET seconds; angular separation is radians, distances km, steps seconds.

Numeric call results retain relative tolerance **1e-12**, with zero and exact
matches accepted. Time strings, UTC/ET conversions and discrete results remain
exact. This preserves the former differential tolerances; it introduces no
numerical rebaseline. Analytic round trips and physical bounds supplement these
pins where exact physical predictions are inappropriate.

`packages/core/src/__tests__/__fixtures__/pipeline-reference.json` was captured
from the **legacy-backed scene**, using the same recorded commit, not the active
adapter. It contains the unrounded saturn-soi scene epoch, membership and 10 bodies
at offsets -12, -6, 0, +6, +12 hours from **2004-07-01 02:48:00 UTC**. The scene
kernel set is `naif0012.tls`, `pck00010.tpc` and
`040629AP_SCPSE_04179_04185.bsp` (hashes above). The catalog, frames and per-body
query inputs are defined in `_harness/scenes.ts`, trajectories and kinematics
at the recorded commit. SPICE trajectory legs use aberration correction NONE;
frame composition uses geometric rotations at the sample ET. Positions are world ECLIPJ2000 km; orientations
are body-to-world quaternions composed through each rotation's sourceFrame;
subpoint altitude is km and latitude/longitude are degrees. Tests retain **1e-6 km**
position/altitude, **1e-3 arcsec** pointing and **1e-3/3600 degrees** subpoint angle
limits. JSON null components encode nonfinite coverage results, checked explicitly.
Quaternion sign and longitude wrapping are handled as before. No scene goldens
were regenerated during this cleanup.

## Before/after coverage mapping

| Former coverage | Supported coverage after retirement |
| --- | --- |
| frames differential: SPK position/velocity across targets, frames and corrections, 13-epoch state sweep | `frames/src/reference-regression.test.ts`, committed independent values; all numerical cases retained |
| Analytic, ecliptic, CK/FK/SCLK attitude chains; 6×6 derivative transforms | Same pinned reference suite, plus existing `cspice-wasm/src/ck.test.ts` sample-quaternion and clock inverses |
| Cassini and MSL CK ids, SCLK/ET segment and interval coverage, angular-velocity filter, tolerance padding, invalid options | Same pinned reference suite; existing `ck-coverage.test.ts` also retains union/unload behavior |
| UTC/ET, ISO Z/offset/whitespace normalization, every UTC format/precision, timout, unitim, local solar time | Same pinned reference suite plus existing `frames/src/iso-epoch.test.ts`, core leap-second and viewer camera/viewpoint suites, now all on the supported engine |
| GF distance, separation, occultation intervals and reporting | Same independent interval pins; `cspice-wasm/src/gf-reporting.test.ts` retains all four finders' simple/reporting parity, progress slicing, interruption, callback failures, worker cancellation and reuse |
| GF interval-boundary behavior | Existing `occultation.test.ts` pins classification transitions on either side of roots; `geometry-finder.test.ts` retains independent angular/elevation root invariants; heritage charter tests retain confinement-order concatenation |
| Surface points, intercept hit/miss, illumination, constants, orbital elements, vector operations | Same independent pins; migrated generic integration suite retains physical bounds, exact algebra and orbital round trips |
| Legacy Cassini suite | `frames/src/__tests__/cassini-integration.test.ts`: mission SPK, FOV definitions, orbital and analytic frame checks retained; pooled Buffer furnishing corrected to exact byte slices |
| Legacy LRO suite | `frames/src/__tests__/lro-validation.test.ts`: existing Horizons geometric ICRF Moon-centered state at 2025-01-15 00:03 UTC and 75.5–75.9 km altitude/aberration bounds retained; fetched versioned LRO kernels and de440s are unchanged |
| Legacy synthetic FOV suite | `frames/src/__tests__/spice-fov.test.ts`: circle/rectangle kernel definitions, frames, boresights and boundary vectors retained |
| Pipeline cross-engine scene comparisons | `core/src/__tests__/pipeline-reference.test.ts`: independent unrounded parent-chain position, sourceFrame attitude composition and body-fixed unwrap at all 50 samples; existing scene fingerprints/oracles/invariants also run on the supported engine by default |
| Core injection conformance and direct legacy-backed tests | Compile-time adapter-to-consumer pin retained; named/two-vector/body-fixed frames, geometry/event calculations, Cassini catalog, rotations, leap seconds, viewer camera and three viewpoint integration now construct the supported adapter |
| Kernel lifecycle, errors, viewer and cache/search workers | Existing heritage kernel clear/provenance and typed-error tests, CK unload checks, viewer kernel-set worker integration and trajectory-cache/worker GF suites remain; migrated invalid-time check asserts SpiceError rather than an obsolete message prefix |
| DSK | No DSK assertions existed in the removed wrapper suites. Existing active `cspice-wasm/src/dsk.test.ts` retains type-2 vertex/plate/index coverage using `mu69_lopoly.bds`; there is no new DSK geometry claim |

## Intentional gaps and replacements

Nine successful legacy `fovray` cases (five synthetic, four Cassini rays) are
retired: `fovray_c` is absent from the supported engine's export allowlist and
has no runtime consumer. Adding that export/API is outside this cleanup. Both
migrated FOV suites instead assert the existing explicit rejection; numerical
`getfov` shape, boresight and boundary coverage remains. This does not claim to
replace ray containment validation. `fovtrg` and `cidfrm` had no assertions in
the retired suites; their existing unsupported-entrypoint contract remains.

Historical oracle-only throws for ISO forms rejected by the old parser are
removed; the active parser's acceptance and exact normalized instant stay pinned.
Invalid CK option checks remain on the active engine. The live two-build comparison
and engine-selection environment switch are gone; continuing to validate a retired
build would retain the maintenance burden this issue removes. Existing pinned NAIF
checks and in-engine GF parity tests are reused without new duplicate suites.

## Verification

Run the normal repository gates: `npm run typecheck`, `npm run lint`,
`npm run lint:purity`, `npm test`, and `npm --workspace @cosmolabe/viewer run build`.
Use the same CI LFS and LRO/Cosmographia fetch prerequisites; CI sparse paths and
fetch/generation scripts now follow `kernels/test-data/`.
