# Surface data planner (#250)

The **Surface planner** tool (rail icon below Surface layers) is an opt-in,
3D-first workspace for authoring a version 1 [desired surface plan](surface-data-plans.md).
It is closed by default; nothing is computed, drawn or loaded until a plan is
started, so the normal viewer is unchanged while it is inactive. It is an
authoring and source-selection surface only: it never downloads a raster,
contacts an archive, holds a credential, runs a build or publishes to R2.
Surface layers stays in charge of everyday visibility, styling and probing.

## Workflow

The panel is four steps, one decision at a time, with *Back* / *Next* and a
step bar to jump between them. Start by picking a body and choosing *Draw an
area* (or *Start without drawing*, *Open a saved plan…*, *Try the Jezero
example*). Bodies without an evidenced sphere/oblate reference shape are
blocked with the reason; no coordinates are invented.

1. **Area.** Draw an area on the plan's body, or select any polygon — a
   catalog layer, an imported GeoJSON layer, or a shape drawn with Draw (#200)
   — and choose *Use selected shape*. Leaving the draw tool without finishing
   cancels it, as does closing the plan or the panel mid-shape. The feature is
   **copied** into the plan with its typed stable ID, holes and properties;
   read-only sources are never modified, and the plan layer's `provenance`
   records the source layer, identity, ownership and feature mapping. If the
   source shape is edited later the area shows *Use current shape*. Layers in
   another frame (e.g. `MOON_ME_DE421` versus `IAU_MOON`), on another body, or
   with different conventions/reference shape are refused with the reason; no
   implicit transform is made. Points and paths need an explicit buffer first.
   A shape already in the plan is not offered again. Rename an area (pencil or
   double-click) to give it a meaningful name; its ID becomes the name's slug.
   One line states what the scene shows (imagery layers, measured 3D terrain or
   the smooth reference shape); planning never changes the scene.
2. **Detail.** For the area, tick *Imagery* and/or *3D terrain* and choose how
   detailed: *Regional* (50 m per pixel / 200 m per sample), *Landing* (1 m /
   10 m) or *Close-up* (0.25 m / 1 m), or type an exact value. These are
   requested output sampling, never measured accuracy. *Advanced* holds the
   maximum terrain source error, priority and what to do if unmet.
3. **Sources.** *Find available imagery and terrain* compares the archive
   product metadata indexed in the viewer — for Mars, the 14 curated #249 ODE
   records around Jezero and Gale (`mars-jezero.inventory.json`,
   `mars-gale.inventory.json`). The step says so: it is not a live archive
   search, other datasets may exist, nothing is downloaded and no archive is
   contacted. Footprints in another longitude domain are re-expressed exactly in
   the plan's (a whole-turn shift per ring, noted in the record's caveats);
   any other convention difference is not compared. Each requested channel then
   shows **Requested** against the named candidate product and its stated
   native resolution, what is **evidenced** (footprint overlap, valid pixels
   proven, registration), one verdict — *Proven*, *Partly proven*, *Coarser
   than requested*, *Unknown — needs verification* or *Not found* — and one
   sentence why (for example, a stated resolution finer than requested does not
   show usable coverage when valid pixels are not evidenced). The other ranked
   candidates are listed by product and selectable; rank is not suitability.
   Each has its source IDs, valid/unknown/gap fractions, source download and
   warnings under *Evidence*. *Show on the globe* flies to the area and says
   what is drawn; a compact legend sits under the candidates. *Shown in this scene* lists the configured
   display products over the area for context; they are never treated as
   source evidence for a rebuild. Where the viewer has no metadata (other
   bodies), the step says coverage is unknown and points to
   `npm run discover:surface` with an archive query; its inventory, or bare
   source descriptors, can be opened from the ⋯ menu.
