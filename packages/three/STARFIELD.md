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
`linearFluxScale * F(m)`. The default provisional scale is `0.06`.
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
`catalog.png`; `CL_STAR_OUTPUT` selects another directory. CI runs it and
uploads a `starfield-webgl` artifact. It verifies:
- Float-target integrated flux and centroids at DPR 1/2, 128/192 CSS-pixel
  viewports, 1°/60°/120° FOV and subpixel offsets, including 10:1 magnitude pairs.
- The actual 8-bit sRGB default framebuffer against a Gaussian + sRGB
  quantization reference (within one code value). A 16-phase pan measures
  magnitudes -1.44, 0, 2.5, 4, 5 and 6.5 under both the viewer's default
  no-tone-mapping output and ACES at renderer exposure 1.
- Camera-translation invariance, behind-camera rejection, opaque sphere and
  displaced mesh occlusion with logarithmic depth enabled, and the real catalog.

### Measured display precision limit (2026-10-21)

Chromium 151 / ANGLE SwiftShader readback passed all 96 float and 384 display
samples. Maximum relative float flux error was 0.00093%; maximum centroid
error was 0.013 CSS pixels. The no-tone-mapping 8-bit reference matched exactly.
These are software WebGL measurements, not physical GPU/mobile performance.

**This does not establish faint-star display acceptance.** At the provisional
scale 0.06, the isolated-star fixture produced the following recovered linear
CSS-pixel signal after sRGB readback (ranges cover subpixel phases):

| Magnitude | Pre-tone signal | 8-bit signal, DPR 1 | 8-bit signal, DPR 2 |
| --- | --- | --- | --- |
| 0 | 0.06 | 0.05834–0.06013 | 0.05898–0.05955 |
| 2.5 | 0.006 | 0.00511–0.00616 | 0.00530–0.00581 |
| 4 | 0.001507 | 0.00074–0.00121 | 0.00098–0.00119 |
| 5 | 0.0006 | 0 | 0 |
| 6.5 | 0.000151 | 0 | 0 |

The default framebuffer quantizes faint sources away, and magnitude-4 signal
varies substantially during the pan. At exposure 1, ACES further suppresses
the fixture (magnitude 2.5 and fainter quantize to zero). Magnitude-pair
photometry is therefore a **pre-tone** claim, not a display-pixel ratio or a
guarantee that every decoded catalog star is visible. No artificial intensity
floor, separate exposure adaptation or temporal dither is added to mask this.
The output limitation must remain visible during visual acceptance and the
shared HDR/exposure work in #212.

Viewer smoke on the same software renderer also captured the existing
`atmosphere-earth-textured` whole-disc view, `atmosphere-saturn-shadow`
clouds/rings view, and the `geographic-vectors` textured Moon (overlays hidden,
camera facing its sunlit hemisphere), at 800×600 CSS pixels and DPR 1/2.
Playback was paused; these catalogs use fixed body poses. Renderer exposure
remained 1, tone mapping off, and flux scale 0.06. All assets and 8,826 stars
loaded without page/shader errors. Stars remained restrained against the
sunlit globes. Earth-view sky-only and 1° sky views were also sampled through
16 subpixel pan steps. These captures exercise actual viewer compositing,
but do **not** certify streamed lunar terrain (absent from this checkout),
instrument sensor semantics, physical GPU/mobile timing or visual acceptance
of the quantified faint-star limitation above. Keep the PR in draft until
the remaining acceptance work is reviewed.

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
