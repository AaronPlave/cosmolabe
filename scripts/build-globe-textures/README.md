# Demo globe fallback maps from public mosaics

Rebuilds the static globe maps in `apps/viewer/test-catalogs/textures/` that
are derived from public USGS Astrogeology mosaics (#122). The inventory, the
provenance of every map and the load-cost measurements live in that
directory's `README.md`.

```bash
python3 -m venv .venv                          # gitignored
.venv/bin/pip install -r requirements.txt
./fetch-sources.sh                             # public-domain USGS mosaics into data/source/ (gitignored, ~420 MB)
.venv/bin/python build.py                      # all recipes; or: .venv/bin/python build.py ceres
```

Needs Python 3.10+. The output is deterministic: with the versions pinned in
`requirements.txt`, a rebuild from fresh sources is byte-identical to the
committed files. Other Pillow/numpy versions work but may encode different
bytes.

`.dds` files are LFS-routed, so committing a rebuilt one needs `git lfs`
with write access to the repository.

| Recipe | Output | Source |
|---|---|---|
| `ceres` | `ceres.jpg`, 4096×2048 grey JPEG | Ceres Dawn FC DLR global 20ppd (Oct 2015), 7383×3691, 27 MB |
| `charon` | `charon.jpg`, 4096×2048 grey JPEG | Charon New Horizons global mosaic 300 m (Jul 2017), 12693×6347, 81 MB |
| `pluto` | `pluto.jpg`, 4096×2048 colour JPEG | Pluto New Horizons global mosaic 300 m (Jul 2017), 24888×12444, 310 MB; chroma from the previous `pluto.jpg` (git history) |
| `titan` | `titan.dds`, 4096×2048 DXT1 + mips | Titan Cassini ISS P19658 global mosaic 4 km, 4040×2020, 8 MB |

## Adding a recipe

- **Longitude.** Cosmolabe maps put −180° at the left edge and the prime
  meridian at the centre, east to the right. Check the source `.lbl`
  (`CenterLongitude`, `LongitudeDirection`). The USGS global mosaics used so
  far run 0–360° E from their left edge and need a half-width roll
  (`load_usgs(..., center_lon=180)`); Charon's is already centred on 0°.
  Every one so far is east-to-the-right regardless of its
  `LongitudeDirection` label (Titan's says PositiveWest). Don't trust a label alone: confirm by correlating against the
  current map (high-pass both at 512 px, search shift and mirror). An exact
  half-width shift with no mirror is the expected answer.
- **No-data.** USGS mosaics mark gaps (usually polar) with 0. Mask them,
  erode and feather the mask, and fill (`valid_mask`, `gap_fill`) so no
  black cap or hard edge reaches the globe. `gap_fill` works across gaps
  hundreds of pixels tall (Pluto's and Charon's polar-night south), where a
  single small-σ extrapolation runs out of support and goes black.
- **Don't trust the map you are replacing either.** The previous `pluto.jpg`
  was rotated 180°; its registration against the USGS mosaic is what
  exposed it.
- **Size and format.** 4096×2048 is the default ceiling for a static fallback
  (see the textures README for why). Use JPEG for photographic maps that must
  work everywhere. DXT1 `.dds` is about 8× cheaper on the GPU but needs
  `WEBGL_compressed_texture_s3tc`, which `BodyMesh` has no fallback for.
- **Raw mosaics are not automatically better.** Frame seams, tonal patches and
  low-resolution regions in a raw mosaic can make it look worse than a curated
  map at demo range. Compare whole-globe and close-up crops before replacing
  anything; see "Tried and not adopted" in the textures README.
- Add a provenance entry to the textures README for every output.
