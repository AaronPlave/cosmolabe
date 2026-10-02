# Atmosphere validation baseline (issue #134)

The three `atmosphere-*` test catalogs fix the planet, Sun, clock, and camera.
They need no SPICE kernels or network assets. The Earth and Mars catalogs use
surface, horizon, ascent, orbit, and whole-disc viewpoints. The twilight
catalog puts the Sun 3° above the local horizon and captures the sunward sky
and terminator disc. These views are deliberately plain: visual changes come
from the atmosphere and body materials rather than imagery.

Run the focused comparison against a local viewer server:

```sh
npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5174
CL_VIEWER_URL=http://127.0.0.1:5174 VR_SCENES=atmosphere-earth,atmosphere-earth-twilight,atmosphere-mars node scripts/visual-regression.mjs
```

`VR_PROFILE=1` repeats each capture seven times and reports the median of six
warm frames. The reported time includes JavaScript, draw submission, and PNG
GPU readback, so it compares the whole capture path rather than isolating an
atmosphere GPU pass. Use the same browser and machine for before/after timings.
The images live in `apps/viewer/test-screenshots/__goldens__/` and should be
reviewed before updating them.

## Starting measurements

On 2026-10-02, local Chromium SwiftShader at 1024×768, six warm frames:

| View | Median capture + readback |
| --- | ---: |
| Earth surface zenith | 101 ms |
| Earth surface horizon | 112 ms |
| Earth ascent 50 km | 118 ms |
| Earth orbit 400 km | 193 ms |
| Earth whole disc | 127 ms |
| Earth sunward horizon, Sun +3° | 121 ms |
| Earth terminator disc, Sun +3° | 256 ms |
| Mars surface zenith | 104 ms |
| Mars surface horizon | 170 ms |
| Mars orbit 400 km | 147 ms |
| Mars whole disc | 84 ms |

The current proxy uses `SphereGeometry(1.15, 1024, 512)`: 525,825 vertices.
Its vertex shader runs an eight-step view integral, or about 4.21 million
view samples per atmosphere draw. The orbit path adds an eight-step fragment
integral. These are workload counts, not GPU timings.

The baseline images show a bright strip at the horizon, a sharp terminator,
and no orbital atmosphere over the body disc. They establish regression views,
not approved target colors. Later phases should add low-Sun and terrain views
once the shared transmittance path can render them usefully.
