# @cosmolabe/core

Pure TypeScript universe model with **zero rendering dependencies**. Part of [Cosmolabe](https://github.com/AaronPlave/cosmolabe), a web mission visualization toolkit.

Use this package server-side, in tests, or under any renderer. The companion packages [`@cosmolabe/three`](../three) and [`@cosmolabe/cesium`](../cesium) compose over it.

## What's in here

- **`Universe`** — body registry, time state, `universe.getBody('LRO').stateAt(et)` API
- **`CatalogLoader`** — parses [catalog JSON](https://github.com/AaronPlave/cosmolabe/blob/main/docs/catalog-format.md) in full: 10 trajectory types, 6 rotation models, 8 geometry types, 4 inertial frames + body-fixed + two-vector frames. The format is the primary way to configure a scene; existing Cosmographia catalogs load unmodified.
- **Trajectories** — `FixedPoint`, `Keplerian`, `Spice`, `InterpolatedStates`, `Composite`, `Builtin` (JPL DE), `ChebyshevPoly`, `LinearCombination`, `TLE` (via [satellite.js](https://github.com/shashwatak/satellite-js)). Each implements `stateAt(et) → { pos, vel }`.
- **Rotations** — `Uniform`, `Fixed`, `FixedEuler`, `Interpolated` (quaternion SLERP), `Spice`, `TrajectoryNadir`. Each implements `rotationAt(et) → Quaternion`.
- **Frames** — `EclipticJ2000`, `ICRF`, `EquatorJ2000`, `EquatorB1950`, `BodyFixed`, `TwoVector`
- **`GeometryCalculator`** — altitude, sub-spacecraft point, sun angles, orbital elements, eclipse/occultation detection
- **`EventFinder`** — eclipse / occultation / conjunction window search via SPICE geometry finders
- **Plugin system** — `SpiceScenePlugin` (data) and `RendererPlugin` (visual), with reactive `EventBus` and `StateStore`

## SPICE is optional

Trajectories like `TLE`, `Keplerian`, `InterpolatedStates`, `FixedPoint`, and `ChebyshevPoly` work with no SPICE kernels loaded. Rotations like `Uniform`, `Fixed`, `Euler`, `Interpolated`, and `TrajectoryNadir` also work without SPICE. Load SPICE only when you need high-precision SPK / CK ephemerides, exact frame transforms, or geometry event finders.

## Install

```bash
npm install @cosmolabe/core @cosmolabe/spice
```

## Quick example

```ts
import { Universe, CatalogLoader } from '@cosmolabe/core';
import { Spice } from '@cosmolabe/spice';

await Spice.init();
await Spice.loadKernel(naif0012Tls);

const universe = new Universe({ spice: Spice });
const loader = new CatalogLoader(universe);
await loader.load(catalogJson);

const et = Spice.utc2et('2025-01-01T00:00:00');
const { pos, vel } = universe.getBody('LRO')!.stateAt(et);
```

## License

Apache-2.0. See [LICENSE](https://github.com/AaronPlave/cosmolabe/blob/main/LICENSE) and [NOTICE](https://github.com/AaronPlave/cosmolabe/blob/main/NOTICE).
