# Self-hosted Mars terrain (MOLA/HRSC + Jezero HiRISE)

One quantized-mesh pyramid for Mars, consumed by the `quantized-mesh` path in
`packages/three/src/TerrainManager.ts` and streamed by
`apps/viewer/test-catalogs/ingenuity-jezero.json`.

```bash
./01-fetch-sources.sh   # ~13 GB of public USGS GeoTIFFs into data/source/
./fused.sh              # ~5 min, peak RAM ≈ 12 GB
node ../validate-terrain.mjs --preset mars-jezero-fused
```

Output: `apps/viewer/test-catalogs/data/mars-terrain-fused/` (`layer.json`,
`z/x/y.terrain`, `terrain-product.json`, `fusion.json`; ~6 GB, gitignored, not on the
deployed site yet — see #137).

## Sources (public, no auth)

- **Canonical global:** USGS Mars MGS MOLA – MEX HRSC Blended DEM Global 200 m.
- **Regional detail:** USGS Mars 2020 TRN HiRISE DTM mosaic, 1 m
  (`MOLAtopography_DeltaGeoid`). Both are MOLA-areoid heights on the
  Mars 2000 sphere; the renderer places them as IAU-ellipsoid heights.

## How it is built

`../terrain/dem.py fuse` treats HiRISE as detail over MOLA/HRSC, not a
replacement: residual = HiRISE − MOLA/HRSC, tapered to zero over 1 km inside
the HiRISE coverage edge. The fitted planar bias between the two (−8.7 m,
~1 m/km) is disclosed in `fusion.json` but kept (`--bias none`), because the
Ingenuity airfield elevations are in the HiRISE frame. `dem.py tile` then
writes every level from height = base + residual with full-resolution shared
edges, Mars-ellipsoid tile centres and oct-encoded normals, so there is no
source boundary, no same-LOD crack and nothing to repair afterwards. Results
and the before/after comparison are in `docs/terrain-validation.md`.

This replaced a CTB (Docker) pipeline that composited HiRISE over MOLA with a
hard switch and then patched the result: tile-centre rewriting, parent-edge
sync, deleting tiles outside HiRISE, and a calibrated
`referenceRadiusOffsetKm`. It lives in git history before #50.

## Not covered

Imagery is independent of this terrain: the Viking, global CTX and Jezero
CTX/HiRISE overlays stay catalog configuration rendered by `ImageOverlayPlugin`.
