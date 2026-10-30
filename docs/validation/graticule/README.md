# Adaptive graticule integration — PR #163

This refresh integrates main `097f92ab` (including #305). Regional border ticks remain opt-in. This is implementation and diagnostic evidence, **not merge approval**.

## Polar lunar rulers

Shackleton's missing surface ticks came from the general 84° discovery bounds/85° anchor exclusion, reinforced by a shader fade over the last 8° approaching either pole. These blanket limits are removed. Actual pixel spacing still suppresses congested meridians (including the singular pole), and auto longitude spacing may use 30° when meridians converge. Fixed polar ruler rings use a half-step phase from each pole; changing the view never slides a geographic site. Current geometry/ownership, visibility and annotation budgets remain authoritative.

The real `Shackleton Overview` and `PSR Floor View` presets now retain both surface coordinate axes in all 45 sampled stationary frames (three captions in each view, previously zero). Apollo's three tested presets retain identical surface captions before/after, including its existing sparse Hadley Rille view. The optional frame remains separately enabled and freshly certified; measured maximum alignment is below 0.02 CSS pixels in this comparison. These are sampled observations, not target counts or source accuracy claims.

- [Shackleton before](lunar-poles/shackleton-overview-before.png), [Shackleton after](lunar-poles/shackleton-overview-surface.png), [PSR Floor after](lunar-poles/psr-floor-view-surface.png), [both-demo comparison](lunar-poles/comparison.json).
- Reproduce with `GRID_EXPECT_POLAR=1 node scripts/graticule-lunar-validation.mjs` (default host `127.0.0.1:5188`, output `/tmp/grid-lunar`; both are configurable). Chrome used Apple M4 Max / ANGLE Metal, actual cube terrain/imagery and the original catalog lighting, frames and camera definitions.
- 126 focused tests in seven suites pass. New north/south polar regressions require both axes, bounded discovery and fixed sites through a small pan. Existing close-zoom, material composition, cube imagery, Surface Appearance, terrain lifecycle and rendered-query tests pass. Package build, test typecheck, changed-file ESLint, script syntax and diff checks pass.

## Close-zoom tick correction

The reported drift is reproducible near 16.67°N, 0.18°E on Earth. Globe captions were projected from the ideal ellipsoid, while grid lines are evaluated on the actual triangle facets. The close-zoom regression failed with a 9.78 CSS-pixel offset before the fix. Globe captions now intersect their prescribed geographic normal/radial ray with the rendered globe triangles. A private, indirect BVH avoids changing picking, vertex/index buffers or geographic sites, and is rebuilt when the globe geometry changes. Foreign-body occlusion uses the registered point. Displaced globes still withhold unsupported captions.

Small-angle caption precision now follows the grid step, avoiding rounding a 0.165° site to 0.16° when labels are three 0.005° steps apart.

- 104 focused tests in six suites pass, including sphere/oblate/triaxial close zoom, unchanged geographic coordinates/buffers, geometry replacement, and zoom restoration. Package build, test typecheck, changed-file ESLint and diff checks pass.
- `node scripts/graticule-close-zoom-validation.mjs` repeats the real Earth view at 30, 12, 5, 2 and 12 km in hardware Chrome (Apple M4 Max Metal). The 2 km camera centers on a neighboring fixed ruler band so captions are in view; arbitrary views may legitimately show none. Each displayed tick is checked against an independent triangle raycast and caption precision is checked against its coordinate. These numerical results measure CPU registration, not GPU raster accuracy; the actual captures were also visually inspected.
- [12 km capture](close-zoom/earth-12km.png), [2 km capture](close-zoom/earth-2km.png), [zoom sweep report](close-zoom/report.json). Previous integration evidence below records the earlier head; its broader outstanding acceptance remains open.

## Architecture and invariants

- Grid descriptors use canonical core datum/types/converters and `BodyMesh.bodyFixedFrame`. There is no `RotationModel.targetFrame`. Point Probe uses the same reference-coordinate convention; rendered hits and decoded physical samples retain separate heights/provenance.
- `RenderedSurfaceQuery` shares picking's active-LOD discovery, body ownership, nearest-hit and DSK rules. Annotation queries may additionally include visual-only site meshes as blockers. Such meshes cannot certify a geographic anchor or become authoritative probe/measurement geometry.
- Surface labels retain predetermined geographic sites. `PersistentLabels` provides collision arbitration, incumbent preference and fades; it never moves a site. Missing current-frame geometry certification invalidates immediately. Probe, selected measurement, event and UI rectangles precede grid captions; accepted grid bounds flow onward to Places and contours.
- Border ticks retain facet-plane refinement, fair edge/axis discovery, 0.2-CSS-pixel admission, eight triangle queries and eight captions per body/update. An 8 ms scheduling window can defer work; neither a cached facet nor a deferred query proves visibility. Sparse output is valid, particularly at grazing angles, poles and visual-only reconstructions.
- Planning reads one resident physical-height hint per planning pass. The new resident-only cube query never requests finer CPU grids. Current `terrainRevision` invalidates physical planning separately from load/dispose invalidation; displayed terrain anchors and ticks still require fresh rendered hits every frame, including cached LOD switches.
- Material hooks preserve identity, upstream fades/disposal, dynamic program keys, cube imagery and Surface Appearance/contours. Grid toggles change uniforms, not terrain residency. Caption textures are small, reused, sRGB and not tone mapped. CRR transforms are composed for the local-mesh pass; updates use the renderer's final camera.
- Exact lunar frame/availability behavior remains intact. Missing attitude withholds grid lines and text; recovery preserves supplied coordinates. Site registration uncertainty from #299 remains unchanged.

## Reproduction

```sh
npm ci
npm run typecheck
npm run lint
npm run lint:purity
npm --prefix apps/viewer run build
npm --prefix apps/viewer run build:embed
node scripts/test-embed-package.mjs
npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5188 --strictPort
# In another shell; shipped catalogs and configured local/hosted data are used unchanged:
GRID_VIEWER_URL=http://127.0.0.1:5188 GRID_OUTPUT=/tmp/grid-integration node scripts/graticule-integration-validation.mjs
GRID_CATALOGS=msl-dingo-gap GRID_NAMED_VIEWS=1 GRID_OUTPUT=/tmp/grid-local node scripts/graticule-integration-validation.mjs
```

The browser harness resolves the actual loaded app modules, including Vite HMR URLs. The named-view path checks that it controls the live renderer and that each catalog viewpoint applies. It does not substitute synthetic terrain. Reports go outside the active diff by default. Source paths, camera poses, frame names, residency, query alignment, timing and uploads are recorded.

## Verification

- 145 focused tests in 10 suites pass: grid controls/coordinates, attachment and motion, frame refinement/fairness/textures, current rendered-surface discovery, cube imagery/appearance composition, resident-only cube queries, terrain lifecycle and DSK compatibility.
- Full suite: 3,123 pass, 7 skipped, 2 fail. The failures are the unchanged GF timing assertion at `packages/cspice-wasm/src/gf-reporting.test.ts:183` and the demo inventory assertion at `apps/viewer/src/lib/__tests__/event-search-availability.test.ts:362`, which sees five ignored local MoonFall experiment catalogs. An earlier full run passed the GF assertion. Local experiment files and assertions were preserved.
- Package build, test/viewer/Svelte typechecks, lint and purity pass. Standalone and embeddable production builds pass; the installed-package smoke check passes, including declarations, workers, WASM, fonts and mission state. Existing chunk-size warnings remain.
- Real Chrome runs identify **Apple M4 Max / ANGLE Metal**. The current report/captures below record only this device and sampled paths; timings are diagnostics, not general performance predictions.

## Current real-scene evidence

See [compact results](integration/summary.json) and representative captures in [integration](integration/). Historical comparisons and large per-frame dumps were retired from the active diff; all remain in existing Git history (for example `bbf4ba67`). Two earlier comparison images remain under `coordinate-frame/` as historical references, not current acceptance.

The four-catalog path exercises FOV changes, slow roll, stationary updates, loaded/cached zoom-out and restoration, toggles and short playback. It enables contours, a real probe pin, selected measurement and catalog activity inspection. Separate named Curiosity views use the supplied catalog/SPICE camera definitions, including the 0.5 km Surface and 0.02 km Close-up views. No source positions or registration were rewritten.

## Remaining acceptance — retain draft

- Review readability and temporal stability across the recorded live paths. Suitable overhead Earth sustains both axes; polar and local-site paths are sparser. The regional frame remains an experiment, not the selected default.
- Complete sustained combined **visible Places + 3D event callout + measurement + probe + contour** collision acceptance. The overview runs indexed/enabled Places and selected real activities, but did not establish all of those annotations visibly coexisting. Activity inspector visibility is not equivalent to a 3D event callout. Named close-up captures can show a place label independently.
- Extend long playback/low-angle, cold-to-cached mixed-LOD and local-mesh transition review beyond these sampled paths. Visual-only local reconstructions block grid registration rather than becoming authoritative terrain; close-up absence of captions is not repaired by moving geographic sites.
- Frame unavailability/recovery, texture reuse, immutable anchors, bounded discovery and lifecycle are covered by focused regressions. Broader real-kernel outage/restore scenarios and additional GPU/browser coverage remain to be assessed.
