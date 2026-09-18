# @cosmolabe/spice

Typed TypeScript wrappers over the full CSPICE function library compiled to WASM. Part of [Cosmolabe](https://github.com/AaronPlave/cosmolabe), a web mission visualization toolkit.

## Its role: the independent reference implementation

**This package is not on any runtime path, and nothing in the repo depends on it at runtime.** The
viewer and the trajectory cache worker construct `createHeritageSpice()` from
[`@cosmolabe/frames`](../frames), over `cspice-wasm`, so every state and orientation reaching the
model flows through the ADR M-0002 contracts. `@cosmolabe/core` does not import this package either:
it declares the narrow surface it calls (`SpiceInstance`, `packages/core/src/spice-injection.ts`) and
takes an engine by injection. This package satisfies that interface structurally, which is checked at
compile time by `packages/core/src/__tests__/spice-injection-conformance.test.ts`.

What is left is more valuable than another code path: a second, separately compiled CSPICE — a
different toolkit build reached through a different binding layer — whose values the WASM path is
differentially checked against. That is an oracle, and it is what keeps the heritage adapter honest:

- [`packages/frames/src/differential.test.ts`](../frames/src/differential.test.ts) — value-for-value
  comparison of the adapter against this wrapper, over the same kernels
- `packages/spice/src/__tests__` — the oracle suites (`cassini-integration`, `lro-validation`,
  `spice-fov`)

It is therefore a **devDependency** everywhere it appears. Adding it back as a runtime dependency
would give up the property the migration bought: one CSPICE on the runtime path, one independent one
to check it against.

CSPICE is provided by [TimeCraftJS](https://github.com/NASA-AMMOS/timecraftjs), whose `exports.json` already exposes ~500 CSPICE entry points via Emscripten. This package handles the `malloc` / `ccall` / `getValue` / `free` memory management and returns clean typed JS objects.

## Wrapped functions

| Category | Functions |
|---|---|
| Time | `utc2et`, `et2utc`, `et2lst`, `str2et` |
| State | `spkpos`, `spkezr` |
| Frame transforms | `pxform`, `sxform` |
| Surface geometry | `sincpt`, `subpnt`, `subslr` |
| Illumination | `ilumin` |
| Orbital elements | `oscelt`, `conics` |
| Body constants | `bodvcd`, `bodvrd` |
| Geometry finders | `gfposc`, `gfsep`, `gfoclt`, `gfdist` |
| Matrix / vector | `mxv`, `mtxv`, `vcrss`, `vnorm`, `vdot` |

Error handling: `erract_c('SET','RETURN')` is set at init; each wrapper checks `failed_c()` after the call and surfaces SPICE errors as JS exceptions.

## Install

```bash
npm install @cosmolabe/spice
```

## Quick example

```ts
import { Spice } from '@cosmolabe/spice';

await Spice.init();
await Spice.loadKernel(naif0012Tls);  // ArrayBuffer | URL | File
await Spice.loadKernel(de440sBsp);

const et = Spice.utc2et('2025-01-01T00:00:00');
const { pos, lt } = Spice.spkpos('EARTH', et, 'J2000', 'NONE', 'SUN');
```

## Bundle size

The TimeCraftJS asm.js module is ~20 MB; our wrappers add negligible overhead. Load it lazily on the route that needs SPICE rather than in your initial bundle.

## License

Apache-2.0. See [LICENSE](https://github.com/AaronPlave/cosmolabe/blob/main/LICENSE) and [NOTICE](https://github.com/AaronPlave/cosmolabe/blob/main/NOTICE).

This software is not approved or endorsed by NASA or JPL.
