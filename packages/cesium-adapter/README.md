# @cosmolabe/cesium-adapter

Standalone bridge between [Cosmolabe](https://github.com/AaronPlave/cosmolabe) and CesiumJS. Coordinate and time conversions plus CZML export — **the cesium peer dep is optional**, so you can also use this package as a build target without shipping the renderer.

For renderer-side primitives (body entities, surface points, comm links), see [`@cosmolabe/cesium`](../cesium).

For guidance on which renderer fits your project, see [CHOOSING_A_RENDERER.md](./CHOOSING_A_RENDERER.md).

## What's in here

| Module | Purpose |
|---|---|
| `TimeConversions` | ET (seconds past J2000) ↔ Cesium `JulianDate` / ISO strings / Julian components |
| `CoordinateTransforms` | J2000 ecliptic (km) ↔ ICRF equatorial (m); geodetic ↔ Cartesian; quaternion conversions |
| `CzmlExporter` | Generate complete CZML documents from a `Universe` for time-stamped playback in any Cesium viewer |
| `ModelAdapter` | Extract glTF / GLB model info (offsets, scales, articulation) for Cesium entity setup |

## Install

```bash
npm install @cosmolabe/cesium-adapter @cosmolabe/core
# optional: cesium  (only needed for live Property objects, not CZML export)
```

## Quick example

CZML export (no Cesium runtime needed):

```ts
import { CzmlExporter } from '@cosmolabe/cesium-adapter';

const czml = new CzmlExporter(universe).export({
  startEt, endEt, stepSeconds: 60,
});
fs.writeFileSync('mission.czml', JSON.stringify(czml));
```

Time / coordinate conversions:

```ts
import { etToDate, eclipticToEquatorial } from '@cosmolabe/cesium-adapter';

const date = etToDate(et);                    // → JS Date
const equatorial = eclipticToEquatorial(pos); // → ICRF Cartesian (m)
```

## License

Apache-2.0. See [LICENSE](https://github.com/AaronPlave/cosmolabe/blob/main/LICENSE) and [NOTICE](https://github.com/AaronPlave/cosmolabe/blob/main/NOTICE).
