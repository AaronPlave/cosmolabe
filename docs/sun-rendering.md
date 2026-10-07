# Solar photosphere and optical glare

Stars use `SunVisual` rather than a yellow, textured emissive body. The physical
sphere remains in the normal body positioning, picking and tracking system, at
its catalog radius even when `minBodyPixels` is nonzero.

The disk uses a broadband linear limb-darkening profile, `0.4 + 0.6 * mu`, and
warm-white linear HDR radiance `(3.2, 3.08, 2.88)`. `mu` is the normal/view cosine
at the actual sphere surface, including perspective at close range. A fixed local
response, `1 - exp(-radiance)`, displays that signal without changing scene-wide
exposure or tone mapping.

`SOLAR_LAYER` draws the disk after atmosphere shells while retaining the opaque
body depth buffer. The nearest intersected atmosphere supplies its existing RGB
transmittance LUT and density profiles; transmission is applied before both the
disk response and optical glare. This avoids attenuating the disk twice. The
numerical profile integration remains available when no LUT exists.

`SunGlareEffect` renders only solar radiance into a half-float source target.
Opaque meshes contribute depth and black color; transparent shells, overlays,
lines, sprites, stars and other emissive content contribute no light. A bounded
quad uses a 1x1 HDR reduction of 32 equal-area photosphere samples to generate a
compact halo plus a much fainter tail. Their width is capped, so close-up solar
views do not grow a huge halo. Partial occultation reduces the source signal;
total occultation removes it.

Between two and one physical pixels, the display disk smoothly transfers into a
point spread. An expanded *offscreen optical source* preserves subpixel energy,
scaled by the inverse footprint area. The physical sphere is never enlarged.
For that optical footprint, original solar rays are also tested against up to
eight nearby sphere/ellipsoid occluders so a tiny fully occulted Sun cannot leak
glare around the edge of a similarly tiny planet.

The viewer's existing bloom toggle controls solar glare, and bloom strength
scales its halo. Generic bloom still handles other emissive content and skips its
scene/blur passes when that layer is empty. Solar glare skips its source pass
when the Sun and halo are outside the viewport.

This is a fixed-exposure approximation, not calibrated photometry. It uses the
first atmosphere crossed on the viewing ray; simultaneous transmission through
multiple planetary atmospheres and eclipse corona are outside this first pass.
The 32-sample quadrature approximates partial-disk optical flux rather than
simulating a full camera PSF.

## GPU verification

```sh
npm run build
node scripts/test-sun-gpu.mjs
# Or use an installed browser:
CHROMIUM_PATH=/usr/bin/chromium node scripts/test-sun-gpu.mjs
```

The check needs Chromium but no viewer assets or SPICE kernels. It tests limb
darkening, neutral color, HDR values, compact glare, resolved and subpixel total
occultation, atmospheric dimming/reddening of the disk and glare, agreement
between LUT and numerical transmission, unresolved visibility, exclusion of
other content, physical radius, and restoration of scene/renderer state.
Captures are written under `work/sun-rendering/`.

These images are synthetic GPU scenes using the production shaders, not
mission-epoch or solar-surface imagery. The horizon example deliberately uses a
large disk to expose transmission gradients and ground masking.

### Resolved disk in space

![Warm-white limb-darkened disk and compact glare](images/sun-resolved.png)

### Through Earth's atmosphere

![Dimming and reddening across a grazing solar disk](images/sun-horizon.png)

### Partial occultation

![Foreground sphere masks the disk and reduces its optical glare](images/sun-partial-eclipse.png)
