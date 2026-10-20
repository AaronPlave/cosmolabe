# Giro3D lessons and PR #262 closeout

Reviewed 2026-10-20 against Giro3D commit `00d3c22ce1cd06a7e4ee7d10c9cdde6821a90a86`. This is a source/architecture review, not a claim that Giro3D was benchmarked in Cosmolabe or that its generic GIS paths solve planetary seam/datum problems.

## Reference findings

| Area | Giro3D implementation | Decision for Cosmolabe |
|---|---|---|
| Terrain lifecycle | [DrapedFeatureCollection](https://github.com/giro3d-org/Giro3D/blob/00d3c22ce1cd06a7e4ee7d10c9cdde6821a90a86/src/entities/DrapedFeatureCollection.ts) offers per-feature/per-vertex/none placement; registers tile creation/deletion/elevation and elevation-layer changes, tracks sampled LOD and rebuilds feature meshes. | Useful for independent 3D geometry/extrusion. Keep projected clamp: discover actual visible source triangles after terrain traversal, update body/pass transforms, prune unseen/replaced proxies at frame end. No second sampled terrain mesh, elevation requests or re-draping queue. Missing terrain still means the documented reference surface, not a claimed terrain-height solution. |
| Geometry and batching | [FeatureCollection](https://github.com/giro3d-org/Giro3D/blob/00d3c22ce1cd06a7e4ee7d10c9cdde6821a90a86/src/entities/FeatureCollection.ts) uses extent/LOD nodes, feature deduplication and material sharing by style. [GeometryConverter](https://github.com/giro3d-org/Giro3D/blob/00d3c22ce1cd06a7e4ee7d10c9cdde6821a90a86/src/renderer/geometries/GeometryConverter.ts) builds separate point/stroke/fill meshes, preserves polygon holes and updates mesh styles. | Broader geometry/style support is useful for #199/#200. Shared materials do not by themselves eliminate per-object drawing. Retain our bounded primitive index/pages and shared surface passes for dense local/global data; preserve original map cuts, polar charts, holes and stable typed IDs. No evidence justifies replacing the current joins or CSS-pixel derivative AA. |
| Picking and hover | [ColorLayer](https://github.com/giro3d-org/Giro3D/blob/00d3c22ce1cd06a7e4ee7d10c9cdde6821a90a86/src/core/layer/ColorLayer.ts) queries retained vector geometry at a picked map coordinate, with tile-resolution-based hit tolerance. The [interactive demo](https://github.com/giro3d-org/Giro3D/blob/00d3c22ce1cd06a7e4ee7d10c9cdde6821a90a86/examples/interactive-vector-layer.js) updates source feature styles on pointer movement. | Useful precedent for source-geometry picking on a future raster backend (#266); it is not GPU feature-ID picking. Keep shared `SceneHit`/`pickScene`, nearest-surface occlusion, tool priority, selected/hover order and drag semantics. Measured adjacent-country hover below does not justify speculative caching. |
| Screen-sized editing marks | [Shape](https://github.com/giro3d-org/Giro3D/blob/00d3c22ce1cd06a7e4ee7d10c9cdde6821a90a86/src/entities/Shape.ts) has pixel line/vertex/border sizes, segment/vertex/surface hits and editable annotation primitives. | Useful reference for #200. Keep scientific imported features distinct from editable shapes; do not add drawing/editing here. |
| Style/compositing policy | FeatureCollection combines entity opacity with feature opacity, adds entity/style render order and shares style materials. ColorLayer exposes visibility, opacity and blending changes. | Good extension points for #198/#199: declarative geometry-specific defaults/overrides, layer versus feature alpha, explicit layer order, bounded shared style resources and precise invalidation. Do not promise arbitrary translucent-layer compositing from #262's current winning-feature rules. No new layer manager or OpenLayers/Giro3D dependency. |

This reinforces the [existing backend recommendation](../../../geographic-backend-comparison.md): projected vectors for interactive science, optional raster background work in #266, polar raster-quality work in #267. It introduces no new geographic parser/model or production backend.

## Pointer-hover measurement

Run the ordinary viewer on port 5188, then:

```sh
node scripts/test-geographic-hover-closeout.mjs
```

[hover.json](hover.json) records actual Playwright pointer events through the normal viewer, 1920×1080 CSS, DPR 2, 3840×2160 drawing buffer, Apple M4 Max ANGLE Metal. No injected scene and no test mode. The pointer alternates seven neighboring European country interiors for 140 moves (approximately 30 moves/s, allowing a rendered frame after each event), compared with repeated movement within France. This measures the combined frame behavior with fresh highlight CPU allocations; it is not an isolated GPU benchmark or a sweep of every country/device.

- 139 changed-feature highlights: 4.1 ms median, 4.3 ms p95, 6.2 ms maximum CPU.
- Traversal frames: 16.7 ms median, 16.9 ms p95, 17.4 ms maximum. Renderer CPU: 0.4 ms median, 1.3 ms p95; event-handler highlight CPU is measured separately.
- Texture count stays at 11 throughout traversal; no accumulating highlight residency. Repeated movement inside France triggers only one highlight update.
- Hidden layer: zero features, batches, surface proxies, vector texture bytes and draws; ordinary `entity` picking resumes. This verifies release of vector-owned drawing resources, not a proof of zero application-level bookkeeping or driver allocations.

The earlier South Africa 8–9 ms allocation remains a nonblocking optimization opportunity. There is no demonstrated hover stutter in this route that warrants a cache, extra retained GPU memory or invalidation complexity in #262. Larger/colder features or slower devices may differ.

## Final smoke on unchanged production renderer

Evidence below was captured on renderer head `587c684`, before this documentation/harness-only closeout. Its [Build & Test run](https://github.com/AaronPlave/cosmolabe/actions/runs/39280450614) passed. Check the new closeout head's CI separately before merge.

The first closeout run passed the full repository suite but failed installing Chromium: `ubuntu-latest` resolved to Ubuntu 26.04, unsupported by the installed Playwright 1.60.0 dependency installer. CI now pins `ubuntu-24.04`; this changes the test environment, not the production renderer or smoke assertions.

- [earth.json](earth.json): existing global smoke with three timing samples per view, actual hover/select and drag grammar, all 177 countries, Pacific/Antarctica, South Africa/Lesotho hole, backside occlusion and body rotation. All assertions pass. These short samples are correctness checks; retain the previous full benchmark for performance conclusions.
- [jezero.json](jezero.json): existing measured/dense viewer regression with shortened initial sampling. All 1,601 features remain through drag and regional/orbit/close zoom; 276,945 cyan pixels in the dense detail capture. Detail/regional/orbit frames are approximately 16.7 ms; dense close is 33.3 ms median / 33.4 ms p95, within the existing 50 ms regression gate. This is a demanding 4K workload, not a guarantee of 60 fps at every close view.
- [shackleton.json](shackleton.json): existing vector backend smoke, measured LOLA cube terrain at orbit/detail/close. All 15 registration features imported, no vector diagnostics, no pending terrain requests at the sampled states. Close capture retains sharp points/strokes and a clear polygon hole. Synthetic marks are not surveyed geology.
- [composition.json](composition.json): actual measured Shackleton viewer, `BodyMesh.setSurfaceAppearance({...current, hillshade})` false/true/false. Marks remain visible and diagnostic-free while hillshade changes/restores. Earth smoke uses its normal base texture. Existing cube-imagery splitting/composition tests and captures remain applicable; these short checks do not replace that earlier evidence. Contours are not available on #262's current main integration, so #265 was not merged to manufacture that combination.
- 86 focused tests pass across core geographic data, index/global rendering, scene interaction and surface-appearance picking; package build, harness syntax and `git diff --check` pass. No production rendering code changed, so extensive completed benchmarks were not repeated.

Reproduce the existing smoke portions with:

```sh
CL_GPU=hardware CL_FRAMES=3 node scripts/test-geographic-global.mjs
CL_FRAMES=15 node scripts/test-geographic-viewer-performance.mjs
CL_BACKENDS=vector CL_FRAMES=3 CL_CATALOGS=geographic-vectors-shackleton-terrain node scripts/compare-geographic-backends.mjs
```

Physical mobile GPU testing remains owner-waived. Absolute datum heights, DSK attachment, layer/style UI and editable shapes remain deferred to their existing issues. No new merge blocker was found; recommend moving #262 out of draft and merging after final-head CI. This review does not merge the PR or close #197.