4. **Finish.** A summary per area and channel, the estimated storage when
   published and the source download (separate costs; the optional storage
   limit applies to published bytes only), then:
   - **Save plan** (with *Plan saved* / *Ready to save*) writes the exact v1
     desired plan the CLI reads (`npm run plan:surface`, `discover:surface`),
     with every referenced GeoJSON embedded.
   - **Next** states the honest outcome. Unless every channel is proven, it is
     *Source verification required before preparing a build*: the planner
     compares metadata only and cannot verify valid pixels, and no supported
     tool does that yet; the saved plan is the input for that step and for a
     wider archive search (`discover:surface --ode-query`, under *Details*).
   - *Save build handoff* appears only when core can lock the chosen sources
     (in practice, an opened inventory with versioned or checksummed
     products); otherwise *Details* gives core's reason. It writes a
     `locked-surface-plan`. **The handoff is not directly executable:**
     `npm run build:surface` runs only a fully prepared lock and does not fill
     in what is missing. A preparation step must add
     `processing.parameters.terrain`, `imagery` and `gates` (and a profile
     where used), a supported Mars spherical planetocentric source map, pinned
     source bytes and runtime bindings; on save the panel lists what the lock
     lacks, as far as it can check. An opened lock re-saves unchanged until its
     plan, sources or selection change.
   - *Details* holds the storage limit, work disk, 2×/4× coarsening
     comparisons (never applied to the plan) and diagnostics.

**Build feedback.** Opening a #251 build's `planner-feedback.json`
(contract v1) from the ⋯ menu adds, per area and channel in *Finish*, whether
a published product already suffices, is published but its fit is not proved,
was built but not published or below target, or needs a new build (different
shape, coarser output, different selected sources, or reported accuracy
outside a stricter limit). *Suffices* requires coverage proved for the
requested ROI and every requested target evidenced; continuous coverage not
proved by tile availability, or accuracy unreported against a limit, is *not
proved*, not success. Body, frame and coordinate conventions must match the
build's (stated in the feedback's `surface` field, or taken from the build's
lock if it was opened this session; otherwise the fit is *not proved*), and
the finest output spacing the build actually produced must meet the target;
the original request's sampling alone is not evidence. Compatibility is per
region, not by lock identity, so a reusable product still matches from another
build. Unrecognized feedback statuses are refused. Without feedback this is
*unknown*, never absent.

Per-region fidelity is assessed from only that region's selected sources; a
source chosen for one region never satisfies another.

## On the globe

Only the focused region's comparison is drawn, as restrained `planner:` layers
that Surface layers does not list or search:

| Layer | Meaning |
| --- | --- |
| Your area (bold yellow outline, labelled with its name) | The requested ROI; says nothing about data. |
| Product footprint (thin grey outline, labelled with the product ID) | Archive footprint of a chosen source; not valid pixels. |
| Confirmed valid (green) | Independently evidenced valid pixels of the chosen sources. |
| Validity unknown (amber hatch) | Inside a footprint, but pixel validity is not evidenced. |
| Gap (red hatch) | Not covered by the chosen sources — not an archive-wide absence. |
| Requested build ROI (blue outline) | The ROI a loaded build was requested for, drawn only when it is this region's own shape. Not observed achieved valid coverage. |

Current tile residency is a separate quantity and is not drawn. Clicking an
area on the globe focuses it in the panel; *Show the comparison on the globe*
hides or shows the comparison. The panel has no full-workspace mode, since
that would hide the globe it draws on; float and resize it instead (two
channel cards sit side by side when it is wide).

## Fixtures and limits

The Jezero example loads `docs/examples/surface-plans/jezero.geojson` as a
read-only layer, `mars-jezero.inventory.json` as the offline inventory, and
three regions at the three presets with a 100 MB storage limit. The regions are synthetic
fixtures: they are not Skyfall/Mars 2020 mission geometry or proof of coverage.
An imagery-only region on a reference ellipsoid estimates zero elevation inputs
and work. Plan limits are those of #248 (16 layers, 32 regions, 4,096 vertices,
non-polar polygons). Science raster products (#307), trajectory/FOV-derived
regions and DSK/irregular-mesh authoring are not part of this tool yet.

The authoring helpers are pure core functions (`addSurfacePlanRegion`,
`updateSurfacePlanRegion`, `surfacePlanChanges`, `surfaceCoverageLayer`, …) in
`packages/core/src/surface-plan/authoring.ts`, tested in
`packages/core/src/__tests__/surface-plan-authoring.test.ts`.
