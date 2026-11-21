# cspice-wasm

A typed, promise-based API over CSPICE compiled to WebAssembly. It runs the SPICE
toolkit either in-process or in a Web Worker so the renderer and geometry layers
can query ephemerides, frames, and geometry events off the main thread. Core layer.

## Public API

Engine factories:

- `createSpiceEngine(options?)`: in-process engine (loads cspice.wasm directly); used by unit tests and as the worker entry point.
- `createSpiceWorkerClient(...)`: main-thread proxy that drives the engine in a Web Worker.
- `createSpiceWorkerPool(...)`: pool of worker clients for parallel sweeps.
- `installSpiceWorker`, `dispatchSpice`, `JobCancelledError`: the worker-side runtime.

Engine surface (`SpiceEngine` / `SpiceComputeEngine`):

- Kernels: `furnsh`, `unload`, `kclear`, `ktotal`.
- Time: `str2et`, `et2utc`, `utc2et`.
- Ephemeris: `spkpos`, `spkezr`, `spkposBatch` (zero-copy n*3 positions), `spkezrBatch` (zero-copy n*6 states plus light times, the batched-states primitive under the frames tier of ADR M-0002).
- Two-body math: `oscelt`, `conics`, `prop2b`; SPK Type 13 writeback via `writeSpkType13`.
- Geometry events: `gfoclt`, `gfdist`, `gfsep`, `gfposc`, `occult`. Each finder takes an optional trailing `GfSearchReport` — see [Reporting and interruptible searches](#reporting-and-interruptible-searches).
- Frames and bodies: `pxform`, `sxform`, `bodvrd`, `bodvcd`, `getfov`.
- Surface and illumination: `sincpt`, `subpnt`, `ilumin`, `recgeo`, `et2lst`, `readDsk`.
- Attitude: `twovec`, `m2q`, `q2m`, `raxisa`.
- Spacecraft clock and CK attitude: `sce2c`/`sct2e` (ET <-> encoded SCLK ticks), `ckgp` (CK pointing query), and `writeCk03`, which writes a CK Type 3 segment (discrete quaternions plus optional angular rate, linear interpolation) and furnshes it so the attitude history is queryable through the same `pxform`/`ckgp` path. A class-3 frame (defined in an FK with `FRAME_<id>_CLASS=3`, `CK_<id>_SCLK`, `CK_<id>_SPK`) drives the scene orientation from a furnished C-kernel. See `ck.test.ts` for the write-then-read round trip and `scripts/make-fixture-ck.mjs` for the demo CK generator.
- Time series: `evalSeries` plus `runEvalSpec`, `gridEpochs`, `PROVIDER_CATALOG` for one-round-trip, cancellable sweeps over a grid.

Types include `Vec3`, `StateVector`, `PositionResult`, `CartesianState`, `OsculatingElements`, `AberrationCorrection`, `Mat3`, `StateBatchArrays`, and the located `SpiceError`. For in-process synchronous consumers (the frames tier, conformance rigs) the package also exports `SpiceBindings` and `createSpiceBindings`, the typed marshaling layer beneath the promise surface, including `namfrm` and `frmnam` for frame id resolution.

```ts
const engine = await createSpiceEngine();
await engine.furnsh('naif0012.tls', lskBytes);
await engine.furnsh('de440s.bsp', spkBytes);
const et = await engine.str2et('2004-07-01T00:00:00');
const { position, lightTime } = await engine.spkpos('6', et, 'J2000', 'NONE', '10');
```

## Reporting and interruptible searches

Pass a `GfSearchReport` to any of the four geometry finders and the search moves
off CSPICE's simplified `gf*_c` wrappers onto the general routines underneath —
`gfevnt_c`, or `gfocce_c` for occultation. Those are the ones that take a
progress reporter and a bail-out handler; the simplified wrappers hard-code
"neither", which is why a search under them is one opaque synchronous call.

```ts
const flag = new Int32Array(new SharedArrayBuffer(4));
const intervals = await engine.gfdist('SATURN', 'NONE', '-82', '<', 1.5e6, 300, et0, et1, {
  onProgress: (fraction, pass) => showBar(fraction),
  cancelFlag: flag,
});
// From another thread: Atomics.store(flag, 0, 1) aborts the search in flight,
// and the call above rejects with SpiceSearchCancelled.
```

- `onProgress` reports the fraction of the **confinement window** swept, not of
  elapsed time, and it only ever moves forward within one call: a relational
  search sweeps its window once to find where the quantity is decreasing before
  it solves the relation, and CSPICE restarts its reporter at each of those
  passes, but the count is known up front (see `gfPassCount`) so each pass is
  mapped into its own slice. `pass` says which one is running, unscaled. Honest
  for a bar, misleading as an ETA. The final `1` is reported once.
- `cancelFlag` must be an `Int32Array` over a `SharedArrayBuffer`. The bail-out
  handler is polled from inside the running CSPICE call, and a worker blocked in
  one cannot read its own message queue, so shared memory is the only channel
  that reaches it. That in turn needs a cross-origin-isolated page. Omit the flag
  where `SharedArrayBuffer` is unavailable: progress still reports and the search
  runs to completion, exactly as under the simplified wrappers.

`SpiceBindings` exposes the same thing synchronously as `gfdistReporting`,
`gfsepReporting`, `gfposcReporting` and `gfocltReporting`, taking a `GfReport`
with a `shouldBail()` predicate instead of a flag.

The handlers themselves are compiled C (`native/gf-report.c`), not JavaScript
function pointers: CSPICE wants them as function pointers, and calling JS through
one would mean `-s ALLOW_TABLE_GROWTH` plus `addFunction` with signatures
asserted in JS rather than checked by a compiler. A C shim calling out through
`EM_JS` keeps the signatures where CSPICE declares them and needs no table
growth. It also throttles both handlers by wall clock, so a search cannot flood
its caller with updates or pay for a JS call on every poll.

**These return the same windows as the simplified wrappers**, which is checked
rather than assumed: `gf-reporting.test.ts` runs both tiers over the same kernels
and requires them to agree interval for interval, and
`packages/frames/src/reference-regression.test.ts` checks reporting results
against committed independent CSPICE outputs (see `docs/spice-retirement.md`).

## Dependency rule

Depends on nothing in the workspace. Part of the core layer; it never imports a PAL
implementation, UI, or shell. Kernel bytes are passed in by the caller (`furnsh(name, bytes)`),
so the engine never reads kernel files directly. The tier above it is `@cosmolabe/frames`
(ADR M-0002), and nothing above that tier calls this package directly.

(Upstream this paragraph also described a `@bessel/spice` facade that re-exported this
package for bessel-heritage imports. That facade existed only to bridge two federated
trees during the merge and was not harvested — there is one tree here.)

## Rebuilding the WebAssembly runtime

The build uses the official [NAIF N0067 Linux/GCC 64-bit archive](https://naif.jpl.nasa.gov/pub/naif/toolkit/C/PC_Linux_GCC_64bit/packages/cspice.tar.Z),
SHA-256 `60a95b51a6472f1afe7e40d77ebdee43c12bb5b8823676ccc74692ddfede06ce`.
It verifies the cached download in `vendor/cspice-N0067.tar.Z` on every build
and compiles only `cspice/src/cspice/*.c` with the archive's headers. The generated
ES module and WASM are checked in under `wasm/`. See the [NAIF distribution rules](https://naif.jpl.nasa.gov/naif/rules.html).

With Bash, curl, shasum, tar with `.Z` support, patch, and Emscripten SDK installed,
activate the pinned toolchain and run from the repository root:

```sh
/path/to/emsdk/emsdk install 6.0.9
/path/to/emsdk/emsdk activate --embedded 6.0.9
source /path/to/emsdk/emsdk_env.sh
bash packages/cspice-wasm/scripts/build-cspice.sh
shasum -a 256 packages/cspice-wasm/wasm/cspice.{mjs,wasm}
```

Each build extracts a fresh source tree and compiles into a temporary directory.
The link step preserves the export lists, filesystem, memory and stack
configuration, and compiles `native/gf-report.c` against the N0067 headers.

The old fork's main WASM changes were its Emscripten build and f2c compatibility
edits. [wasm-abi.patch](native/wasm-abi.patch) retains the three required C
signature fixes. `zzsetnnread_`, `s_cat`, and `s_copy` now return the integer
status expected by their f2c-generated callers. Their existing operations
are unchanged. The build uses the official archive layout and ships Cosmolabe's
generated runtime. The fork's platform files and embedded-kernel examples
aren't needed.

The N0067 WASM is 1,448,188 bytes, up 36,245 bytes (2.6%) from N0066. The rebuilt
76,290-byte JavaScript module is byte-for-byte identical to the N0066 module.
Two clean compilations with the pinned SDK on macOS arm64 produced identical
artifacts.

A local Node 24 comparison on Apple M4 Max used the same LSK, trimmed SPK and
PCK for both releases. Median startup was 2.26 ms in both and median kernel
furnishing was 15.3 ms on N0066 and 10.5 ms on N0067. A warmed batch of 30,000
calls (Saturn `spkpos`, Moon `pxform`, Earth `sxform`) took 35.4 ms and 35.2 ms,
respectively, with 160 MiB of WASM linear memory in both cases. Sampled outputs
were identical. The Mars-system tests use the native N0067 reference because
NAIF warns against querying those orientations from this PCK on N0066.

## Tests

Tests live in `packages/cspice-wasm/src/*.test.ts` (spice, batch, dsk, geometry, geodetic,
occultation, propagation, eval-series, ck, gf-reporting). `gf-reporting.test.ts` is the
differential between the general GF entry points and the simplified wrappers, and also
pins that a bail-out abandons the work rather than merely the answer: a search big
enough to take ~370 ms returns after a single poll when interrupted.

The `ck.test.ts` round trip writes a known attitude profile to a CK Type 3 segment, furnshes it, and asserts both `ckgp` and
`pxform(frame, J2000)` against the validated `q2m` quaternion convention. The acceptance
test (`spice.test.ts`) loads
`naif0012.tls` plus a de440s SPK and asserts `spkpos` of Saturn barycenter (6) relative
to the Sun (10) in J2000 at 2004-07-01 against a NAIF reference pinned from de440s,
agreeing well within 1 metre, and checks that unresolved bodies raise a typed `SpiceError`.
It also pins the toolkit version and ISO UTC with a trailing `Z`. Mars, Phobos,
and Deimos position and state transforms are checked against NAIF's native
N0067 macOS arm64 build using the same `pck00011.tpc`. For the reference
calculation, apply `pxform_c("J2000", frame, 730000000, ...)` to the position
`[1, -2, 3]` and `sxform_c` to the state `[1, -2, 3, 0, 0, 0]`. The CK suite
also exercises interleaved SCLK conversions and a switch frame across a CK gap.
The installed viewer smoke test runs a SPICE trajectory and furnishes the
kernels in a worker after an ordinary Vite host rebundles the package.

## N0067 follow-up

Switch frames can support mission-authored CK fallbacks where both coverage and
priority are documented. Product frames can compose calibrated mission frames
when an FK uses them. Both already work through the existing frame transforms.
Tangent points and target separation warrant separate work when a limb or
apparent-disk consumer needs them. Ground-observer angles belong with the
[surface azimuth/elevation work](https://github.com/AaronPlave/cosmolabe/issues/217).
The existing instrument IDs and satellite.js TLE path have no new requirement
for `getfvn_c` or `evsgp4_c`.

## Status / limitations

All calls are async even in-process. Geometry-event finders (`gfoclt`, `gfdist`)
require a search `step` shorter than the briefest event or they can miss intervals;
correctness follows CSPICE semantics.

NAIF's [N0067 known bugs](https://naif.jpl.nasa.gov/naif/bugs.html) include
incorrect orientation derivatives for custom text PCKs that use third-degree
phase-angle polynomials. NAIF's published PCKs, including `pck00011.tpc`, are
unaffected.

Interrupting a search through `cancelFlag` needs `SharedArrayBuffer`, and so a
cross-origin-isolated page. Without it a search run through these bindings goes to
completion; progress reporting is unaffected. A host that cannot be isolated can still
stop a search by terminating the worker it runs in — see `GeometrySearchWorker` in
`@cosmolabe/three`, which is how the viewer cancels when the flag is unavailable.

`gfstol_c` is not exported, so the reporting entry points pass `SPICE_GF_CNVTOL` as the
convergence tolerance — the same value the simplified wrappers fall back to. Exporting
`gfstol_c` would give the two tiers a way to disagree and would need the tolerance
plumbed through the reporting calls.
