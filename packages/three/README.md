# @cosmolabe/three

Three.js rendering layer for [Cosmolabe](https://github.com/AaronPlave/cosmolabe). Syncs a [`@cosmolabe/core`](../core) `Universe` into an interactive 3D scene with origin-shifting, multi-pass depth, eclipse shadows, atmospheric scattering, streaming terrain, and a plugin system.

## Components

- **`UniverseRenderer`** — scene graph sync, origin-shifting for precision at planetary scales, multi-pass depth (log-depth scene + surface tiles + models + pick marker)
- **`BodyMesh`** — textured spheres with DDS / JPG surface maps, correct rotation, GLTF model support
- **`TerrainManager`** — streaming terrain via [3d-tiles-renderer](https://github.com/NASA-AMMOS/3DTilesRendererJS): quantized mesh, 3D Tiles, Cesium Ion
- **`SurfaceTileOverlay`** — WMS / WMTS / TMS imagery overlay on terrain
- **`TrajectoryLine`** — orbit trails with configurable duration, fade, and per-segment colors (`setColorSegments()` / `clearColorSegments()`)
- **`TrajectoryCache` + `SpiceCacheWorker`** — off-thread adaptive sampling with Visvalingam-Whyatt simplification
- **`SensorFrustum`** / **`InstrumentView`** — instrument FOV cones; CAHVORE camera frustums with projected imagery
- **`EclipseShadow`** — analytical body-to-body umbra/penumbra shading via GLSL injection (up to 4 occluders)
- **`AtmosphereMesh`** — Rayleigh + Mie limb scattering (adapted from Celestia's algorithm)
- **`RingMesh`** — planetary rings
- **`StarField`** — naked-eye stars from the HYG catalog with magnitude-based filtering
- **`LabelManager`**, **`GeometryReadout`**, **`EventMarkers`** — UI overlays
- **`CameraController`** — orbit camera, body tracking, smooth transitions, keyboard shortcuts. Surface Explorer mode (ground-level navigation) is *experimental*.
- **`TimeController`** — play/pause/rate/scrub
- **Stock plugins** — `TrajectoryColorPlugin`, `ManeuverVectorPlugin`, `CommLinkPlugin`, `ScreenshotPlugin`. `GroundTrackPlugin` is planned.

## Install

```bash
npm install @cosmolabe/three @cosmolabe/core @cosmolabe/spice three
```

`three` is a peer dependency.

## Quick example

```ts
import { Universe } from '@cosmolabe/core';
import { UniverseRenderer } from '@cosmolabe/three';

const universe = new Universe({ spice });
const renderer = new UniverseRenderer({
  universe,
  container: document.getElementById('viewer')!,
});

renderer.use(new TrajectoryColorPlugin({
  segments: [{ bodyName: 'Cassini', startEt, endEt, color: '#ff8800' }],
}));

renderer.start();
```

## Custom plugin

```ts
import type { RendererPlugin, RendererContext } from '@cosmolabe/three';

export class RadarSwathPlugin implements RendererPlugin {
  name = 'radar-swath';
  onSceneSetup(ctx: RendererContext) {
    this.mesh = new THREE.Mesh(swathGeometry, swathMaterial);
    ctx.attachToBody('Spacecraft', this.mesh, { followRotation: true });
  }
  onBeforeRender(et: number, ctx: RendererContext) {
    const alt = computeAltitude(ctx.universe.getBody('Spacecraft')!, et);
    this.mesh.scale.set(alt * 0.1, alt * 0.4, 1);
  }
}
```

## License

Apache-2.0. See [LICENSE](https://github.com/AaronPlave/cosmolabe/blob/main/LICENSE) and [NOTICE](https://github.com/AaronPlave/cosmolabe/blob/main/NOTICE).
