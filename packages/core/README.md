# @cosmolabe/core

Pure TypeScript universe model with **zero rendering dependencies**. Part of [Cosmolabe](https://github.com/AaronPlave/cosmolabe), a web mission visualization toolkit.

Use this package server-side, in tests, or under any renderer. The companion packages [`@cosmolabe/three`](../three) and [`@cosmolabe/cesium`](../cesium) compose over it.

## What's in here

- **`Universe`** — body registry, time state, `universe.getBody('LRO').stateAt(et)` API
- **`CatalogLoader`** — parses [catalog JSON](https://github.com/AaronPlave/cosmolabe/blob/main/docs/catalog-format.md) in full: 10 trajectory types, 6 rotation models, 8 geometry types, 4 inertial frames + body-fixed + two-vector frames. The format is the primary way to configure a scene; existing Cosmographia catalogs load unmodified.
- **Trajectories** — `FixedPoint`, `Keplerian`, `Spice`, `InterpolatedStates`, `Composite`, `Builtin` (JPL DE), `ChebyshevPoly`, `LinearCombination`, `TLE` (via [satellite.js](https://github.com/shashwatak/satellite-js)). Each implements `stateAt(et) → { position, velocity }`.
- **Rotations** — `Uniform`, `Fixed`, `FixedEuler`, `Interpolated` (quaternion SLERP), `Spice`, `TrajectoryNadir`. Each implements `rotationAt(et) → Quaternion`.
- **Frames** — `EclipticJ2000`, `ICRF`, `EquatorJ2000`, `EquatorB1950`, `BodyFixed`, `TwoVector`
- **`GeometryCalculator`** — altitude, sub-spacecraft point, sun angles, orbital elements, eclipse/occultation detection
- **`EventFinder`** — eclipse / occultation / conjunction window search via SPICE geometry finders
- **Geometry/event finder model** — one query and result type for every geometry search, a registry of `EventKind`s, the SPICE GF boundary they run against, and the timeline/3D integration selecting an event drives. See [docs/event-model.md](https://github.com/AaronPlave/cosmolabe/blob/main/docs/event-model.md).
- **Plugin system** — `SpiceScenePlugin` (data) and `RendererPlugin` (visual), with reactive `EventBus` and `StateStore`

## SPICE is optional

Trajectories like `TLE`, `Keplerian`, `InterpolatedStates`, `FixedPoint`, and `ChebyshevPoly` work with no SPICE kernels loaded. Rotations like `Uniform`, `Fixed`, `Euler`, `Interpolated`, and `TrajectoryNadir` also work without SPICE. Load SPICE only when you need high-precision SPK / CK ephemerides, exact frame transforms, or geometry event finders.

## SPICE arrives by injection

core imports no SPICE package. It declares the surface it calls — `SpiceInstance` in
[`src/spice-injection.ts`](src/spice-injection.ts) — and every entry point that needs an engine takes
one as an argument. Anything with the right shape satisfies it; in this repo
[`@cosmolabe/frames`](../frames) does, with `createHeritageSpice()` over `cspice-wasm`, which is what
the viewer and the trajectory cache worker construct. That direction is deliberate: core depends on
an interface and the frames tier satisfies it, so the engine underneath can be replaced without core
changing.

**It is transitional, and deliberately narrow.** It holds the 25 members core's own call sites use —
not the heritage adapter's 47 — and it shrinks as those call sites migrate to the published M-0002
contracts (`StateProvider`, `FramesService`), which is the heritage adapter's documented dissolution
plan. A new capability belongs in a narrow contract owned by its consumer — the model is
`GeometryFinderProvider` in [`src/geometry/events/provider.ts`](src/geometry/events/provider.ts) —
not here. Both implementations are pinned to it at compile time by
[`src/__tests__/spice-injection-conformance.test.ts`](src/__tests__/spice-injection-conformance.test.ts).

## Install

```bash
npm install @cosmolabe/core @cosmolabe/frames
```

## Quick example

```ts
import { Universe } from '@cosmolabe/core';
import { createHeritageSpice } from '@cosmolabe/frames';

const spice = await createHeritageSpice();
await spice.furnish({ type: 'url', url: naif0012TlsUrl });

const universe = new Universe(spice);
universe.loadCatalog(catalogJson);

const et = spice.str2et('2025-01-01T00:00:00Z');
const { position, velocity } = universe.getBody('LRO')!.stateAt(et);
```

## License

Apache-2.0. See [LICENSE](https://github.com/AaronPlave/cosmolabe/blob/main/LICENSE) and [NOTICE](https://github.com/AaronPlave/cosmolabe/blob/main/NOTICE).
