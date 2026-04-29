# @cosmolabe/cesium

CesiumJS rendering layer for [Cosmolabe](https://github.com/AaronPlave/cosmolabe). Composes over [`@cosmolabe/core`](../core) and [`@cosmolabe/cesium-adapter`](../cesium-adapter) — same trajectories, same bodies, different renderer than [`@cosmolabe/three`](../three).

For guidance on which renderer fits your project, see [CHOOSING_A_RENDERER.md](../cesium-adapter/CHOOSING_A_RENDERER.md). Short version: Cesium for globe-centric ops dashboards (imagery, ground stations, geospatial context); Three.js for deep-space, multi-body, custom-shader scenes.

## Components

| Component | Role |
|---|---|
| `CesiumRenderer` | Orchestrator — creates the viewer, syncs Universe bodies |
| `BodyEntity` | Single body (position, rotation, GLTF model) |
| `TrajectoryTrail` | Orbit path polyline |
| `SurfacePoints` | Lat/lon markers — landing sites, ground stations |
| `CameraManager` | Camera control + viewpoint transitions |
| `GlobeSetup` | Imagery presets (Bing, OSM, GEBCO, custom WMS) |
| `EntityStyle` | Unified styling (colors, sizes, transparency) |

## Install

```bash
npm install @cosmolabe/cesium @cosmolabe/core @cosmolabe/cesium-adapter cesium
```

`cesium` is a peer dependency.

## Quick example

```ts
import { Universe } from '@cosmolabe/core';
import { CesiumRenderer } from '@cosmolabe/cesium';

const universe = new Universe({ spice });
const renderer = new CesiumRenderer({
  universe,
  container: 'cesium-container',
  imageryPreset: 'bing',
});

renderer.addBody('ISS');
renderer.start();
```

The `apps/cesium-viewer` demo in the main repo wires this up alongside live ISS telemetry, eclipse highlighting, and a TDRSS-style comm relay.

## License

Apache-2.0. See [LICENSE](https://github.com/AaronPlave/cosmolabe/blob/main/LICENSE) and [NOTICE](https://github.com/AaronPlave/cosmolabe/blob/main/NOTICE).
