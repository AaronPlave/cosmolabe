# Surface data planner (#250)

The **Surface planner** tool (rail icon below Surface layers) is an opt-in,
3D-first workspace for authoring a version 1 [desired surface plan](surface-data-plans.md).
It is closed by default; nothing is computed, drawn or loaded until a plan is
started, so the normal viewer is unchanged while it is inactive. It is an
authoring and source-selection surface only: it never downloads a raster,
contacts an archive, holds a credential, runs a build or publishes to R2.
Surface layers stays in charge of everyday visibility, styling and probing.

## Workflow

1. **Start.** Pick a body and choose *New plan*, open an existing desired or
   locked plan, or load the *Jezero example*. The body summary shows its
   reference shape and frame, how many imagery layers are configured, and
   whether measured terrain is loaded or only the reference shape is
   (absence of a DEM is a normal starting point, not an error). Bodies without
   an evidenced sphere/oblate reference shape show a blocked-georegistration
   explanation; no coordinates are invented.
2. **Regions.** Select any polygon — a catalog layer, an imported GeoJSON
   layer, or a shape drawn with Draw (#200) — and choose *Add selected*, or
   choose *Draw region* to draw one on the plan's body that is added when
   finished (leaving the tool without finishing cancels it, as does closing
   the plan or the panel mid-shape). The feature is
   **copied** into the plan with its typed stable ID, holes and properties;
   read-only sources are never modified, and the plan layer's `provenance`
   records the source layer, identity, ownership and feature mapping. If the
   source shape is edited later the region shows *Use current shape*.
   Layers in another frame (e.g. `MOON_ME_DE421` versus `IAU_MOON`), on another
   body, or with different conventions/reference shape are refused with the
   reason; no implicit transform is made. Points and paths need an explicit
   buffer first.
3. **Fidelity.** Each region requests *Imagery*, *Imagery + elevation* or
   *Elevation*, independently. Presets — *Orbit / context* (50 m / 200 m),
   *Descent* (1 m / 10 m), *Local operations* (0.25 m / 1 m, 0.5 m maximum
   source error) — fill in priority and fallback too; every value stays
   editable and the preset reads *Custom* once changed. Terrain controls only
   appear when elevation is requested. These are requested output sampling and
   source-error limits, not achieved accuracy.
4. **Sources.** Load a #249 discovery inventory (array of
   `SurfaceDiscoveryRecord`) or bare source descriptors. With no inventory,
   coverage is reported as unknown and the estimate is geometry-only. For the
   focused region, up to three ranked combinations are listed per channel with
   confirmed-valid / unknown / gap fractions, target fit, download size and
   registration/datum/illumination warnings. Choosing one feeds the estimate.
   Optionally load a #251 build's `planner-feedback.json` (contract v1): each
   focused region then shows, per channel, whether a published product already
   suffices, is published but its fit is not proved, was built but not
   published or below target, or it needs a new build (different shape,
   coarser output, different selected sources, or reported accuracy outside a
   stricter limit). *Suffices* requires coverage proved for the requested ROI
   and every requested target evidenced; continuous coverage not proved by tile
   availability, or accuracy unreported against a limit, is *not proved*, not
   success. Body, frame and coordinate conventions must match the build's
   (stated in the feedback's `surface` field, or taken from the build's lock
   if it was opened this session; otherwise the fit is *not proved*), and the
   finest output spacing the build actually produced must meet the target;
   the original request's sampling alone is not evidence.
   Compatibility is per region, not by lock identity, so a reusable
   product still matches from another build. Unrecognized feedback statuses are
   refused. Without feedback this is *unknown*, never absent.
5. **Estimate and budget.** The #248 estimator reports imagery and physical
   terrain separately: area, hosted bytes and objects, raw download, peak work
   disk, fidelity (adequate / unknown / short area) and an optional
   published-byte budget with its bounded 2×/4× coarsening comparisons. The
   comparisons never change the authored plan. With per-region selections
   (an inventory or a held lock) fidelity is assessed per region from only
   that region's selected sources; a source chosen for one region never
   satisfies another. Bare descriptors give one pooled *Any loaded source*
   figure instead.
6. **Export / import.** *Export desired plan* writes the exact v1 JSON the CLI
   reads (`npm run plan:surface`, `discover:surface`), with every referenced
   GeoJSON embedded. *Export locked plan* builds a `locked-surface-plan` from
   the chosen combinations and validates it with core; if the selections are
   not buildable under their metadata (unknown validity, datum transforms,
   partial coverage, an unmet `require-target`) the export is refused with the
   reason. **The exported lock is a planner handoff, not directly executable:**
   `npm run build:surface` runs only a fully prepared lock, and does not fill in
   what is missing. An executor-compatible preparation step must add
   `processing.parameters.terrain`, `imagery` and `gates` (and a profile where
   used), a supported Mars spherical planetocentric source map, pinned source
   bytes and runtime bindings. On export the panel reports which of these the
   lock lacks, as far as the planner can check; bytes and bindings are verified
   only by the executor. An imported lock re-exports unchanged until its plan, its
   sources or its selection change. *Unsaved changes* and per-region dots mark
   desired-plan edits since the last import or export; *Sources not locked*
   marks a source choice that differs from the last locked plan.

## On the globe

Only the focused region's comparison is drawn, as restrained `planner:` layers
that Surface layers does not list or search:

| Layer | Meaning |
| --- | --- |
| Desired region (yellow outline) | The requested ROI; says nothing about data. |
| Candidate footprint (grey outline) | Archive footprint of a chosen source; not valid pixels. |
| Confirmed valid (green) | Independently evidenced valid pixels of the chosen sources. |
| Validity unknown (amber hatch) | Inside a footprint, but pixel validity is not evidenced. |
| Gap (red hatch) | Not covered by the chosen sources — not an archive-wide absence. |
| Requested build ROI (blue outline) | The ROI a loaded build was requested for, drawn only when it is this region's own shape. Not observed achieved valid coverage. |

Current tile residency is a separate quantity and is not drawn. Clicking a
desired region on the globe focuses it; *Show this combination on the globe*
hides the comparison.

## Fixtures and limits

The Jezero example loads `docs/examples/surface-plans/jezero.geojson` as a
read-only layer, `mars-jezero.inventory.json` as the offline inventory, and
three regions at the three presets with a 100 MB budget. Both are synthetic
fixtures: they are not Skyfall/Mars 2020 mission geometry or proof of coverage.
An imagery-only region on a reference ellipsoid estimates zero elevation inputs
and work. Plan limits are those of #248 (16 layers, 32 regions, 4,096 vertices,
non-polar polygons). Science raster products (#307), trajectory/FOV-derived
regions and DSK/irregular-mesh authoring are not part of this tool yet.

The authoring helpers are pure core functions (`addSurfacePlanRegion`,
`updateSurfacePlanRegion`, `surfacePlanChanges`, `surfaceCoverageLayer`, …) in
`packages/core/src/surface-plan/authoring.ts`, tested in
`packages/core/src/__tests__/surface-plan-authoring.test.ts`.
