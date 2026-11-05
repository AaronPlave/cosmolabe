# StarField photometry, catalog provenance and validation (#218)

## Input data and celestial coordinates

The default `stars.bin` is compiled by `scripts/build-star-catalog.mjs` from
the [HYG stellar database mirror](https://www.datastro.eu/), using the API
fields `ra` (decimal hours), `dec` (degrees), `mag` (apparent visual
magnitude) and `ci` (B–V). The build's selection is **magnitude < 6.5**.
The current build script fetches the remote dataset dynamically and **does not
pin or embed a HYG source revision**. Therefore its exact source release
cannot be asserted from `STR2` alone; a reproducible rebuild should pin
the source dataset/checksum in a separate provenance upgrade.

Coordinates are treated as equatorial **J2000** and rotated by the J2000
obliquity, 23.4392911°, to **ECLIPJ2000** unit directions. Star positions
are held fixed over the simulated timeline: no proper-motion, parallax,
precession-of-date, aberration, or variable-star modeling. The apparent
magnitude is also time invariant. Positions are packed as 3 signed 16-bit
direction components. The v2/STR2 binary header is 16 bytes (magic, count,
brightest/faintest magnitudes), followed by 10 bytes per star (3 int16 xyz,
1 uint8 magnitude mapped to the header range, 3 uint8 linear RGB).
The v1/STAR reader remains supported with its 20-byte records.

B–V is converted to a blackbody-temperature *approximation* and packed as
relative linear-sRGB chromaticity. This is not measured spectral irradiance,
not calibrated RGB photometry, and not a spacecraft sensor simulation.
The renderer normalizes RGB by its linear Rec.709 luminance to preserve
a magnitude-to-relative-luminance relationship; the resulting color is
an illustrative chromaticity.

## Rendering and units

Magnitude-to-flux is `F(m) = 10^(-0.4*m)`. A magnitude increase of 2.5
reduces flux by a factor of 10. All catalog stars use a **common normalized
Gaussian PSF**, without a cosmetic minimum visible disc, magnitude-based size
boost, synthetic scintillation, or diffraction spikes.

For the current display sampling contract, a star contributes total
**pre-tone linear signal per CSS-pixel image** of
`linearFluxScale * F(m)`. The default provisional scale is `0.6`, selected
by the fixed-output calibration below; explicit caller values still override it.
The PSF sigma is 0.875 CSS pixels by default. At DPR `d`, the shader draws
a Gaussian with sigma `d * sigmaCSS` physical pixels and weights the
per-pixel signal by `d²`. Summing physical-pixel values with area `1/d²`
preserves the same CSS-pixel integrated signal across DPR; the normalized
kernel keeps this stable under subpixel translation. This defines a
**viewer display sampling convention**, not absolute radiance or angular
sensor resolution. A future instrument sensor PSF is separate (#194).

The `maxSize` legacy option is preserved as an optical PSF spread control
(`sigmaCSS = clamp(maxSize/4, 0.7, 2.5)`), rather than independently
boosting the brightness of bright stars. `magLimit` still filters the input
before GPU upload. Relative flux calculations remain magnitude-based and are
not changed by the PSF's footprint.

The `setLinearFluxScale` hook is deliberately **fixed and global**; it does
not adapt to camera orientation, FOV, or bright surfaces. It must be connected
to #212's common exposure/radiance-to-display contract rather than growing
into a second star-only exposure algorithm. The shader uses Three's regular
tone-mapping/output color-space chunks; **this does not by itself provide
the shared linear HDR accumulation/blend pipeline** requested by #212.
For now, comparisons of true integrated flux use the **pre-tone** analytic
kernel, not additive pixels read back from a tone-mapped sRGB framebuffer.
`setSkyBrightness` remains the previous scalar atmospheric fade to avoid
breaking current scenes; direction-dependent extinction is tracked in #219.

Stars are inertial camera-translation-free points at the far depth, leaving
physical geometry to occlude them via the depth buffer. SunVisual and its
bloom/glare path are not involved. Star catalogs fail *closed*: no URL, 404,
corrupt magic, truncated header/records, invalid directions/counts or bad
magnitude metadata do not generate replacement directions. The public
`getCatalogStatus()` reports unconfigured/loading/ready/error and the
console logs a concise failure diagnostic. Any synthetic benchmark fixture
belongs in tests and is never shown in the production viewer.

The constructor's `magLimit` remains the default across `loadCatalog(url)`
reloads. `loadCatalog(url, { magLimit })` overrides it for that request only.
Both binary formats require unit directions before normalization: STR2's
length tolerance is `sqrt(3)/(2*32767) + 1e-7`, bounded by component rounding;
legacy float32 directions allow `1e-6`. Materially nonunit vectors fail even
when their magnitude would otherwise filter them out.

## Verification

Unit tests: `npx vitest run packages/three/src/__tests__/StarField.test.ts`.
The fixture measures 10:1 pre-tone integrated flux for magnitudes 0 and 2.5,
DPR 1/2, subpixel phases, STR2/STAR parsing, corrupt catalogs, missing
assets, lifecycle/disposal, persistent reload limits, and shader hook construction.
It also loads all 8,826 shipped records and checks the brightest direction
against Sirius's independent J2000 RA/Dec (06h45m08.9173s, -16°42′58.017″;
V approximately -1.46, versus -1.44 in the shipped HYG catalog). Position
tolerance is 0.005°, allowing int16 packing; magnitude tolerance is 0.04.

Run actual browser readback with `npm run test:stars:webgl` (install Chromium
with `npx playwright install chromium`, or set `CL_CHROMIUM` to its executable).
The script starts/stops its own Vite server, exercises the production
StarField shaders and writes `/tmp/starfield-webgl/readback.json` and
`catalog-scale-*.png`; `CL_STAR_OUTPUT` selects another directory. CI runs it and
uploads a `starfield-webgl` artifact. It verifies:
- Float-target integrated flux and centroids at DPR 1/2, 128/192 CSS-pixel
  viewports, 1°/60°/120° FOV and subpixel offsets, including 10:1 magnitude pairs.
- The actual 8-bit sRGB default framebuffer against a Gaussian + sRGB
  quantization reference (within one code value). A 16-phase pan measures
  magnitudes -1.44, 0, 2.5, 3, 4, 5 and 6.5 at scales 0.06/0.3/0.6 under
  both the viewer's default no-tone-mapping output and ACES at renderer exposure 1.
- Visible-output regressions for the production default: magnitude 3 peaks
  at least 16/255 on black, magnitude 4 at least 7/255, and recovered linear
  signal through magnitude 4 stays within 10% of its expected integral
  across every sampled DPR/subpixel phase. This guard fails with default 0.06.
- Camera-translation invariance, behind-camera rejection, opaque sphere and
  displaced mesh occlusion with logarithmic depth enabled, and the real catalog.

### Fixed-output display calibration (2026-10-21)

The original 0.06 normalization failed visual acceptance: even magnitude-3
stars were only 2–3 sRGB code values above black, and magnitudes 5/6.5 vanished.
We compared 0.06, 0.3 and 0.6 with **the same PSF, camera, catalog and output**.
The default is now **0.6**, the smallest tested scale meeting the visible-output
guard above. It restores reasonably bright naked-eye stars while retaining a
restrained sky around sunlit globes. This is a provisional display normalization,
not an absolute photometric/exposure calibration or a claim that every catalog
star should be visible.

Chromium 151 / ANGLE SwiftShader: 96 float and 1,344 display readbacks passed.
Maximum relative pre-tone flux error was 0.00093%; maximum centroid error was
0.013 CSS pixels. Magnitude-pair flux remains 10:1 before tone mapping. The
8-bit no-tone-mapping reference differs by at most one code value.

| Scale | Magnitude | Peak sRGB byte, DPR 1/2 phases | Signal swing, DPR 1 | Signal swing, DPR 2 |
| --- | --- | --- | --- | --- |
| 0.06 | 3 | 2–3 | 20.7% | 9.5% |
| 0.3 | 3 | 10–13 | 9.7% | 2.4% |
| **0.6** | **3** | **19–23** | **4.3%** | **2.5%** |
| 0.06 | 4 | 1 | 31.7% | 14.4% |
| 0.3 | 4 | 4–6 | 9.2% | 6.2% |
| **0.6** | **4** | **8–11** | **6.1%** | **5.1%** |

Signal swing is `(max - min) / expectedPreToneSignal` across 16 pan phases,
after converting the framebuffer sRGB bytes back to linear values. With 0.6,
magnitude-4 recovered signal is 0.01413–0.01504 (DPR 1) and 0.01415–0.01492
(DPR 2), versus expected 0.015071. The magnitude-zero star peaks at 89–102/255,
without saturating, at the unchanged sigma of 0.875 CSS pixels.

The actual viewer uses `NoToneMapping` and sRGB output. We record renderer
exposure 1, although Three's no-tone-mapping path does not apply that property.
The fixed signal normalization is therefore the operative gain. ACES at
exposure 1 is measured as an alternative output diagnostic; it still suppresses
faint stars, and we do not adapt star gain to the tone mapper. Accumulation still
occurs in the existing display framebuffer; #212 owns shared linear HDR blending.

For repeatable full-viewer captures, start the normal viewer on port 5188 and run
`npm run capture:stars` (`CL_CHROMIUM`, `CL_VIEWER_URL`, `CL_STAR_OUTPUT` optional).
The script uses ET **773366400**, exposure **1**, a fixed camera per pose, all
three trial scales, 800×600/1280×720 CSS viewports and DPR 1/2. It writes the
60 before/trial/after PNGs and `matrix.json` to `/tmp/starfield-viewer`. CI also
runs the 800×600 DPR-1 subset (`CL_STAR_SMOKE=1`) and uploads it with WebGL evidence.

Poses are the existing textured Earth whole disc, Saturn clouds/rings, a
sunlit textured Moon globe (geographic overlays hidden), dark sky and 1° sky.
Sky poses also include an eight-phase subpixel pan at 0.6. Detection is measured
against a no-stars baseline: magnitude ≤3 needs a peak delta ≥16 bytes;
magnitude ≤4 needs ≥7. In the 800×600 dark-sky view at DPR 1, the scales yielded:

| Scale | Detected through magnitude 3 | Detected through magnitude 4 |
| --- | --- | --- |
| 0.06 | 4 / 22 | 9 / 67 |
| 0.3 | 19 / 22 | 51 / 67 |
| **0.6** | **22 / 22** | **67 / 67** |

The same 0.6 counts hold at DPR 2. Foreground-occluded stars are excluded from
this sky-only guard, not artificially shown through bodies. Sunlit-scene
captures retain the same global scale; no body-, direction- or FOV-driven gain
is introduced. [Before/trial/after and sunlit screenshots](../../docs/validation/starfield/README.md)
are checked in for review; the full capture script preserves the original pixels.

At magnitude 6.5, peaks remain around one code value, with substantial relative
quantization variation. This is a real residual limit near the catalog cutoff,
not a claim of stable instrument photometry. No brightness floor, inflated PSF,
temporal dither, synthetic twinkle or auto exposure is added. Software WebGL
captures do not certify physical GPU/mobile performance or streamed lunar
terrain (absent here). Keep the PR draft pending review of the visual results
and the remaining physical-device/terrain/instrument acceptance matrix.

Manual GPU/visual acceptance still needed on a real browser/WebGL device:
- Fix camera, time and display exposure across screenshot runs; compare a
  dark empty sky, Earth orbit, sunlit Moon with terrain, Saturn, and
  instrument narrow FOV. Check visibility of faint stars against bright
  surfaces before/after the scene-wide #212 exposure change.
- Pan slowly with DPR 1 and 2, resized viewport, very wide/narrow FOV
  and large screenshot/export sizes. Look for discrete jumps, sparkle,
  missing stars or color-saturated discs.
- Verify real planet/terrain/limb depth occlusion, translated vs rotated
  camera poses, legacy magnitude filter and catalog reload.
- Compare CPU/GPU time and memory before/after with the default ~9k-star
  catalog on desktop/mobile WebGL. The renderer batches one point per star,
  and only updates a DPR uniform once per draw, not per star.

**Open scope boundaries:** #212 handles shared HDR/exposure and blending;
#219 handles direction-dependent atmospheric extinction; #194 governs
instrument image authority. Do not call this a calibrated camera image.
