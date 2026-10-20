# PR #263 review follow-up

## Ordinary imagery and physical normals

Skipping the 0.6 sphere-normal blend on configured cube products is intentional,
including when Surface Appearance is off. This changes the default cube imagery
lighting relative to `main`. Cube products already contain central-difference
normals computed from the same height field, with shared geographic stencils
and skirt copies (`dem.py`'s `cube_normals` and `encode_glb`). Preserving them
retains the authored terrain slopes; applying the quantized-mesh smoothing
reduces those slopes toward a smooth sphere. Artificial hillshade still uses
its separate relief-normal attribute.

The old helper assumes the tile centre is on `mesh.position`, and ignores
ancestor transforms. The current builder does put its translation on that
mesh and rotates positions/normals together into glTF Y-up. A rigid root
rotation alone does not make the blend wrong for this layout. We therefore
describe this as an intentional choice of authored physical normals, **not a
demonstrated transform bug in the current product**. Quantized-mesh smoothing
is unchanged. Sun position/direction, materials, imagery, geometry, tile
selection, CPU grids and measurement data are unchanged by this choice.

Actual independent viewers ran `main` at `890f655c` and the PR runtime at
`552846be` (plus explanatory comments only), with the same local products and
hardware ANGLE Metal on Apple M4 Max. Module URLs in the raw results confirm
each loaded its own `TerrainManager.ts`. Every pair has identical source
terrain tile IDs, camera matrices and exact catalog epoch
`2028-12-15T10:04:00Z`, with Surface Appearance disabled and natural Sun intensity
2. Close/far use the original acceptance poses. The extra lit polar view looks
from latitude -88.7°, altitude 12 km toward -89.4°, height -2.5 km, along the
actual subsolar longitude, at 60° FOV. It uses real Sun lighting, without moving
the Sun or substituting an artificial light.

| Product / view | Main ordinary imagery | PR ordinary imagery |
| --- | --- | --- |
| NAC close | [main](baseline/main/nac-close.png) | [PR](baseline/pr/nac-close.png) |
| NAC far | [main](baseline/main/nac-far.png) | [PR](baseline/pr/nac-far.png) |
| NAC lit polar | [main](baseline/main/nac-lit.png) | [PR](baseline/pr/nac-lit.png) |
| MoonFall close | [main](baseline/main/moonfall-close.png) | [PR](baseline/pr/moonfall-close.png) |
| MoonFall far | [main](baseline/main/moonfall-far.png) | [PR](baseline/pr/moonfall-far.png) |
| MoonFall lit polar | [main](baseline/main/moonfall-lit.png) | [PR](baseline/pr/moonfall-lit.png) |

The expected effect is stronger slope-dependent lighting, including brighter
Sun-facing slopes and darker slopes turned away from the Sun. The inspected
captures retain the same terrain outlines and crater/imagery placement. The
sampled mean normal slope relative to radial up in the lit view changes from
1.89° to 4.72° for NAC and 3.57° to 8.94° for MoonFall. These are checks of the
chosen normal field, not independent DEM accuracy measurements. Source imagery
already contains lighting; this comparison does not correct baked lighting or
prove photometric accuracy. Coarse/mixed-LOD polar artifacts remain under #182.

NAC close/lit have different distant fallback imagery cache levels across the
independent viewers; cache counts alone cannot establish which pixels changed. To isolate the
normal change, the PR harness also stops animation,
applies the exact legacy `blendSphereNormals(mesh, 0.6)` to source meshes,
rebuilds imagery blocks, captures, restores the saved normals and rebuilds
again. All six controls keep imagery request counts and displayed level counts
identical, with **zero changed pixels after normal restoration**. Applying the
legacy blend also reproduces the actual independent main capture with **zero
changed pixels in all six views** (threshold 0.01), despite those cache counts. At threshold
0.01, the lit controls change 814,969 NAC pixels and 882,220 MoonFall pixels.
See the fixed-cache [NAC legacy blend](baseline/pr/nac-lit-legacy-control.png)
and [normal difference](baseline/controls/nac-lit-normal-diff.png), and the
[MoonFall legacy blend](baseline/pr/moonfall-lit-legacy-control.png) and
[normal difference](baseline/controls/moonfall-lit-normal-diff.png).

Raw [main results](baseline/main/results.json), [PR results](baseline/pr/results.json)
and [comparison](baseline/comparison.json) retain all six controls, source URLs,
camera matrices, epoch, tile IDs, imagery levels and normal samples. The
regression now uses deliberately sloped builder normals: material setup must
preserve them before capability metadata loads, after eligibility validation,
and through style on/off. The old unconditional blend fails this assertion.

## First-use latency

The hitch remains unresolved in #260 and is explicitly tracked in
[#264](https://github.com/AaronPlave/cosmolabe/issues/264). Warm rendering is not
first-use acceptance. The updated harness measures nested CPU wall time around
`SurfaceAppearance.update`, `CubeImageryLayer.update` and WebGL `render`, fences
each frame and records GPU timer queries. The imagery stage includes block
clipping/geometry/material construction; the render stage includes submission,
compilation and uploads without separating their individual costs.

| Product / CPU | First frame CPU | Field preparation | Imagery update | WebGL render |
| --- | ---: | ---: | ---: | ---: |
| NAC native | 61.9 ms | 6.6 ms | 41.7 ms | 13.3 ms |
| MoonFall native | 62.5 ms | 7.3 ms | 40.6 ms | 13.7 ms |
| NAC 4x throttle | 241.4 ms | 26.4 ms | 174.3 ms | 39.4 ms |
| MoonFall 4x throttle | 240.5 ms | 27.9 ms | 177.6 ms | 30.8 ms |

Native maximum activation frame CPU was 64.5 ms / 62.5 ms; warm styled medians
were 1.8 ms / 2.4 ms. At 4x, maxima were 241.4 ms / 240.5 ms and warm medians
7.5 ms / 10.3 ms. Disable maxima were 44.8 ms / 45.7 ms native and 189.1 ms /
188.4 ms at 4x. Raw [native samples](activation-review-native.json) and
[4x samples](activation-review-4x.json) include every frame and preparation count.

The soft 4 ms budget covers only field preparation and yields between atomic
tiles. It does not cover imagery reconstruction or render work. The dominant
measured stage is imagery update: field identity/version changes reconstruct
blocks, repeating clipping of position/normal/UVW/index data that did not
change. Shared neighbour-normal updates can trigger further rebuilds.

A robust reduction needs reusable clipping interpolation stencils, updates of
only changed style fields, memory/eviction accounting, and scheduling across
preparation and propagation. Simply limiting how many blocks change per frame
would require coherent fallback materials and cancellation/LOD handling to
avoid stale fields. That lifecycle/performance work is deferred to #264 rather
than folded into this capability extension. Remaining compilation/upload cost
also needs profiling after the dominant reconstruction cost is removed.

The follow-up includes native/4x comparisons, activation and disable long-task
targets, restoration/LOD regressions and a **physical midrange phone/tablet
benchmark**. The 4x result here simulates a slower CPU on the desktop GPU; it
does not establish physical mobile performance. #182 stays open.

## Validation and reproduction

Review checks: 43 tests pass across `SurfaceAppearance`, `TerrainManagerCube`,
`CubeImageryLayer` and viewer range picking; package build, test TypeScript,
changed TypeScript ESLint, script syntax and diff checks pass. Six independent
baseline pairs and six fixed-cache legacy controls pass with no page/shader
errors. Existing full-mode/mobile acceptance and earlier broad-suite limits
are recorded in the [original report](README.md).

Run separate main/PR viewers against the same local products. When another
viewer already runs in a checkout, use a separate Vite cache directory to
avoid dependency-cache collisions. The main checkout needs its own workspace
package resolution and current dependencies; only data/binary assets may be
shared. Do not resolve its `@cosmolabe/three` import to the PR source.

```sh
CUBE_STYLE_BASELINE_ONLY=1 CUBE_STYLE_URL=http://127.0.0.1:5197 \
  CUBE_STYLE_OUT=work/cube-surface-appearance/baseline-main \
  node scripts/test-cube-surface-appearance.mjs
CUBE_STYLE_BASELINE_ONLY=1 CUBE_STYLE_LEGACY_CONTROL=1 \
  CUBE_STYLE_OUT=work/cube-surface-appearance/baseline-pr \
  node scripts/test-cube-surface-appearance.mjs
node scripts/compare-cube-surface-baselines.mjs \
  work/cube-surface-appearance/baseline-main \
  work/cube-surface-appearance/baseline-pr \
  work/cube-surface-appearance/baseline-comparison
CUBE_STYLE_ACTIVATION_ONLY=1 CUBE_STYLE_CPU_RATE=4 \
  CUBE_STYLE_OUT=work/cube-surface-appearance/profile-4x \
  node scripts/test-cube-surface-appearance.mjs
```
