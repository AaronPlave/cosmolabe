# Body-label sharpness and label backends (#350)

The Ingenuity body label (a WebGL sprite) alternated between crisp and soft,
while HTML place names in the same scene stayed sharp. It was usually sharp on
a Retina panel and often soft on a lower-density external display.

![Before/after crops of the Ingenuity body label and the Neretva Vallis place name](ingenuity-label-before-after.png)

Production render settings: MSAA and bloom on, no `?test=1`. Each column is a
different instant, so the label lands at a different sub-pixel offset. The DPR 1
rows are zoomed 2× with nearest-neighbour scaling.

## Root cause

`LabelManager` rasterized every label canvas at **4× the CSS font size**
(`12 px × 4 = 48 px` at both DPR 1 and DPR 2). It then drew the sprite at its
projected, fractional screen position, using `LinearFilter` and no mipmaps.

- At **DPR 1**, each device pixel took one bilinear sample from a 4×4-texel
  footprint. Most of the glyph went unsampled, and which strokes survived
  depended on the label's sub-pixel phase. A Mars-fixed label moves continuously
  as Mars rotates, so its look kept changing with no code change. A standalone
  sweep of phases 0, ¼, ½ and ¾ showed thin, ragged and uneven text that differed
  at each phase.
- At **DPR 2** the reduction was only 2×, and every phase looked acceptable.
  This matches the Mac-sharp / external-soft report.
- A plain 1:1 texture placed at a half-pixel offset is the other failure mode.
  Every edge smears across two pixels, which is the classic "blurry" label.
  Fixing the oversampling alone would therefore not be enough.

The DPR handling had its own weakness. The backing store followed the DPR only
through a single re-armed `matchMedia` listener. If that event was missed or
late, the canvas stayed at the old DPR and the compositor rescaled all WebGL
content, while HTML text stayed sharp. The bloom composer also kept the DPR it
was built with.

## Fix

- **One texel per device pixel.** Labels are rasterized at
  `fontSize × labelScale × renderer pixel ratio`. The sprite is sized from the
  projection matrix and the drawing-buffer size so its quad covers the canvas
  exactly.
- **Device-pixel snapping.** After layout and collision, each drawn label moves
  by less than one device pixel so its quad's top-left corner lands on an
  integer device pixel. Bilinear sampling then reproduces each texel exactly.
  This is the WebGL equivalent of the snapping browsers apply to HTML text.
- **DPR follows the renderer, every frame.** `UniverseRenderer` checks
  `devicePixelRatio` against the renderer's ratio each frame and on resize. The
  media-query listener is kept as well. `LabelManager.update` gets the drawing
  buffer and re-rasterizes when its ratio changes, and `BloomEffect.setSize`
  updates the composer's pixel ratio.
- Collision, picking and reservation boxes stay in CSS pixels. Their apparent
  size is unchanged at about 74×20 CSS px for "Ingenuity" at every DPR, and they
  now include `labelScale`.

No backend changed: no HTML or SDF migration, no shader, and no added draw pass.
Screenshots and video still record the WebGL canvas, which contains the labels.

## Shared contracts, and what stays different

Shared now:

- **Screen rectangles.** `LabelScreenRect` is now an alias of the annotation
  `ScreenRect`. Body-label collision and context-annotation reservation use the
  same `labelOverlaps` test as `PersistentLabels`.
- **Arbitration.** One arbitration order already existed, and it is kept.
  Reserved rects (event callouts) come first, then body labels. Place names and
  contour or graticule labels take the body-label rects as obstacles, so
  backends never both claim the same pixels.
- **Typographic size.** Text renders at the same CSS-pixel size convention
  (12 px default) in both backends. Body labels now do this at the true device
  resolution, as HTML does.

Intentionally different:

| | Body / spacecraft labels | Geographic place names |
|---|---|---|
| Backend | WebGL sprite in the scene | HTML in the overlay container |
| Why | Canvas-only screenshot and video capture, `OVERLAY_LAYER` exclusion from instrument views, depth-independent ordering with other scene overlays | Hundreds of candidates through `PersistentLabels`, ellipsis and wrapping, text metrics and hit-testing from the DOM |
| Anchoring | Beside the body silhouette, alternate slots when pinned | Centred on the surface anchor |
| Visibility | Sphere/DSK occlusion and limb fade, NASA-Eyes self-size fade | Terrain line-of-sight checks under `AnnotationBudget`, eligibility hysteresis |
| Font | `monospace`, catalog label colour, black glow | `system-ui`, class-dependent colour, outline shadow |

Fonts were not unified here because that is a product-styling decision.
Measurements gave no reason to move body labels to HTML: at matched size and DPR,
the snapped sprite is as crisp as the HTML text beside it. An HTML body-label
backend would still need to solve canvas-only capture, body hit-testing, and
instrument-view exclusion first.

## Validation

`npx vitest run packages/three/src/__tests__/LabelManager.pixels.test.ts`
checks that the quad is 1:1 and snapped at DPR 1, 1.25 and 2. It also checks
re-rasterization across 1 → 2 → 1 with a fixed CSS box, and continued alignment
while a body moves in sub-pixel steps.

`node scripts/test-label-sharpness.mjs VIEWER_URL OUT_DIR` runs against the dev
server with the Ingenuity catalog. It uses CDP to change the DPR live, without a
reload, through 1 → 2 → 1 → 2 → 1.25 (with a resize) → 1.5 → 1 → 2 → 3 → 1. All
10 transitions pass: the backing store equals the DPR, the texture equals the
device-pixel quad, and the CSS box stays fixed. The script also writes the
crops shown above.

The nightly golden scenes were compared in one environment. Between main and
this change, label pixels account for 0.056% (Cassini SOI) and 0.084% (Cassini
ring plane) of the frame. That is well inside the 0.5% golden budget. The other
diffs against the committed goldens (atmosphere-earth horizon/ascent and the
Cassini camera) occur identically on main in this environment.

`LabelManager.update` CPU time, synthetic, node, DPR 2:

| Visible labels | main | this change |
|---|---|---|
| 25 | ~0.05 ms | ~0.06–0.11 ms |
| 100 | ~0.09 ms | ~0.13–0.20 ms |
| 250 | ~0.34 ms | ~0.37–0.47 ms |

The added cost is one projection per drawn label. Fully transparent labels are
skipped. Re-rasterization happens only when the DPR changes.

## Not covered

- Physical monitor moves were emulated through CDP. They were not performed on
  real external and Retina displays, and Chromium ran with SwiftShader, not
  Metal.
- At fractional DPR, the canvas backing store is `floor(cssSize × dpr)`. When
  that product is not an integer, the compositor applies a sub-pixel rescale
  (for example 1388 vs 1388.75 px), which affects all WebGL content. Sizing
  from `ResizeObserver` `device-pixel-content-box` would remove this. It is a
  separate change and was left out.
