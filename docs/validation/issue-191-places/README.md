# Named-place acceptance — 2026-10-21

Test: `CL_TERRAIN=1 CL_GPU=hardware CL_OUTPUT=/tmp/planetary-places-final CL_VIEWER_URL=http://127.0.0.1:5189/ node scripts/test-planetary-places.mjs`.

Physical GPU: Apple M4 Max, Chrome/ANGLE Metal, 3840 × 2160 drawing buffer. Raw results: [metrics.json](metrics.json). No page errors.

The actual static catalogs loaded **11,139** points (11,138 USGS nomenclature records plus one explicitly synthetic user site) with no importer skips or diagnostics. The source converter separately counted one exact duplicate Bohar record in Mars. Initial geographic import: **479.5 ms**, within the shared 15,000 ms deadline; index construction: **24.8 ms**. Initial browser JS heap: **92.7 MiB**, including the viewer and original/normalized geographic records; this is not retained-memory or total GPU/worker memory. Per-worker round trips include startup, parsing and structured cloning, not just worker CPU.

| View | Drawing buffer | Candidates (max) | Labels (max) | Label CPU p95 ms | Render CPU p95 ms | Frame p95 ms |
|---|---|---:|---:|---:|---:|---:|
| Mars places orbit | 3840 × 2160 | 1024 | 32 | 3.50 | 4.20 | 16.70 |
| Moon places orbit | 3840 × 2160 | 1024 | 32 | 3.20 | 3.80 | 16.80 |

Both full-body views held approximately 60 FPS. Timings cover 60 warm frames; they are a measured sample, not a universal performance guarantee. Initial long-task durations and all worker round trips are retained in the JSON.

Verified through the normal UI: prefix search for Jezero/Shackleton and the synthetic mission site; active-body ordering; body/type filters; source details; Jump/Fly pose equivalence and persistent place target; clipboard; per-body names; shared label picking; and a 390 × 844 compact state without horizontal document overflow. The label regression suite also covers deterministic collision/priority, reserved annotations, backside/terrain LOS rejection, camera changes and supported-datum fallback.

A real temporary **cross-origin HTTPS** server served the unchanged catalog/require graph with CORS. The supported **flat multi-file** and **directory** workflows both loaded all points using the production local-file handler. Four sources (404, absent CORS, malformed GeoJSON and oversized content) failed diagnostically while the valid Mars source and scene remained usable. HTTPS/local phase times are in the JSON. The TLS fixture is temporary local hosting; it is not a claim of a public production deployment.

Measured-terrain checks used existing local LOLA cube terrain at Shackleton and MOLA/HRSC quantized terrain at Jezero, with the full corresponding Gazetteer and geographic names enabled. No terrain artifacts were generated or modified by this PR.

- **Moon**: anchor `terrain-sample`; center probe hit rendered `terrain` at -89.67000000° geodetic N, 129.78000000° E. 1 labels, 182 candidates; warm frame median/p95 16.70/16.80 ms.
- **Mars**: anchor `reference-shape`; center probe hit rendered `terrain` at 18.61185035° geodetic N, 77.68730002° E. 13 labels, 67 candidates; warm frame median/p95 16.70/16.80 ms.

Moon used resident physical terrain. Mars explicitly retained the reference-shape anchor because the source terrain reports an areoid datum; no areoid-to-ellipsoid conversion was invented. Visual surface/annotation checks used the scenes' declared natural illumination. Camera-facing samples are source anchors, not surveyed feature boundaries.

Validation: 11 Python tests; full Vitest **210 files passed / 1 skipped, 2,433 tests passed / 7 skipped**; build, test/viewer/Svelte type checks and lint passed. An unchanged CSPICE progress-throttle timing test failed in earlier runs on this fast machine and passed in the final full suite; no SPICE code or tests were changed. Viewer production build completed with its existing bundle-size warning. Browser smoke and Python regressions are CI gates; measured terrain is optional because CI does not ship the local terrain pyramids.
