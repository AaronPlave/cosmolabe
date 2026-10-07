# Demo globe textures

Static body maps for the example catalogs: the far-distance / low-detail
fallback every globe shows before (or instead of) streamed imagery. This file
is the inventory and provenance record asked for in #122. Keep it current when
adding or replacing a map.

All maps are simple cylindrical (equirectangular): longitude −180° at the left
edge (u = 0), the prime meridian at the centre, east to the right, north up.
`BodyMesh.loadTexture` picks the loader from the extension (magic bytes for
dropped `blob:` files): `.dds` is parsed as S3TC/DXT, anything else goes
through `THREE.TextureLoader`.

## Inventory

*GPU MiB* is what the texture occupies once uploaded: the DXT payload for
`.dds`; RGBA8 plus the generated mip chain (×4/3) for JPG/PNG. A JPG's small
download says nothing about its GPU cost (compare `charon.jpg`).

| File | Pixels | Format | File MiB | GPU MiB | Provenance | Used by |
|---|---|---|--:|--:|---|---|
| `ariel.dds` | 2048×1024 | DXT1 + 12 mips | 1.3 | 1 | Cosmographia `data/textures/ariel.dds` | base/uranus-system |
| `callisto.dds` | 2048×1024 | DXT1 + 12 mips | 1.3 | 1 | Cosmographia `data/textures/callisto.dds` | base/jupiter-galilean, europa-clipper |
| `ceres.jpg` | 4096×2048 | JPG (grey) | 2.5 | 43 | **USGS / DLR Dawn FC global mosaic**, see [below](#ceresjpg) | base/dwarf-planets, base/main-belt-named, solar-system |
| `charon.jpg` | 9520×4760 | JPG (grey) | 1.1 | 230 | unknown | base/pluto-system |
| `dione-1k.jpg` | 1024×512 | JPG | 0.2 | 3 | `dione.dds` at its 1024×512 mip (#94) | home-screen hero (`src/lib/hero.ts`) |
| `dione.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/dione.dds` | base/saturn-major-moons, cassini-soi |
| `earth-5k.jpg` | 5400×2700 | JPG | 2.2 | 74 | unknown (dimensions match NASA Blue Marble's 5400×2700 release) | base/earth-system, solar-system, iss, lro-moon, moonfall-shackleton, atmosphere-earth-* |
| `enceladus.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/enceladus.dds` | base/saturn-major-moons, cassini-soi |
| `europa.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/europa.dds` | base/jupiter-galilean, europa-clipper |
| `ganymede.dds` | 2048×1024 | DXT1 + 12 mips | 1.3 | 1 | Cosmographia `data/textures/ganymede.dds` | base/jupiter-galilean, europa-clipper |
| `iapetus.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/iapetus.dds` | base/saturn-major-moons, cassini-soi |
| `io.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/io.dds` | base/jupiter-galilean, europa-clipper |
| `jupiter.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/jupiter.dds` | base/jupiter, europa-clipper, solar-system |
| `mars.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/mars.dds` | base/mars, solar-system, ingenuity-jezero, msl-dingo-gap, atmosphere-mars-textured |
| `mercury.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/mercury.dds` | base/mercury, solar-system |
| `mimas.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/mimas.dds` | base/saturn-major-moons, cassini-soi |
| `miranda.dds` | 1024×512 | DXT1 + 11 mips | 0.3 | 0.3 | Cosmographia `data/textures/miranda.dds` | base/uranus-system |
| `moon-16k.jpg` | 16384×8192 | JPG | 40.6 | 683 | unknown | lro-moon, moonfall-shackleton |
| `moon-2k.jpg` | 2048×1024 | JPG | 0.5 | 11 | unknown | solar-system |
| `moon-4k.jpg` | 4096×2048 | JPG | 2.0 | 43 | unknown | base/earth-system |
| `moon-displacement-16k.jpg` | 16384×8192 | JPG (grey) | 9.4 | 683 | unknown | **nothing** (LFS object kept alive only by this tree) |
| `moon-displacement-2k.jpg` | 2048×1024 | JPG (grey) | 0.3 | 11 | unknown | base/earth-system, lro-moon, moonfall-shackleton |
| `moon-normal-16k.jpg` | 16384×8192 | JPG | 5.3 | 683 | unknown | base/earth-system, lro-moon, moonfall-shackleton |
| `neptune.jpg` | 1024×512 | JPG | 0.01 | 3 | Cosmographia `data/textures/neptune.jpg` | base/neptune-system, voyagers |
| `oberon.dds` | 2048×1024 | DXT1 + 12 mips | 1.3 | 1 | Cosmographia `data/textures/oberon.dds` | base/uranus-system |
| `pluto.jpg` | 5999×3000 | JPG | 1.0 | 92 | unknown | base/pluto-system |
| `rhea.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/rhea.dds` | base/saturn-major-moons, cassini-soi |
| `saturn-rings.png` | 1024×2 | PNG | 0.003 | 0 | Cosmographia `data/textures/saturn-rings.png` | base/saturn, cassini-soi, oem-ingest, atmosphere-saturn-shadow |
| `saturn.jpg` | 1024×512 | JPG | 0.03 | 3 | Cosmographia `data/textures/saturn.jpg` | base/saturn, solar-system, cassini-soi, oem-ingest, atmosphere-saturn-shadow |
| `sun.jpg` | 512×256 | JPG | 0.1 | 1 | Cosmographia `data/textures/sun.jpg` | base/sun, solar-system |
| `tethys.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/tethys.dds` | base/saturn-major-moons, cassini-soi |
| `titan.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/titan.dds` | base/saturn-major-moons, cassini-soi |
| `titania.dds` | 2048×1024 | DXT1 + 12 mips | 1.3 | 1 | Cosmographia `data/textures/titania.dds` | base/uranus-system |
| `triton.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/triton.dds` | base/neptune-system |
| `umbriel.dds` | 2048×1024 | DXT1 + 12 mips | 1.3 | 1 | Cosmographia `data/textures/umbriel.dds` | base/uranus-system |
| `uranus-rings.png` | 1024×2 | PNG | 0.0003 | 0 | Cosmographia `data/textures/uranus-rings.png` | base/uranus-system |
| `uranus.jpg` | 512×256 | JPG | 0.004 | 1 | Cosmographia `data/textures/uranus.jpg` | base/uranus-system, voyagers |
| `venus.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/venus.dds` | base/venus, solar-system |

"Cosmographia `…`" means **byte-identical** to that file in
[claurel/cosmographia](https://github.com/claurel/cosmographia) (git blob
hashes compared against its tree). The same holds for nine maps under
`../models/` (`deimos.dds`, `phobos.dds`, `phobos-normals.dds`,
`eros-normals.dds`, `itokawa-normals.dds`, `phoebe-normals.dds`,
`vesta-normals.dds`, `voyager-tex1.dds`, `voyager-tex2.dds`). "unknown" means
no match there and no record in git history; every map was added in one
commit (e7a583b) with no source note.

### Provenance gap

`scripts/fetch-cosmographia-data.sh` declines to vendor Cosmographia data
because that repository has no license, which makes redistributing it from
this Apache-2.0 repo "a rights question we have no answer to". 37 of the
committed maps (28 here, 9 under `../models/`) are exactly such copies. The
underlying imagery is mostly NASA/JPL mission data, but the derived maps
themselves carry no stated terms. Resolving that is the owner's call: obtain
terms, fetch at build time like the kernels, or replace each one with a
derivative of a public-domain source using `scripts/build-globe-textures/`.

## Derived maps in this directory

Rebuilt by `scripts/build-globe-textures/` (`fetch-sources.sh`, then
`build.py`). The build is deterministic: a rebuild from fresh sources is
byte-identical.

### `ceres.jpg`

- **Source:** *Ceres Dawn FC DLR global 20ppd Oct2015*, Dawn Framing Camera
  global mosaic by DLR (Roatsch et al.), distributed by USGS Astrogeology:
  `https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Ceres_Dawn_FC_DLR_global_20ppd_Oct2015.tif`
  (7383×3691, 8-bit, 400 m/px). NASA/DLR mission data; public domain in the
  US. Credit: NASA/JPL-Caltech/UCLA/MPS/DLR/IDA.
- **Processing:** roll by half the width (the mosaic runs 0–360° E from
  its left edge); Lanczos to 4096×2048; fill the south-polar no-data gap by
  normalized-convolution extrapolation (σ = 48 px) behind a 6 px feathered
  mask; grey JPEG, quality 90.
- **Replaced:** a 512×256 PNG (a pre-Dawn reconstruction from Cosmographia)
  with no recognisable surface detail.

## Load cost

Measured with `node scripts/measure-globe-textures.mjs` (fresh page per map,
second of two runs; the first, cold run is noisier). The `load` column is
fetch plus decode; `upload` is the synchronous `renderer.initTexture` that
`BodyMesh.loadGlobeTextures` takes eagerly, plus `gl.finish()`. Chromium
decodes an `<img>` lazily, so a JPG's decode lands in `upload`. *RSS Δ* is the
growth of all Chromium processes over load and upload.

Like `scripts/visual-regression.mjs`, this runs on SwiftShader (software GL,
4 cores), so upload times are CPU-bound upper bounds. Read them relative to
each other, not as desktop-GPU frame costs.

| Map | Pixels | File MiB | GPU MiB | load ms | upload ms | RSS Δ MiB |
|---|---|--:|--:|--:|--:|--:|
| `ceres.png` (old) | 512×256 | 0.1 | 0.7 | 6 | 7 | 7 |
| `ceres.jpg` (new) | 4096×2048 | 2.5 | 42.7 | 20 | 145 | 79 |
| `moon-4k.jpg` | 4096×2048 | 2.0 | 42.7 | 18 | 158 | 101 |
| `earth-5k.jpg` | 5400×2700 | 2.2 | 74.2 | 23 | 341 | 99 |
| `mars.dds` | 4096×2048 | 5.3 | 5.3 | 60 | 13 | 32 |
| `jupiter.dds` | 4096×2048 | 5.3 | 5.3 | 44 | 7 | 32 |
| `saturn.jpg` | 1024×512 | 0.03 | 2.7 | 5 | 11 | 8 |
| `pluto.jpg` | 5999×3000 | 1.0 | 91.5 | 13 | 1140 | 106 |
| `charon.jpg` | 9520×4760 | 1.1 | 230.5\* | 12 | 2546 | 489 |
| `moon-normal-16k.jpg` | 16384×8192 | 5.3 | 682.7\* | 49 | 2426 | 453 |
| `moon-16k.jpg` | 16384×8192 | 40.6 | 682.7\* | 155 | 2750 | 485 |

\* On a GPU whose `MAX_TEXTURE_SIZE` covers the image. SwiftShader reports
8192, so three.js (`WebGLTextures.resizeImage`) first downsizes these on a
2D canvas on the main thread. That is part of the upload time above, and the
GPU then holds ≈171 MiB (8192×4096) instead of 683. Many mobile GPUs report
8192 or less. On them the 16k maps cost the full download,
decode and a canvas resize, and still display at 8k.

What this means:

- **The largest fallback is the Moon at 16k.** lro-moon and moonfall-shackleton
  load `moon-16k.jpg` *and* `moon-normal-16k.jpg`: about 1.37 GiB of GPU memory
  on a 16k-capable GPU, plus about 0.5 GiB of transient decode memory each, and
  a 40 MiB download.
- **The base library already carries a 16k map.** `base/earth-system` pairs a
  4k colour map with `moon-normal-16k.jpg`. Every catalog that requires it
  loads 683 MiB of normal map for relief four times finer than the colour map
  it lights: Solar System (featured), Inner Planets, Voyagers, Psyche and the
  Earth–Moon tour. A 4k normal map there would cost 43 MiB.
- **Non-power-of-two and odd-sized JPGs are expensive for what they show.**
  `charon.jpg` is a 1.1 MiB greyscale download that becomes 230 MiB of RGBA
  on the GPU. `pluto.jpg` becomes 92 MiB.
- **DXT1 is about 8× cheaper on the GPU than JPG** at the same pixel count, and
  uploads in milliseconds. It depends on `WEBGL_compressed_texture_s3tc`,
  though. `BodyMesh` has no fallback when the extension is missing (common on
  Android GPUs), and three.js then logs "unsupported compressed texture
  format" and the globe renders untextured. KTX2/Basis (transcodes to
  whatever the GPU supports) would keep the memory win without that hole.
- **Ceres (this change)** goes from about 0.7 to 43 MiB GPU and about 7 to
  145 ms upload in SwiftShader. That is the same cost as `moon-4k.jpg`, which
  the same demos already pay. It is a JPG rather than DDS so it works without
  S3TC.

## Tried and not adopted

- **Ganymede / Callisto from USGS global mosaics** (Voyager–GalileoSSI colour
  1435 m and greyscale 1 km), 2k → 4k. They register against the current maps
  at the 512 px scale (half-width roll, no mirror), but drift 0–4 px locally at
  2k, which rules out a simple detail transfer. Using USGS as the base gives
  real crater detail, but it shows frame seams as tonal patches, and polar
  no-data has to be patched. Callisto also has large regions of low-resolution
  Voyager coverage that come out *smoother* than the current map. Taking only
  the high frequencies from USGS hid the tonal patches but not the seam lines.
  Neither was a clear improvement at demo range. A proper fix needs local
  seam balancing (or USGS's controlled colour products where they exist).
- **Saturn from Solar System Scope** (`8k_saturn.jpg`, CC BY 4.0, really
  4096×2048). Sharper, but smoother and more saturated than the current map,
  with less real cloud structure. Not an improvement, just a different look.

## Static fallback vs streamed imagery

| Body | Recommendation |
|---|---|
| Moon | **Stream.** Keep the static fallback at 4k colour + 4k normal. lro-moon and moonfall-shackleton already stream LRO WAC tiles from Trek, which take over at close range; the 16k maps sit under them at 1.37 GiB of GPU memory. |
| Mars | **Stream** for surface demos (ingenuity-jezero and msl-dingo-gap already stream Viking MDIM / CTX / HiRISE from Trek); 4k DXT1 is right for the fallback. |
| Earth | **Stream** for close range. 5400×2700 is adequate at orbital distance; the next static step (8k) costs 171 MiB as RGBA. |
| Mercury, Ceres, Vesta | **Stream** if a demo ever approaches; MESSENGER and Dawn global mosaics are hundreds of MB to GB at full resolution. 4k static is the ceiling. |
| Jupiter, Saturn, Uranus, Neptune | **Static.** Banded / near-featureless global maps; tiling buys nothing. Saturn is due a better 4k source (see above), Uranus and Neptune at 512–1024 px are enough for their faint banding. |
| Galilean and Saturnian moons, Triton, Pluto, Charon | **Static**, 4k. Source mosaics are 0.3–1.4 km/px, so 4k (about 4–8 km/px) is where source detail stops being worth the memory for a flyby demo. Charon and Pluto should come *down* to 4k (or DXT1); their current odd sizes cost 230 and 92 MiB. |
| Uranian moons, Miranda, Sun | **Static**, 1–2k. Voyager 2 imaged only the southern hemispheres; the Sun is a procedural/emissive surface. |
