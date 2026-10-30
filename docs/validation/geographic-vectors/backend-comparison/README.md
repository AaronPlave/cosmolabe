# Geographic backend evidence

See [the comparison report](../../../geographic-backend-comparison.md) for interpretation, commands, data provenance and limitations.

- `earth.json`: independent 4K M4 Max Metal timings for surface-only, vector and native raster backends at five named views. Country geometry is identical; raster virtual subdivision differs by design.
- `measured.json`: final native-splitting-enabled Jezero/Shackleton orbit/detail/close runs. Zero diagnostics does **not** mean equal visual quality: the raster polar capture is visibly wrong for this preset.
- `quality.json`: flood-lit country/ocean/polar, hole/highlight and native-picking samples; CPU styling submission times, not asynchronous redraw completion latency.
- `borders.json`: all 944 real-viewer vertex/interior highlight samples passed. `chad-selected.png` and `rhine-hover.png` show continuous joins and shared boundaries.
- `pair-*.png`: two normal Earth viewers with identical named cameras, vectors left and native raster right. These paired captures are not timing workloads.
- `jezero-*.png`, `shackleton-*.png`: measured-surface captures. Polar raster strokes/points smear and obscure the hole; native splitting was enabled. Vector points remain CSS-sized.
- `software-smoke.json`: final 640×480 software WebGL normal-viewer smoke, for correctness only; not physical-GPU performance evidence.

PNG compression is lossless; decoded pixels were compared byte-for-byte with the original captures. Renderer/cache byte counts are estimates and do not measure driver GPU allocation or process RAM. Existing measured terrain must be generated/available locally; it is not bundled here. Mobile hardware was owner-waived. Absolute datum-height drawing and mesh/DSK attachment remain outside this delivery.
