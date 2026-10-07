# Demo globe fallback maps from public mosaics

Rebuilds the static globe maps in `apps/viewer/test-catalogs/textures/` that
are derived from public-domain sources: USGS Astrogeology mosaics, NASA Blue
Marble and Photojournal originals (#122). The inventory, the
provenance of every map and the load-cost measurements live in that
directory's `README.md`.

```bash
python3 -m venv .venv                          # gitignored
.venv/bin/pip install -r requirements.txt
./fetch-sources.sh                             # sources into data/source/ (gitignored, ~780 MB)
.venv/bin/python build.py                      # all recipes; or: .venv/bin/python build.py ceres
```

Needs Python 3.10+. `mercury` and `mars` stream their USGS mosaics (about
9 GB and 5 GB) through HTTP range requests instead of downloading them, and
cache only the 4096-wide reduction under `data/source/decimated/`; expect a
few minutes on a fast connection. The output is deterministic: with the versions pinned in
`requirements.txt`, a rebuild from fresh sources is byte-identical to the
committed files. Other Pillow/numpy versions work but may encode different
bytes.

`.dds` files and `earth-8k.jpg` are LFS-routed, so committing a rebuilt one
needs `git lfs` with write access to the repository.

| Recipe | Output | Source |
|---|---|---|
| `ceres` | `ceres.jpg`, 4096×2048 grey JPEG | Ceres Dawn FC DLR global 20ppd (Oct 2015), 7383×3691, 27 MB |
| `charon` | `charon.jpg`, 4096×2048 grey JPEG | Charon New Horizons global mosaic 300 m (Jul 2017), 12693×6347, 81 MB |
| `pluto` | `pluto.jpg`, 4096×2048 colour JPEG | Pluto New Horizons global mosaic 300 m (Jul 2017), 24888×12444, 310 MB; chroma from the previous `pluto.jpg` (git history) |
| `titan` | `titan.dds`, 4096×2048 DXT1 + mips | Titan Cassini ISS P19658 global mosaic 4 km, 4040×2020, 8 MB |
| `mercury` | `mercury.dds`, 4096×2048 DXT1 + mips | MESSENGER MDIS LOI + BDR 166 m basemaps (4.2 GB each, streamed), MD3 colour 665 m (0.8 GB, streamed) |
| `venus` | `venus.dds`, 4096×2048 DXT1 + mips | Magellan C3-MDIR colourised global mosaic, 8192×4096, 100 MB |
| `earth` | `earth-8k.jpg`, 8192×4096 colour JPEG | Blue Marble NG July 2004 topo-bathy, 21600×10800, 27 MB |
| `mars` | `mars.dds`, 4096×2048 DXT1 + mips | Viking colour mosaic 925 m (0.8 GB, streamed) × Viking MDIM 2.1 232 m detail (4.2 GB, streamed) |
| `jupiter` | `jupiter.jpg`, 4096×2048 colour JPEG | Cassini PIA07782 TIF, 3601×1801, 19 MB |
| `saturn_rings` | `saturn-rings.png`, 4096×2 RGBA | Cassini PIA11142 TIF, 12126×1439, 52 MB; alpha from the previous `saturn-rings.png` (git history) |
| `mimas` | `mimas.dds`, 4096×2048 DXT1 + mips | DLR Cassini Mimas basemap (Jun 2017), 5760×2880, in a 39 MB zip |

`rotate-dds-180.py` is a one-off, not a recipe: it rotated the seven
Cosmographia `.dds` maps that are stored upside-down and mirrored (see the
textures README, "Orientation").

## Adding a recipe

- **Longitude.** Cosmolabe maps put −180° at the left edge and the prime
  meridian at the centre, east to the right. Check the source `.lbl`
  (`CenterLongitude`, `LongitudeDirection`). The Ceres, Pluto and Titan
  mosaics run 0–360° E from their left edge and need a half-width roll
  (`load_usgs(..., center_lon=180)`), as does PIA07782; Charon, Mercury,
  Venus, Mars and Mimas are already centred on 0°. Every one so far is
  east-to-the-right regardless of its `LongitudeDirection` label (Titan's
  says PositiveWest). Don't trust a label alone: confirm by correlating
  against the current map (high-pass both at 512 px, search shift and
  mirror). Expect zero shift or exactly half the width, and no mirror.
- **No-data.** USGS mosaics mark gaps (usually polar) with 0. Mask them,
  erode and feather the mask, and fill (`valid_mask`, `gap_fill`) so no
  black cap or hard edge reaches the globe. `gap_fill` works across gaps
  hundreds of pixels tall (Pluto's and Charon's polar-night south), where a
  single small-σ extrapolation runs out of support and goes black.
- **Don't trust the map you are replacing either.** The previous
  `pluto.jpg`, `venus.dds`, `triton.dds` and the Uranian moons' maps were
  rotated 180°; registering against a USGS mosaic is what exposed them.
  Finish with a viewer check: a body-fixed viewpoint over a known feature.
- **Size and format.** 4096×2048 is the default ceiling for a static fallback
  (see the textures README for why; Earth is the one exception). Use JPEG for photographic maps that must
  work everywhere. DXT1 `.dds` is about 8× cheaper on the GPU but needs
  `WEBGL_compressed_texture_s3tc`, which `BodyMesh` has no fallback for.
- **Raw mosaics are not automatically better.** Frame seams, tonal patches and
  low-resolution regions in a raw mosaic can make it look worse than a curated
  map at demo range. Compare whole-globe and close-up crops before replacing
  anything; see "Tried and not adopted" in the textures README.
- Add a provenance entry to the textures README for every output.
