# Exposure and HDR display contract (issue #212)

Status: **incremental reference-exposure foundation**, not a completed scene-wide HDR compositor.
This deliberately leaves the existing catalog appearance unchanged unless a viewer
or application explicitly opts in to fixed-reference exposure. It also keeps
renderer-local rendering/compositing work under #134/#210 and instrument
rendering under #194, rather than claiming those are solved.

## 1. Terms and numerical conventions

| Signal | Convention |
| --- | --- |
| Photosphere | Relative RGB center radiance `(3.2, 3.08, 2.88)`. Broadband illustration, **not** SI spectral radiance or detector input. |
| Incident solar irradiance | `center * 0.8 * pi * (R_sun / d)^2`. The 0.8 is the disk-averaged linear limb profile. Irradiance varies as inverse square of source distance. |
| Atmospheric single/multiple scattering and sky-view LUT | Linear RGB values derived from that source irradiance. Preset extinction is in inverse kilometers; LUT outputs are relative RGB radiance. |
| Sun source for glare | Linear half-float, before display response. Disk signal is integrated with explicit source-footprint treatment. |
| Display exposure | Dimensionless multiplier of the relative linear radiance signal before the response curve. It is **not** an ISO/shutter/aperture simulation. |
| Response | `0.94 * max(0, radiance * exposure) / (1 + max(0, radiance * exposure))`, independently per RGB channel. |
| Final canvas | Three.js sRGB output encoding with renderer `NoToneMapping`. Sun and atmosphere shaders already apply their local response; enabling another renderer tone mapper would double-map them. |
| Star catalogue | HYG apparent magnitude and approximate B–V chromaticity, not absolute RGB radiance/detector response; actual #218 flux/PSF work is separately tracked. |

A renderer configuration using `solarExposure: { mode: 'fixed-reference' }`
uses `1 / solarIrradiance(1 AU)[0]` as one immutable display
multiplier. It applies to the photospheric disk, shell atmospheric scattering
and globe/terrain aerial-perspective inscatter. The **same** linear source input
produces the **same** output at any camera location or epoch. Physical solar
irradiance still falls with Sun-to-body distance: at Titan (9.5 AU) the
atmosphere should be much dimmer at fixed exposure than at 1 AU.

The default `{ mode: 'legacy-observer-adapted' }` preserves existing
visualization: the response multiplier is recalculated from
camera-to-Sun irradiance. This keeps outer-system haze similar in appearance to
1 AU haze, matching the separately normalized lighting on many body textures,
but is *not* a fixed scientific reference. Moving away from the Sun can
brighten the relative scene display even if no physical radiance increased.
Do not use this legacy mode for comparative photometric images.

No auto-exposure histogram, smoothing, camera cut detection, flight-dependent
boost or temporal adaptation is present. Do not silently introduce any.

## 2. Current render-path inventory and known mismatches

