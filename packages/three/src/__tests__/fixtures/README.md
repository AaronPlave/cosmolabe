# Terrain test fixtures

`marshub-*.terrain` are real quantized-mesh-1.0 tiles from the Mars Hub
`mars_v14` tileset (`https://marshub.s3.amazonaws.com/mars_v14/{z}/{x}/{y}.terrain`),
the same source `apps/viewer/test-catalogs/msl-dingo-gap.json` streams. They are
stored decompressed (the server sends them with `Content-Encoding: gzip`, which
the browser strips before `parseToMesh` sees the buffer).

They exist so the CPU sampler's load path is tested against real triangulated
terrain rather than a synthetic grid. Both tiles are irregular TINs whose
vertices do not form a U×V raster — the case that makes grid reconstruction
wrong.
