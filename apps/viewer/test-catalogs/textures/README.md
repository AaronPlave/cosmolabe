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
download says nothing about its GPU cost (the previous 9520×4760 `charon.jpg`
was a 1.1 MiB download and 230 MiB on the GPU).

| File | Pixels | Format | File MiB | GPU MiB | Provenance | Used by |
|---|---|---|--:|--:|---|---|
| `ariel.dds` | 2048×1024 | DXT1 + 12 mips | 1.3 | 1 | Cosmographia `data/textures/ariel.dds`, rotated 180° ([Orientation](#orientation)) | base/uranus-system |
| `callisto.dds` | 2048×1024 | DXT1 + 12 mips | 1.3 | 1 | Cosmographia `data/textures/callisto.dds` | base/jupiter-galilean, europa-clipper |
| `ceres.jpg` | 2048×1024 | JPG (grey) | 0.9 | 11 | **USGS / DLR Dawn FC HAMO global mosaic**, see [below](#ceresjpg) | base/dwarf-planets, base/main-belt-named, solar-system |
| `charon.jpg` | 4096×2048 | JPG | 1.1 | 43 | **USGS New Horizons global mosaic** + **PDS MVIC colour**, see [below](#charonjpg) | base/pluto-system |
| `dione-1k.jpg` | 1024×512 | JPG | 0.2 | 3 | `dione.dds` at its 1024×512 mip (#94) | home-screen hero (`src/lib/hero.ts`) |
| `dione.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/dione.dds` | base/saturn-major-moons, cassini-soi |
| `earth-8k.jpg` | 8192×4096 | JPG | 4.7 | 171 | **NASA Blue Marble NG** July 2004 topo-bathy, see [below](#earth-8kjpg) | base/earth-system, solar-system, iss, lro-moon, moonfall-shackleton, atmosphere-earth-* |
| `enceladus.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/enceladus.dds` | base/saturn-major-moons, cassini-soi |
| `europa.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/europa.dds` | base/jupiter-galilean, europa-clipper |
| `ganymede.dds` | 2048×1024 | DXT1 + 12 mips | 1.3 | 1 | Cosmographia `data/textures/ganymede.dds` | base/jupiter-galilean, europa-clipper |
| `iapetus.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/iapetus.dds` | base/saturn-major-moons, cassini-soi |
| `io.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/io.dds` | base/jupiter-galilean, europa-clipper |
| `jupiter.jpg` | 4096×2048 | JPG | 0.9 | 43 | **Cassini PIA07782** lossless original, see [below](#jupiterjpg) | base/jupiter, europa-clipper, solar-system |
| `mars.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | **USGS Viking colour × MDIM 2.1 detail**, see [below](#marsdds) | base/mars, solar-system, ingenuity-jezero, msl-dingo-gap, atmosphere-mars-textured |
| `mercury.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | **USGS MESSENGER LOI + BDR, MD3 tint**, see [below](#mercurydds) | base/mercury, solar-system |
| `mimas.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | **DLR Cassini basemap 2017** (licence unconfirmed), see [below](#mimasdds) | base/saturn-major-moons, cassini-soi |
| `miranda.dds` | 1024×512 | DXT1 + 11 mips | 0.3 | 0.3 | Cosmographia `data/textures/miranda.dds`, rotated 180° ([Orientation](#orientation)) | base/uranus-system |
| `moon-16k.jpg` | 16384×8192 | JPG | 40.6 | 683 | NASA SVS CGI Moon Kit (2019), from EXIF | lro-moon, moonfall-shackleton |
| `moon-2k.jpg` | 2048×1024 | JPG | 0.5 | 11 | NASA SVS CGI Moon Kit (2019), from EXIF | solar-system |
| `moon-4k.jpg` | 4096×2048 | JPG | 2.0 | 43 | NASA SVS CGI Moon Kit (2019), from EXIF | base/earth-system |
| `moon-displacement-16k.jpg` | 16384×8192 | JPG (grey) | 9.4 | 683 | NASA SVS CGI Moon Kit (2019) `ldem_64`, from EXIF | **nothing** (LFS object kept alive only by this tree) |
| `moon-displacement-2k.jpg` | 2048×1024 | JPG (grey) | 0.3 | 11 | NASA SVS CGI Moon Kit (2019) `ldem_64`, from EXIF | base/earth-system, lro-moon, moonfall-shackleton |
| `moon-normal-16k.jpg` | 16384×8192 | JPG | 5.3 | 683 | unknown | base/earth-system, lro-moon, moonfall-shackleton |
| `neptune.jpg` | 1024×512 | JPG | 0.01 | 3 | Cosmographia `data/textures/neptune.jpg` | base/neptune-system, voyagers |
| `oberon.dds` | 2048×1024 | DXT1 + 12 mips | 1.3 | 1 | Cosmographia `data/textures/oberon.dds`, rotated 180° ([Orientation](#orientation)) | base/uranus-system |
| `pluto.jpg` | 4096×2048 | JPG | 1.4 | 43 | **USGS New Horizons global mosaic** + **PDS MVIC colour**, see [below](#plutojpg) | base/pluto-system |
| `rhea.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/rhea.dds` | base/saturn-major-moons, cassini-soi |
| `saturn-rings.png` | 4096×2 | PNG (RGBA) | 0.007 | 0.04 | **Cassini PIA11142** colour, **Cassini RSS** optical depth, see [below](#saturn-ringspng) | base/saturn, cassini-soi, oem-ingest, atmosphere-saturn-shadow, home-screen hero |
| `saturn.jpg` | 1024×512 | JPG | 0.03 | 3 | Cosmographia `data/textures/saturn.jpg` | base/saturn, solar-system, cassini-soi, oem-ingest, atmosphere-saturn-shadow |
| `sun.jpg` | 512×256 | JPG | 0.1 | 1 | Cosmographia `data/textures/sun.jpg` | base/sun, solar-system |
| `tethys.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/tethys.dds` | base/saturn-major-moons, cassini-soi |
| `titan.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | **USGS Cassini ISS global mosaic**, see [below](#titandds) | base/saturn-major-moons, cassini-soi |
| `titania.dds` | 2048×1024 | DXT1 + 12 mips | 1.3 | 1 | Cosmographia `data/textures/titania.dds`, rotated 180° ([Orientation](#orientation)) | base/uranus-system |
| `triton.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | Cosmographia `data/textures/triton.dds`, rotated 180° ([Orientation](#orientation)) | base/neptune-system |
| `umbriel.dds` | 2048×1024 | DXT1 + 12 mips | 1.3 | 1 | Cosmographia `data/textures/umbriel.dds`, rotated 180° ([Orientation](#orientation)) | base/uranus-system |
| `uranus-rings.png` | 1024×2 | PNG | 0.0003 | 0 | Cosmographia `data/textures/uranus-rings.png` | base/uranus-system |
| `uranus.jpg` | 512×256 | JPG | 0.004 | 1 | Cosmographia `data/textures/uranus.jpg` | base/uranus-system, voyagers |
| `venus.dds` | 4096×2048 | DXT1 + 13 mips | 5.3 | 5 | **USGS Magellan C3-MDIR colourised**, see [below](#venusdds) | base/venus, solar-system |

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
this Apache-2.0 repo "a rights question we have no answer to". 29 of the
committed maps (20 here, 9 under `../models/`) are exactly such copies (or,
for six of them, lossless 180° rotations of one). The
underlying imagery is mostly NASA/JPL mission data, but the derived maps
themselves carry no stated terms. Resolving that is the owner's call: obtain
terms, fetch at build time like the kernels, or replace each one with a
derivative of a public-domain source using `scripts/build-globe-textures/`.

## Derived maps in this directory

Rebuilt by `scripts/build-globe-textures/` (`fetch-sources.sh`, then
`build.py`; setup in that directory's README). The build is deterministic:
with the pinned `requirements.txt`, a rebuild from fresh sources is
byte-identical.

### `ceres.jpg`

- **Source:** *Ceres Dawn FC DLR global 59ppd Feb2016*, the Dawn Framing
  Camera HAMO (High Altitude Mapping Orbit) controlled global mosaic by DLR
  (Roatsch et al.), distributed by USGS Astrogeology as an ISIS cube:
  `https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Ceres_Dawn_FC_DLR_global_59ppd_Feb2016.cub`
  (21093×10546, 8-bit, 140 m/px, centred on 0°E). NASA/DLR mission data;
  public domain in the US. Credit: NASA/JPL-Caltech/UCLA/MPS/DLR/IDA.
- **Processing:** Lanczos to 2048×1024; grey JPEG, quality 90. No fill: the
  mosaic has data to both poles.
- **Orientation:** the label says `CenterLongitude = 0`, `PositiveEast`, so
  no roll. Checked at Occator (19.8°N 239.3°E = 120.7°W): its bright faculae
  sit at the centre of a crop taken at those coordinates.
- **Why this source:** compared at fallback size against the 400 m Survey
  mosaic (`Ceres_Dawn_FC_DLR_global_20ppd_Oct2015`, which this map used
  first): the two register at zero shift, but HAMO is sharper (Occator's
  faculae, crater rims) and complete, where Survey leaves a south-polar gap
  (about 4% of the map) that had to be extrapolated. HAMO's lower sun bakes
  stronger shading into the high latitudes. The 35 m LAMO mosaics (PDS SBN)
  would only matter for streamed close-up imagery.
- **Why 2048, not 4096:** Ceres only appears at a distance in the example
  catalogs (`solar-system`, the dwarf-planet and main-belt bases), where
  2048 (1.4 km/px) is already finer than the screen. 4096 cost 43 MiB of GPU
  memory and an extra eager upload in every catalog that includes Ceres; 2048
  costs 11 MiB. See [Load cost](#load-cost) for per-texture and
  catalog-level numbers.
- **Replaced:** a 512×256 PNG (a pre-Dawn reconstruction from Cosmographia)
  with no recognisable surface detail.

### `charon.jpg`

- **Luminance:** *Charon New Horizons Global Mosaic 300m Jul2017 8bit*, LORRI
  and MVIC, USGS Astrogeology (`…/mosaic/Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif`,
  12693×6347, already centred on 0°E). Credit: NASA/JHUAPL/SwRI; public
  domain in the US.
- **Colour:** *Global Color Map Mosaic of Charon from New Horizons MVIC
  Observations*, PDS Small Bodies Node, `nh_derived:plutosystem_composition`
  v1.0 (doi:10.26007/mc7j-ef52), `mosaic/nh_charon_color_mosaic.img`:
  3808×1904, four float32 bands of normal albedo (CH4 895 nm, NIR 870, Red
  625, Blue 475), MVIC scans photometrically normalised and registered to the
  LORRI base map. `longitude_of_central_meridian = 0`, so no roll; it
  registers against the USGS mosaic at zero shift, unmirrored.
- **Processing:** luminance Lanczos to 4096×2048 (no roll), the unimaged
  south (in polar night at the 2015 flyby) filled with `gap_fill`.
  Approximate natural colour from the cube (R = Red, B = Blue, G = their
  mean, for about 550 nm) gives a per-pixel colour ratio (rgb / luminance)
  that multiplies the luminance; outside the colour coverage (57% of the
  map) the ratio is the imaged area's mean. Colour JPEG, quality 90.
- **Check:** Mordor Macula, the red north-polar cap, has R/B 1.32; Vulcan
  Planitia and Oz Terra are neutral, 0.95–0.97.
- **Replaced:** a 9520×4760 grey JPEG of the same content (it registers
  against this mosaic at zero shift) with a black south. At that size it cost
  230 MiB of GPU memory and, on an 8192-limit GPU, a main-thread canvas resize.

### `pluto.jpg`

- **Luminance:** *Pluto New Horizons Global Mosaic 300m Jul2017 8bit*, USGS
  Astrogeology (`…/mosaic/Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif`,
  24888×12444, 0–360°E). Credit: NASA/JHUAPL/SwRI; public domain in the US.
- **Colour:** *Global Color Map Mosaic of Pluto from New Horizons MVIC
  Observations*, PDS SBN, same collection (doi:10.26007/mc7j-ef52),
  `mosaic/nh_pluto_color_mosaic.img`: 11487×5744, same four bands, 650 m/px.
  `longitude_of_central_meridian = 180` and upper-left x = −πR, so 0–360°E
  like the luminance mosaic: a half-width roll. With it, it registers against
  the USGS mosaic at zero shift (correlation 0.79; 0.07 without the roll,
  and the mirrored peak is an eighth of the true one). Colour covers every
  longitude north of about 20°S, the far side at approach resolution.
- **Processing:** luminance as for Charon (half-width roll, Lanczos to
  4096×2048 in 8 bits, `gap_fill` for the unimaged south); colour as for
  Charon. Colour JPEG, quality 90.
- **Check:** Cthulhu Macula is the reddest region, R/B 1.73; Sputnik
  Planitia (1.29) and Lowell Regio (1.26) are paler, as in published MVIC
  colour.
- **Replaced:** a 5999×3000 colour map covering only the encounter
  hemisphere (about two thirds of it was black) and **rotated 180°**. It
  centred Sputnik Planitia (about 175°E) on the map, where Cosmolabe puts
  0°E. The previous map registers against the USGS mosaic only *without*
  the half-width roll every other 0–360°E source needs. Checked in the
  viewer (built, `?test=1` capture of `base/pluto-system` at 2015-07-14,
  viewpoints at body-fixed 0°E and 180°E): with the old map the camera at
  180°E, over Sputnik Planitia, saw a black globe, and the heart sat on the
  sub-Charon hemisphere. With the new map the heart is at 180°E. (The
  viewpoint lat/lon path, `bodyFixedOffsetToWorld`, is tested against SPICE.)
  An interim build took its colour from that old map's chroma; the MVIC
  cube replaces it, so nothing in `pluto.jpg` now comes from an
  unprovenanced file.

### `titan.dds`

- **Source:** *Geodetically improved images and mosaics of Titan via rigorous
  photogrammetric control of Cassini Imaging Science Subsystem data*,
  Weller, Archinal, Redding, Karkoschka et al., USGS (2025),
  doi:10.5066/P14FAEKS: the equirectangular global mosaic at 702 m/px
  (23048×11524, 938 nm), 8-bit PNG release, from ScienceBase item
  `68a5107ad4be02198e361c35`. 6,896 ISS images in a bundle-adjusted control
  network tied to the Cassini RADAR geodetic frame (control points < 600 m
  in latitude and longitude). CC0-1.0.
- **Orientation, from the label:** `CenterLongitude = 180`,
  `LongitudeDirection = PositiveEast`, upper-left x = −πR, so the left edge
  is 0°E and the map runs 0–360°E: a half-width roll, no mirror. Registered
  against the P19658 mosaic it replaced, the two agree to within one pixel
  at 2048 wide (0.2°).
- **Orientation, checked against named features** (IAU coordinates, after
  the roll; mean brightness against a global mean of 129): Xanadu near
  10°S 100°W is bright, 175, as is Tui Regio at 24°S 125°W, 181; the Belet
  dune field near 5°S 255°W is dark, 43; Kraken Mare (68°N 310°W) and
  Ligeia Mare (79°N 248°W) read 97 and 111 against about 190 for their
  latitude.
- **Processing:** half-width roll, Lanczos to 4096×2048, the few no-data
  pixels (0.06%: a wedge near 60°S 85°E, slivers at the south pole)
  gap-filled, DXT1 with a full mip chain like the map it replaces.
- **Replaced:** Cosmographia's `titan.dds`, an early-Cassini mosaic with
  flat grey blocks where coverage was missing, most of the north among them.
  An interim build from the uncontrolled USGS P19658 4 km mosaic filled
  those but showed its image patchwork; the controlled mosaic is
  incidence-weighted and has no visible frame seams. The strong north-bright,
  south-dark gradient is in the release itself (haze and season at 938 nm)
  and is kept. Same size, same GPU cost.

### `mercury.dds`

- **Sources:** MESSENGER MDIS global basemaps, USGS Astrogeology, all
  92160×46080 at 166 m/px except MD3 (23040×11520, 665 m/px), already
  −180…180°E: `Mercury_MESSENGER_MDIS_Basemap_LOI_Mosaic_Global_166m.tif`
  (low-incidence: albedo, bright rays), `…_BDR_Mosaic_Global_166m.tif`
  (moderate incidence: relief), `…_MD3Color_Mosaic_Global_665m.tif`
  (colour). Credit: NASA/JHUAPL/Carnegie Institution of Washington, USGS;
  public domain in the US.
- **Processing:** each source area-averaged to 4096×2048 by streaming it
  through HTTP range requests (`usgs_remote`; 9 GB is read once and nothing
  large is stored). Luminance = 0.55 × LOI + 0.45 × BDR, each stretched to
  its 0.5–99.7 percentiles, with BDR filling LOI's polar no-data behind a
  feathered mask. Colour is a 35% tint from MD3 (its own stretch is too
  blue) and a slight warm balance. DXT1 with mips.
- **Replaced:** Cosmographia's map, BDR-like (registers within 1 px) with a
  warm tint and visible rectangular frame and tonal patches (Kuiper,
  Caloris). The new map has no frame patches and shows the ray systems.

### `venus.dds`

- **Source:** *Venus Magellan C3-MDIR Colorized Global Mosaic 4641m*, USGS
  Astrogeology (`…/mosaic/Venus_Magellan_C3-MDIR_Colorized_Global_Mosaic_4641m.tif`,
  8192×4096, −180…180°E, gaps already filled). Magellan SAR, so it is the
  radar surface, not what the eye would see (cloud tops). Credit: NASA/JPL,
  USGS; public domain in the US.
- **Processing:** Lanczos to 4096×2048, DXT1 with mips.
- **Replaced:** Cosmographia's map, which is stored **rotated 180°** (see
  [Orientation](#orientation)): its best registration against Magellan is
  with both axes flipped. In the viewer Maxwell Montes now sits under a
  65°N 3°E viewpoint.

### `mars.dds`

- **Sources:** *Mars Viking ClrMosaic global 925m* (23059×11530, colour)
  and *Mars Viking MDIM21 Mosaic global 232m* (92160×46080, grey,
  MOLA-controlled), USGS Astrogeology, both −180…180°E. Credit:
  NASA/JPL, USGS; public domain in the US.
- **Processing:** both streamed down to 4096×2048 (`usgs_remote`). The
  Viking colour mosaic has the familiar albedo and colour but is soft and
  posterised; MDIM 2.1 is sharp but grey. Luminance is Viking's times
  MDIM's high-pass (MDIM over a σ = 8 px blur of itself); colour is
  Viking's chroma. DXT1 with mips.
- **Replaced:** Cosmographia's map (registers within about 2 px), with a
  yellow cast and softer craters and canyons. Mars surface demos stream
  Trek imagery on top at close range; this is the far-range fallback.

### `earth-8k.jpg`

- **Source:** NASA Blue Marble Next Generation, July 2004, topography +
  bathymetry, 21600×10800:
  `https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/july/world.topo.bathy.200407.3x21600x10800.jpg`.
  Credit: NASA Earth Observatory (Reto Stöckli); public domain in the US.
- **Processing:** Lanczos to 8192×4096 as 8-bit RGB, JPEG quality 90.
- **Replaced:** `earth-5k.jpg` (removed), which was NASA's own 5400×2700 release of the
  same month (byte-identical, MD5 `3c9658c2…`). Same picture, crisper
  coastlines and relief at close range, at a GPU cost that goes from 74 to
  171 MiB (see [Load cost](#load-cost)).
### `jupiter.jpg`

- **Source:** Cassini ISS map of Jupiter, PIA07782 (December 2000), from the
  lossless TIF:
  `https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia07/pia07782/PIA07782.tif`
  (3601×1801 at 0.1°, 0°E at the left edge, the 360° column repeated).
  Credit: NASA/JPL/Space Science Institute; public domain in the US.
- **Processing:** drop the repeated column, roll by half the width, Lanczos
  to 4096×2048, JPEG quality 90.
- **Replaced:** `jupiter.dds`, this same image upscaled and DXT1-compressed
  (r = 0.9986 against the TIF at that roll). DXT1's 4×4 blocks gave it a
  green cast and banding in the belts, so the new map is a JPEG; same
  resolution, cleaner colour, 43 instead of 5 MiB on the GPU.

### `saturn-rings.png`

- **Colour source:** Cassini PIA11142, "A Full Sweep of Saturn's Rings"
  (natural colour, November 2008, about 6–7 km/px):
  `https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia11/pia11142/PIA11142.tif`
  (12126×1439). Credit: NASA/JPL/Space Science Institute; public domain in
  the US.
- **Opacity source:** the Cassini RSS X-band radio occultation of Rev 7
  egress (3 May 2005), normal optical depth at 1 km resolution, PDS Ring-Moon
  Systems Node `CORSS_8001` (Marouf et al.):
  `https://pds-rings.seti.org/holdings/volumes/CORSS_8xxx/CORSS_8001/data/Rev007/Rev007E/Rev007E_RSS_2005_123_X43_E/RSS_2005_123_X43_E_TAU_01KM.TAB`.
- **Processing, colour:** the radial profile is sampled along the straight
  line through the arcs' apexes, averaging 7 rows. The mosaic's scale drifts
  (about 6–10 km/px), so pixel position is mapped to radius piecewise
  linearly between 11 identified features (C ring inner edge, Colombo and
  Maxwell gaps, B ring edges, Laplace gap, A ring inner edge, Encke and
  Keeler gaps, A ring outer edge, F ring) and resampled to 4096 samples
  over 74,660–140,220 km.
- **Processing, opacity:** alpha is the opacity seen face-on, 1 − e^(−τ),
  per texel 1 minus the mean transmission of the 0.25 km samples it covers
  (so narrow gaps and ringlets average correctly). Samples at or above the
  profile's detection threshold, about 20% of the B ring, are opaque.
  Region means against the alpha the first version of this map borrowed
  from Cosmographia: C ring 0.17 (was 0.20), B ring 0.89 (0.93), Cassini
  Division 0.19 (0.27), A ring 0.56 (0.67).
- **Not represented:** the F ring. It is narrow and eccentric (its radius
  varies by about ±350 km with longitude), this occultation shows no F-ring
  core, and its mean radius sits on the texture's outer edge.
- **Replaced:** Cosmographia's 1024-sample ring texture. The B ring is now
  tan instead of grey-white, the C and A rings darker, with about 8× the
  radial detail. Both colour and opacity now come from measured data.

### `mimas.dds`

- **Source:** DLR Cassini ISS basemap of Mimas (Roatsch et al., 30 June
  2017), `Cassini_DLR/MI_170630_DLR_basemap_degrees.tif` from
  `…/mosaic/Mimas/Cassini_DLR_Mimas.zip` on the USGS Astrogeology bucket
  (5760×2880, grey, about 216 m/px, already −180…180°E). Credit:
  NASA/JPL-Caltech/SSI/DLR.
- **Licence: not confirmed.** The zip has no licence text and there is no
  USGS record for it. Sibling USGS-hosted Cassini basemaps are public domain
  and the map it replaces looks like an earlier version of the same DLR
  product, so redistributing it does not change this directory's position,
  but it is not documented either.
- **Processing:** Lanczos to 4096×2048, DXT1 with mips.
- **Replaced:** Cosmographia's map (registers at zero shift), which lacks
  most of the late-mission high-resolution coverage over roughly 0–90°E and
  the trailing hemisphere.

## Orientation

`.dds` maps are uploaded as stored (`CompressedTexture` ignores `flipY`), so
`BodyMesh` flips v in their texture transform to display them north-up like
JPG/PNG maps (#168). Before that fix every DDS globe showed upside-down.

Seven Cosmographia maps (`venus.dds`, `triton.dds`, `ariel.dds`,
`miranda.dds`, `oberon.dds`, `titania.dds`, `umbriel.dds`) are stored
**rotated 180°** relative to this convention. They are rotated back
losslessly at the DXT1 block level by
`scripts/build-globe-textures/rotate-dds-180.py` (`venus.dds` has since
been replaced outright). When adding a map, check its orientation against a
reference with known coordinates, not just by eye: register it against a
USGS mosaic, or point a body-fixed viewpoint at a known feature in the viewer.

## Load cost

Measured with `node scripts/measure-globe-textures.mjs`: each sample in a
fresh headless Chromium process (so allocator and cache state can't carry
over between maps), median of 3 samples. Columns:

- *load*: fetch plus decode.
- *initTexture*: the synchronous `renderer.initTexture` call alone, which
  is the main-thread time `BodyMesh.loadGlobeTextures` spends per map when it
  uploads eagerly. Chromium decodes an `<img>` lazily, so a JPG's decode
  lands here.
- *GPU finish*: a following `gl.finish()`, i.e. GPU completion, which the app
  does not wait for. It is reported separately so it isn't mistaken for a
  stall; in SwiftShader it is ~0 because the upload is already synchronous.
- *RSS Δ*: growth of that browser's processes across load and upload.

This runs on SwiftShader (software GL, 4 cores), like
`scripts/visual-regression.mjs`, so times are CPU-bound upper bounds: read
them relative to each other, not as desktop- or mobile-GPU frame costs.
Real-hardware numbers, especially on a constrained GPU, are still to be
taken (see below).

| Map | Pixels | File MiB | GPU MiB | load ms | initTexture ms | GPU finish ms | RSS Δ MiB |
|---|---|--:|--:|--:|--:|--:|--:|
| `ceres.png` (old) | 512×256 | 0.1 | 0.7 | 12 | 8 | 0 | 8 |
| `ceres.jpg` (new) | 2048×1024 | 0.9 | 10.7 | 13 | 38 | 0 | 32 |
| `moon-4k.jpg` | 4096×2048 | 2.0 | 42.7 | 14 | 172 | 0 | 93 |
| `earth-5k.jpg` (old) | 5400×2700 | 2.2 | 74.2 | 24 | 232 | 0 | 103 |
| `earth-8k.jpg` (new) | 8192×4096 | 4.7 | 170.7 | 30 | 574 | 0 | 189 |
| `mars.dds` (old and new) | 4096×2048 | 5.3 | 5.3 | 39 | 8 | 0 | 33 |
| `jupiter.dds` (old) | 4096×2048 | 5.3 | 5.3 | 80 | 8 | 0 | 33 |
| `jupiter.jpg` (new) | 4096×2048 | 0.9 | 42.7 | 9 | 152 | 0 | 88 |
| `saturn.jpg` | 1024×512 | 0.03 | 2.7 | 6 | 12 | 0 | 12 |
| `pluto.jpg` (old) | 5999×3000 | 1.0 | 91.5 | 11 | 280 | 0 | 126 |
| `pluto.jpg` (new)† | 4096×2048 | 1.4 | 42.7 | 14 | 187 | 0 | 83 |
| `charon.jpg` (old) | 9520×4760 | 1.1 | 230.5\* | 11 | 1338 | 0 | 495 |
| `charon.jpg` (new)† | 4096×2048 | 1.1 | 42.7 | 14 | 173 | 0 | 83 |
| `titan.dds` (old) | 4096×2048 | 5.3 | 5.3 | 48 | 6 | 0 | 32 |
| `titan.dds` (new) | 4096×2048 | 5.3 | 5.3 | 46 | 10 | 0 | 32 |
| `moon-normal-16k.jpg` | 16384×8192 | 5.3 | 682.7\* | 37 | 678 | 0 | 447 |
| `moon-16k.jpg` | 16384×8192 | 40.6 | 682.7\* | 217 | 1030 | 0 | 487 |

\* On a GPU whose `MAX_TEXTURE_SIZE` covers the image. SwiftShader reports
8192, so three.js (`WebGLTextures.resizeImage`) first downsizes these on a
2D canvas on the main thread. That is part of the initTexture time above,
and the GPU then holds ≈171 MiB (8192×4096) instead of 683. Many mobile GPUs
report 8192 or less. On them the 16k maps cost the full download, decode and
a canvas resize, and still display at 8k.

† Re-measured after their colour moved to the MVIC cubes, in a separate
run with 9 samples. In that run `jupiter.jpg` and `moon-4k.jpg`, as
controls, measured 174 and 184 ms initTexture (152 and 172 above): every
4096×2048 JPG costs about the same, colour or grey.

### Catalog level: Ceres in `solar-system`

Globe maps load as part of the catalog's initial assets and each is
uploaded eagerly, so per-texture costs add up. Measured on the built viewer
(`?catalog=solar-system&test=1`, headless SwiftShader, 1024×768), varying
only Ceres' map: median of 5 page loads, each in a fresh browser.

| Ceres map | Time to all initial assets ready | Main-thread long tasks, total | Longest task |
|---|--:|--:|--:|
| 512×256 PNG (old) | 7.25 s | 5.37 s | 1.73 s |
| 2048×1024 JPG (new) | 7.25 s | 5.60 s | 1.75 s |
| 4096×2048 JPG (first version of this change) | 7.63 s | 6.01 s | 1.67 s |

At 2048 the map adds about 0.2 s of main-thread work across the load and
nothing measurable to time-to-ready; 4096 added about 0.6 s and 0.4 s. The
longest task is something else in the catalog either way. These are
software-GL figures: the same comparison on a desktop GPU and on a
constrained mobile GPU is still to be done, and it matters most for the
JPG maps (Earth, Moon, Jupiter, Pluto, Charon, Ceres), whose decode and
RGBA upload dominate.

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
- **Odd-sized JPGs are expensive for what they show.** The previous
  `charon.jpg` was a 1.1 MiB greyscale download that became 230 MiB of RGBA
  on the GPU, and the previous `pluto.jpg` became 92 MiB. Both are now
  4096×2048 (43 MiB each).
- **DXT1 is about 8× cheaper on the GPU than JPG** at the same pixel count, and
  uploads in milliseconds. It depends on `WEBGL_compressed_texture_s3tc`,
  though. `BodyMesh` has no fallback when the extension is missing (common on
  Android GPUs), and three.js then logs "unsupported compressed texture
  format" and the globe renders untextured. KTX2/Basis (transcodes to
  whatever the GPU supports) would keep the memory win without that hole.
- **Times vary run to run** in SwiftShader, which is why each row is a
  median of fresh-browser samples. Compare rows, not absolute values.
- **Earth 8k doubles Earth's cost**: 74 → 171 MiB of GPU memory and about
  230 → 570 ms of initTexture in SwiftShader, in every catalog that shows Earth.
  The gain is crisper coastlines and relief at close range. If the hitch
  matters more (mobile, the featured Solar System tour), a 4096 or 5400
  resize of the same source is a one-line change to the `earth` recipe.
- **Jupiter** moves from DXT1 to JPG to lose DXT1's banding: 5 → 43 MiB and
  about 8 → 150 ms. Mercury, Mars, Venus and Mimas stay DXT1 at the same
  size and cost as before; the 4096-sample ring texture is negligible.
- **Ceres** goes from 0.7 to 11 MiB of GPU memory and about 8 → 38 ms of
  initTexture: a 2048 map rather than 4096 (which measured 43 MiB and about
  145 ms), because these costs add up per catalog (below). It is a JPG
  rather than DDS so it works without S3TC.

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
- **Saturn globe from Cassini ISS (Aug 2011, PDS Atmospheres
  `Cassini_ISS_RGB_Saturn_global_color_map_*.fits`).** Real storm-band
  detail, but the "original" version is flat orange and the
  contrast-enhanced one false colour, with 18% gaps (poles, ring shadow) and
  a seam at 0°. A hybrid of the current colour with its detail gained little.
- **Hubble OPAL global maps (2025, CC BY 4.0).** Jupiter shows today's
  smaller, redder Great Red Spot but is blurrier than Cassini above about
  30° latitude; Saturn, Uranus and Neptune (721×361 for the ice giants) are
  worse than the current maps. No public Voyager cylindrical maps of Uranus
  or Neptune were found.
- **Moon: CGI Moon Kit 2025 edition.** Bluer maria, much brighter and lower
  in contrast than the 2019 maps here; different, not clearly better, and
  only third-party copies were reachable for comparison.
- **Mars: MDIM 2.1 colour alone** (sharpest, but mauve-grey, with a frost
  patch in Hellas) and **Viking colour alone** (soft, posterised). MRO CTX
  is greyscale and USGS has it only as ±30° quadrangles; HiRISE and CTX are
  streamed at close range in the surface demos instead.
- **Dione, Rhea, Io, Tethys, Triton, Europa** from newer USGS mosaics or
  Photojournal colour maps: sharper in places, with gaps, seams or false
  colour that cost more than they gain at demo range. Tethys and Enceladus
  already are the USGS maps.

## Static fallback vs streamed imagery

The static map is a **fallback**: what a body shows at body scale (whole
disc, system views, before any tiles arrive). It should not grow to serve
close approaches. The policy for every body:

- **Static fallback for distant / body-scale views**, sized so it is sharp
  there: 4096×2048 by default, 2048 or less where the body is only ever seen
  small or the source has nothing finer.
- **Stream tiled imagery when the camera is close enough to need it and an
  authoritative higher-resolution product exists.** That is the
  imagery/terrain path the Moon and Mars surface demos already use.
- **Don't enlarge the monolithic fallback to cover close flybys.** Its cost
  (GPU memory, upload stall) is paid in every catalog that includes the
  body, near or not. Earth's 8k map is the one deliberate exception
  (see [Load cost](#load-cost)).

What 4096 px around the equator means per body, and where finer data exists
to stream:

| Body | Fallback (equatorial scale) | Finer source worth streaming for close views |
|---|---|---|
| Moon | 4096 colour (2.7 km/px); 16k today in lro-moon / moonfall-shackleton, where LRO WAC tiles from Trek already take over close up | LRO WAC 100 m, LOLA, LROC NAC |
| Mars | 4096 DXT1 (5.2 km/px) | MDIM 2.1 232 m, CTX, HiRISE (already streamed in ingenuity-jezero, msl-dingo-gap) |
| Earth | 8192 (4.9 km/px) | any web-map imagery |
| Mercury | 4096 DXT1 (3.7 km/px) | MDIS BDR / LOI 166 m |
| Venus | 4096 DXT1 (9.3 km/px) | Magellan C3-MDIR 2 km, FMAP 75 m |
| Ceres | 2048 (1.4 km/px) | Dawn HAMO 140 m, LAMO 35 m |
| Io, Europa | 4096 (2.8, 2.4 km/px) | Galileo SSI regional mosaics (to tens of m on Europa) |
| Ganymede, Callisto | 2048 (8.1, 7.4 km/px) | USGS Voyager–Galileo mosaics, 1–1.4 km |
| Titan | 4096 (4.0 km/px) | controlled ISS 702 m; Cassini SAR swaths |
| Mimas, Enceladus, Tethys, Dione, Rhea, Iapetus | 4096 (0.30–1.2 km/px) | Cassini global mosaics at 0.1–0.8 km (Enceladus 100 m) |
| Triton, Pluto, Charon | 4096 (2.1, 1.8, 0.9 km/px) | encounter-hemisphere mosaics at 0.3–0.6 km (Pluto and Charon down to tens of m along the flyby track) |
| Uranian moons | 1024–2048 | Voyager 2 southern hemispheres only; nothing finer to stream |
| Jupiter, Saturn, Uranus, Neptune | 1024–4096 | none worth tiling: banded / near-featureless at any scale |
| Vesta, Phobos, Deimos, other shape models | baked into the mesh's UV atlas (see below) | Dawn / Viking / HiRISE, via a bake or a projected overlay |
| Eris, Haumea, Makemake, 16 Psyche | untextured | no resolved imagery yet (Psyche from 2029) |

## Bodies without an up-to-date map

What a survey of every `Globe` and mesh body in the example catalogs found
beyond the maps above:

- **Vesta** (`base/main-belt-named`) is `vesta.cmod` with only a normal map
  (`../models/vesta-normals.dds`). USGS has Dawn global mosaics
  (`Vesta_Dawn_FC_HAMO_Mosaic_Global_74ppd.tif`, 356 MB;
  `Vesta_Dawn_HAMO_ClrShade_DLR_Global_48ppd.tif`, 448 MB), but the mesh's
  UVs are a square atlas, not longitude/latitude: correlation of u with
  vertex longitude is −0.21 (Phobos −0.18). So the mosaic would have to be
  *baked* into that atlas: rasterise each triangle in UV space, interpolate
  its 3D position, convert to lon/lat and sample the mosaic. Vesta's body
  frame also has a known convention history (Claudia vs IAU 2013 prime
  meridian), so the mesh's frame has to be pinned before baking. That is a
  follow-up of its own.
- **Phobos and Deimos** are `.cmod` meshes with Cosmographia colour maps in
  `base/mars-satellites`, but **untextured spheres** in `solar-system.json`.
  Pointing that catalog at the meshes would reuse what the base library has.
  USGS also has `Phobos_Viking_Mosaic_40ppd_DLRcontrol.tif` for a bake as
  above.
- **Bennu and Ryugu** (`base/near-earth-asteroids`) are untextured spheres.
  USGS has OSIRIS-REx global mosaics of Bennu
  (`Bennu_global_ShapeV20_GndControl_ROLOphase_ALBEDO_8bit_v6.tif`, 315 MB).
  On a sphere, a map of a top-shaped body distorts towards the poles; a
  shape model plus bake is the honest version. Nothing for Ryugu at USGS.
- **Charon's orbit is in the wrong plane** (`base/pluto-system`). It is a
  Keplerian `inclination: 0.001` in the default frame, so it does not lie in
  Pluto's equator (from an equatorial viewpoint it draws as an open ellipse,
  not a line), and Charon is not over Pluto's sub-Charon meridian. Not a
  texture issue, but it is what a viewer sees next to the corrected Pluto
  map.
- **`io-volcanos.json`** (not in the example index) draws Io, Europa,
  Ganymede, Callisto and Jupiter without maps; `base/jupiter-galilean` has
  them.

