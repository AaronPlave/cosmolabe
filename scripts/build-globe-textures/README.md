# Demo globe fallback maps from public mosaics

Rebuilds the static globe maps in `apps/viewer/test-catalogs/textures/` that
are derived from public-domain sources: USGS Astrogeology mosaics, NASA Blue
Marble and Photojournal originals (#122). The inventory, the
provenance of every map and the load-cost measurements live in that
directory's `README.md`.

```bash
python3 -m venv .venv                          # gitignored
.venv/bin/pip install -r requirements.txt
./fetch-sources.sh                             # verified sources into data/source/ (gitignored, ~1 GB)
.venv/bin/python build.py                      # all recipes; or: .venv/bin/python build.py ceres
.venv/bin/python build.py --verify             # check committed outputs against outputs.sha256
```

Needs Python 3.10+. `mercury` and `mars` stream their USGS mosaics (about
9 GB and 5 GB) through HTTP range requests instead of downloading them, and
cache only the 4096-wide reduction under `data/source/decimated/`; expect a
few minutes on a fast connection.

**Integrity and reproducibility.**
- `sources.sha256` pins every input: a sha256 and an origin (URL, or
  `git:<full commit>:<path>` for a blob from this repository's history).
- `fetch-sources.sh` downloads to a `.part` file and renames it only once
  the hash matches. A cached file that no longer matches is fetched again,
  and a mismatching download stops the script.
- `build.py` re-checks each input when it reads it.
- The streamed mosaics are pinned by a content digest (the sha256 of
  per-chunk sha256s of the pixel data) checked while streaming, before
  anything is used or cached.
- `outputs.sha256` pins every output. Each build reports OK or MISMATCH per
  output, and `--verify` checks the committed files.

With the versions pinned in `requirements.txt`, a rebuild from verified
sources is byte-identical to the committed files. Other Pillow/numpy
versions work but may encode different bytes. When an upstream file is
replaced on purpose, update its `sources.sha256` line and the affected
`outputs.sha256` entries in the same commit as any recipe change it needs.

`.dds` files and `earth-8k.jpg` are LFS-routed, so committing a rebuilt one
needs `git lfs` with write access to the repository.

| Recipe | Output | Source |
|---|---|---|
| `ceres` | `ceres.jpg`, 2048×1024 grey JPEG | Ceres Dawn FC DLR HAMO global 59 ppd / 140 m (Feb 2016), 21093×10546 ISIS cube, 224 MB |
| `charon` | `charon.jpg`, 4096×2048 grey JPEG | Charon New Horizons global mosaic 300 m (Jul 2017), 12693×6347, 81 MB |
| `pluto` | `pluto.jpg`, 4096×2048 colour JPEG | Pluto New Horizons global mosaic 300 m (Jul 2017), 24888×12444, 310 MB; chroma, **for now**, from the previous `pluto.jpg` (git history), to be replaced by the PDS MVIC global colour map |
| `titan` | `titan.dds`, 4096×2048 DXT1 + mips | Titan Cassini ISS controlled global mosaic 702 m (USGS 2025), 23048×11524 PNG, 73 MB |
| `mercury` | `mercury.dds`, 4096×2048 DXT1 + mips | MESSENGER MDIS LOI + BDR 166 m basemaps (4.2 GB each, streamed), MD3 colour 665 m (0.8 GB, streamed) |
| `venus` | `venus.dds`, 4096×2048 DXT1 + mips | Magellan C3-MDIR colourised global mosaic, 8192×4096, 100 MB |
| `earth` | `earth-8k.jpg`, 8192×4096 colour JPEG | Blue Marble NG July 2004 topo-bathy, 21600×10800, 27 MB |
| `mars` | `mars.dds`, 4096×2048 DXT1 + mips | Viking colour mosaic 925 m (0.8 GB, streamed) × Viking MDIM 2.1 232 m detail (4.2 GB, streamed) |
| `jupiter` | `jupiter.jpg`, 4096×2048 colour JPEG | Cassini PIA07782 TIF, 3601×1801, 19 MB |
| `saturn_rings` | `saturn-rings.png`, 4096×2 RGBA | colour: Cassini PIA11142 TIF, 12126×1439, 52 MB; alpha: Cassini RSS Rev 7 X-band optical-depth profile (PDS Rings `CORSS_8001`), 50 MB ASCII |
| `mimas` | `mimas.dds`, 4096×2048 DXT1 + mips | DLR Cassini Mimas basemap (Jun 2017), 5760×2880, in a 39 MB zip |

`rotate-dds-180.py` is a one-off, not a recipe: it rotated the seven
Cosmographia `.dds` maps that are stored upside-down and mirrored (see the
textures README, "Orientation").

## Adding a recipe

- **Longitude.** Cosmolabe maps put −180° at the left edge and the prime
  meridian at the centre, east to the right. Read the source label
  (`CenterLongitude`, `LongitudeDirection`, `MinimumLongitude`, corner
  coordinates). ISIS maps are always drawn east to the right;
  `LongitudeDirection` only says whether the longitude *numbers* count east
  or west. So a `CenterLongitude = 180` map (0–360°E from its left edge,
  whichever way it numbers them: Ceres Survey, Pluto, Titan, PIA07782) needs
  a half-width roll, and a `CenterLongitude = 0` one (Charon, Ceres HAMO,
  Mercury, Venus, Mars, Mimas) is already in place. Never mirror without a
  label that requires it.
- **Verify against ground truth, not just the map you replace.** Check the
  result at named features with IAU coordinates (bright/dark regions, large
  craters), as `titan.dds` and `venus.dds` were. Correlating against the old
  map (high-pass both at 512 px, search shift and mirror) is a useful second
  check, but the old map may itself be wrong: the previous `pluto.jpg`,
  `venus.dds`, `triton.dds` and the Uranian moons' maps were rotated 180°.
  Finish with a viewer check, a body-fixed viewpoint over a known feature.
- **No-data.** USGS mosaics mark gaps (usually polar) with 0. Mask them,
  erode and feather the mask, and fill (`valid_mask`, `gap_fill`) so no
  black cap or hard edge reaches the globe. `gap_fill` works across gaps
  hundreds of pixels tall (Pluto's and Charon's polar-night south), where a
  single small-σ extrapolation runs out of support and goes black.
- **Size and format.** 4096×2048 is the default ceiling for a static fallback
  (see the textures README for why; Earth is the one exception). Use JPEG for photographic maps that must
  work everywhere. DXT1 `.dds` is about 8× cheaper on the GPU but needs
  `WEBGL_compressed_texture_s3tc`, which `BodyMesh` has no fallback for.
- **Raw mosaics are not automatically better.** Frame seams, tonal patches and
  low-resolution regions in a raw mosaic can make it look worse than a curated
  map at demo range. Compare whole-globe and close-up crops before replacing
  anything; see "Tried and not adopted" in the textures README.
- **Memory.** Resample a large source in 8 bits (`load_usgs` does, per
  band) or stream it (`usgs_remote`), and work in float32 only at output
  size. Converting a full-resolution mosaic to float32 first costs about
  4 bytes per source pixel per copy: the Pluto recipe peaked at 3.8 GB that
  way and at 1.3 GB now.
- Pin every new input in `sources.sha256` and every output in
  `outputs.sha256`, and add a provenance entry to the textures README.
