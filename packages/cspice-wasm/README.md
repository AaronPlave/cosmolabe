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
`packages/frames/src/differential.test.ts` holds the reporting path against the
legacy timecraftjs engine too.

## Heap budget

Every engine instantiates its own wasm heap, and each one reserves 112 MiB up
front before a kernel is furnished. That number is a budget: a viewer scene runs
more than one instance, so it is multiplied by however many the host keeps
alive. It is declared in `src/wasm-memory.ts`, passed by
`scripts/build-cspice.sh` as `INITIAL_MEMORY`, asserted against the committed
`wasm/cspice.wasm` by `src/wasm-memory.test.ts`, and re-pinnable without a full
Emscripten rebuild via `scripts/set-initial-memory.mjs`.

Most of the reservation is CSPICE's static data -- f2c-translated COMMON blocks
for the DAF/DAS buffer pools, the kernel pool and the GF workspaces -- which is
why it cannot be lowered much further. See [docs/memory-budget.md](../../docs/memory-budget.md)
for the whole picture, including what it costs a host to run several instances.

## Dependency rule

Depends on nothing in the workspace. Part of the core layer; it never imports a PAL
implementation, UI, or shell. Kernel bytes are passed in by the caller (`furnsh(name, bytes)`),
so the engine never reads kernel files directly. The tier above it is `@cosmolabe/frames`
(ADR M-0002), and nothing above that tier calls this package directly.

(Upstream this paragraph also described a `@bessel/spice` facade that re-exported this
package for bessel-heritage imports. That facade existed only to bridge two federated
trees during the merge and was not harvested — there is one tree here.)

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

## Status / limitations

All calls are async even in-process. Geometry-event finders (`gfoclt`, `gfdist`)
require a search `step` shorter than the briefest event or they can miss intervals;
correctness follows CSPICE semantics.

Interrupting a search through `cancelFlag` needs `SharedArrayBuffer`, and so a
cross-origin-isolated page. Without it a search run through these bindings goes to
completion; progress reporting is unaffected. A host that cannot be isolated can still
stop a search by terminating the worker it runs in — see `GeometrySearchWorker` in
`@cosmolabe/three`, which is how the viewer cancels when the flag is unavailable.

`gfstol_c` is not exported, so the reporting entry points pass `SPICE_GF_CNVTOL` as the
convergence tolerance — the same value the simplified wrappers fall back to. Exporting
`gfstol_c` would give the two tiers a way to disagree and would need the tolerance
plumbed through the reporting calls.