| Path | Scene target / transform | Present limitation |
| --- | --- | --- |
| Normal body meshes and illuminated terrain | Normal Three materials render directly to canvas with material `outgoingLight`, built-in color-space conversion; renderer tone mapping explicitly off | Material illumination is not currently converted into the same solar relative-radiance units as atmospheric scattering. Baked and archival imagery is not calibrated reflectance. |
| `AtmosphereMesh` | CPU/LUT sunlight and scattering, local `radianceToDisplay`, sRGB output; drawn in the normal scene layers | Tone response happens **before** final scene composition, including alpha blending with rendered surfaces; linear radiances from sky and surface are not composited in one HDR buffer. |
| `AerialPerspective` | Adds `radianceToDisplay(solarIrradiance * inscatter)` into material `outgoingLight`, with transmitted surface light; ordinary material output after that | Mixes a pre-toned atmospheric component with a material-light component. Fix requires pre-tone radiance composition, not another preset color adjustment. |
| `SunVisual` | Dedicated SOLAR_LAYER disk after atmosphere shells; extinction before response; `toneMapped: false`, sRGB display encoding | Resolved limb response is deliberately applied before multiplying limb profile to preserve contrast. This is a visual exception, not full linear composition. |
| `SunGlareEffect` | HalfFloat HDR source + reduced blur targets; additive composite onto canvas | PSF signal precedes tone mapping, but halo output currently adds to an already mapped scene. It is not a unified pre-tone radiance composite. Solar optical source is isolated from scientific overlays. |
| `BloomEffect` | HalfFloat UnrealBloomPass composer using selective layer 3; additive overlay | Separate emissive response and threshold; overlays are excluded unless explicitly marked eligible. This is presentation bloom, not calibrated optics. |
| `StarField` | Additive point sprites, separate normalized magnitude->perceptual brightness and scalar sky fade | No common linear photon/flux contract yet (#218); no per-ray atmospheric extinction (#219). Do not treat this as a true sky exposure. |
| `InstrumentView` | Separate viewport, direct render of scene layers 0/1 | Not the same full multi-pass physical pipeline; misses SOLAR_LAYER, camera-relative tiles and many optional effects (#194). Atmosphere observer LUTs are switched/restored, but scene appearance cannot yet be equated to main-camera calibrated capture. |
| Lines, contours, geographic features, UI | Distinct overlay, canvas or material paths, generally composited after the physical scene | **Keep annotations out of physical HDR/glare and automatic exposure**; they need display-legibility semantics rather than photometric semantics. |

For the active default WebGL renderer there is **no second renderer-level
tone map**: Three.js toneMapping is `NoToneMapping` and sRGB output is used.
The current hazard is instead *inconsistent premapping and blending*: raw
material lighting, pre-toned atmospheric terms and linear HDR blur are mixed at
different stages. Adding ACES to the renderer without moving the material
response would make this worse.

Specific atmosphere coefficients and cloud/terrain preset appearance remain
owned by their existing models. Do not modify Earth, Venus, Mars or Titan
coefficients to hide output-stage inconsistencies.

## 3. Small fixed-response comparison

For `x = max(0, linearSignal * fixedExposure)`, the existing response can be
compared numerically with a common ACES-fit candidate and simple linear clipping.
This **does not** establish that ACES has better physically faithful color;
per-channel filmic curves may shift hues or obscure faint limb/terminator detail.

| x | Current `0.94 x/(1+x)` | ACES fit (illustrative) | `min(x,1)` |
| ---: | ---: | ---: | ---: |
| 0 | 0 | 0 | 0 |
| 0.01 | 0.00931 | 0.00377 | 0.01 |
| 0.1 | 0.08545 | 0.12584 | 0.1 |
| 1 | 0.47000 | 0.80380 | 1 |
| 4 | 0.75200 | 0.97342 | 1 |
| 16 | 0.88471 | 1.00000 | 1 |

For now **retain Reinhard**. The numerical shoulder preserves highlight
headroom and avoids unexpectedly changing all planetary presets. Any later
curve selection belongs in the common *final* display transform after all
physical light has been combined, not copied into per-shader curves.
Contrast, surface visibility and stellar detectability require actual matched
GPU captures before selecting another curve.

## 4. Reference captures and API

Applications can opt in at construction or switch at runtime:

```ts
new UniverseRenderer(canvas, universe, {
  solarExposure: { mode: 'fixed-reference' },
});
// or after construction:
renderer.setSolarExposurePolicy({ mode: 'fixed-reference' });
// To bracket exposures without rescaling source data:
renderer.setSolarExposurePolicy({ mode: 'fixed-reference', exposure: 10000 });
const metadata = renderer.getSolarExposureMetadata();
```

The Svelte viewer has `?solarExposure=fixed`, including in
`?test=1&solarExposure=fixed` captures. Its test hook reports
`getExposureMetadata()`. The metadata records the mode, fixed multiplier,
response name, units convention and 1 AU reference distance. For legacy
observer-adapted mode `exposure=null` intentionally warns the viewer that
no single reproducible multiplier was used.

Capture *identical poses and epochs* with the legacy and fixed settings,
holding camera FOV, viewport, DPR, bloom toggle, source catalogs, asset-settled
state, render settings and texture/terrain revisions constant. Required
before/after matrix (not yet captured in this foundational change):

1. Earth: daylight orbit, low-altitude horizon, sunrise/sunset and an eclipsed
   surface. Verify warm solar disk/extinction, twilight and day/night contrast.
2. Mars: surface twilight and orbital terminator. Keep dust coefficients fixed.
3. Titan at 9.5 AU: front/back limb and daylight surface, using the *same*
   fixed exposure as Earth. Also compare current legacy scene normalization.
4. Airless Moon: sunlit relief, dark side and complete solar occultation,
   checking no solar glare behind actual foreground terrain.
5. Stars: sunlit Earth/Moon background, lunar night/dark space, a fixed-exposure
   sweep and transitions; only claim quantitative stellar results after #218.
6. Main vs instrument: identical observer and FOV for the same scene, with
   image differences identified under #194, never labeled an actual camera
   simulation.

The unit tests in `SolarRadiometry.test.ts` cover fixed vs legacy distance
behavior, invalid multipliers, metadata and monotonic response sweeps.
They **do not** replace the GPU image comparisons above.

## 5. Required compositor migration (remaining work)

Target, after validating performance/depth integration with #210:

```text
Physical source radiance (Sun / stars) + reflected surface radiance
    + atmospheric scattering / extinction at the correct observer
    -> linear scene HDR accumulation with depth, alpha and transparent
       geometry conventions defined
    -> optional physical optical PSF / glare in pre-display linear space
    -> *one* fixed exposure and chosen tone response
    -> sRGB output encoding
    -> UI/geometric annotations and display-only accents
```

Keep full-resolution scene, logarithmic depth, near-camera surface tiles,
planet/surface masking, moon-terrain occultation and instrument observer
state compatible with WebGL; avoid mandatory WebGPU. Only introduce
full-size half-float HDR scene/depth buffers after measurements. A
1920x1080 RGBA16F target consumes ~15.8 MiB for color *alone* (before
depth or ping-pong); multiple buffers and tile scenes matter on WebGL.

Future work must preserve legacy catalog meaning: opt-in fixed
reference first, then paired screenshot migration and an explicit
versioned/default policy switch **after** reference comparisons.
Legacy atmosphere/lighting parameters must not be silently reinterpreted
as SI photometric measurements. Scientific detector/image synthesis is
a different feature from presentation rendering.

**Acceptance still outstanding:** scene-wide HDR accumulation, combined
physical response for stars and standard materials, transparent-object order,
matched fixed-view GPU captures, and actual GPU memory/frame-time results.
The issue should remain open until those gates have evidence.
