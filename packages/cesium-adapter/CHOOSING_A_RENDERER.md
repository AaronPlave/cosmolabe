# Choosing a Renderer

Cosmolabe supports two rendering approaches: the built-in Three.js viewer (`@cosmolabe/three`) and CesiumJS integration via `@cosmolabe/cesium-adapter`. This guide helps you choose the right one.

## When to use the Three.js Viewer (`@cosmolabe/three`)

- **Multi-body solar system visualization** — planets, moons, spacecraft in one scene
- **Deep space missions** with interplanetary trajectories (Cassini, Europa Clipper, etc.)
- **Custom rendering** — eclipse shadows, atmospheric scattering, ring rendering, sensor frustums
- **Full control** over materials, shaders, and post-processing
- **Any mission that spans multiple gravitational bodies**
- **Terrain streaming** — 3D Tiles, quantized-mesh, Cesium Ion, with WMS/WMTS/TMS/XYZ imagery overlays

The Three.js viewer is Cosmolabe's primary renderer. It handles cosmic scales (logarithmic depth, camera-relative rendering), arbitrary reference frames, and multi-body scenes that Cesium cannot.

## When to use CesiumJS (via `@cosmolabe/cesium-adapter`)

- **You already have a Cesium-based ground system** and want to feed Cosmolabe ephemeris data into it
- **You need geospatial formats** — KML, GeoJSON, GPX, CZML load natively in Cesium
- **Your audience expects the Cesium interface** — the "Google Earth"-style globe they already know
- **Ground-clamped visualization** — polygons and polylines that automatically follow terrain

The adapter is a **library you drop into your own Cesium app**, not a standalone viewer. It exports CZML documents or live Cesium Property objects from Cosmolabe's Universe model.

## When you might use both

- **Mission planning**: Cesium for launch/early ops (ground stations, coverage analysis), Three.js for cruise/science phase (multi-body geometry)
- **Side-by-side**: the same catalog JSON loads in either viewer
- **Briefings**: Cesium for stakeholders who want geographic context, Three.js for trajectory/geometry analysis

## What the adapter provides

| Module | Purpose |
|---|---|
| `TimeConversions` | ET (seconds past J2000) ↔ Cesium JulianDate / ISO strings |
| `CoordinateTransforms` | J2000 Ecliptic (km) ↔ ICRF Equatorial (meters) |
| `ModelAdapter` | Extract glTF/GLB model info from Cosmolabe bodies |
| `CzmlExporter` | Generate complete CZML documents from a Universe |

## Quick start

```typescript
import { Viewer, CzmlDataSource } from 'cesium';
import { Universe, CatalogLoader } from '@cosmolabe/core';
import { exportToCzml } from '@cosmolabe/cesium-adapter';

// Your existing Cesium viewer
const viewer = new Viewer('cesiumContainer');

// Cosmolabe data pipeline (same as Three.js viewer)
const universe = new Universe(spice);
universe.loadCatalog(catalogJson);

// Export to CZML and load into Cesium
const czml = exportToCzml(universe, {
  startEt: 0,
  endEt: 86400 * 7,
  sampleInterval: 300,
  centerBody: 'Earth',  // positions relative to Earth
});
viewer.dataSources.add(CzmlDataSource.load(czml));
```

## Limitations

- Cesium is fundamentally single-central-body. Multi-body solar system scenes are a Three.js viewer strength.
- CMOD models (Cosmographia's proprietary format) are not supported in Cesium. glTF/GLB works natively.
- Deep-space sensor frustum visualization works better in the Three.js viewer. Cesium excels at Earth-intersecting sensor footprints/coverage analysis instead.
