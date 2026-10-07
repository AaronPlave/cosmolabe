#!/usr/bin/env python3
"""Build the demo globe fallback maps that are derived from public USGS mosaics.

Reproduces the derived files in apps/viewer/test-catalogs/textures/ listed in
RECIPES below. Run ./fetch-sources.sh first; see README.md for provenance and
the reasoning behind each step.

Requires Python 3.10+ and the packages in requirements.txt.

    python3 build.py              # build every recipe
    python3 build.py ceres        # build one
"""
from __future__ import annotations

import argparse
import concurrent.futures
import io
import math
import struct
import subprocess
import sys
import urllib.request
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

HERE = Path(__file__).resolve().parent
SOURCES = HERE / 'data' / 'source'
TEXTURES = HERE.parent.parent / 'apps' / 'viewer' / 'test-catalogs' / 'textures'
USGS = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic'


def load_usgs(name: str, center_lon: float = 180) -> np.ndarray:
    """Load a USGS mosaic as float32 (H, W, C), rolled to Cosmolabe's longitude origin.

    Cosmolabe globe maps put longitude -180 at u=0 and the prime meridian at
    the centre (simple cylindrical, east to the right). `center_lon` is the
    .lbl's CenterLongitude: 180 (the map runs 0..360 E from its left edge) is
    rolled by half the width, 0 is already in place. Every mosaic used here
    is east-to-the-right whatever its LongitudeDirection label says; each
    recipe's orientation was confirmed by correlating against an existing map
    (see README).
    """
    a = np.asarray(Image.open(SOURCES / f'{name}.tif'), dtype=np.float32)
    if a.ndim == 2:
        a = a[:, :, None]
    assert center_lon in (0, 180), center_lon
    return np.roll(a, a.shape[1] // 2, axis=1) if center_lon == 180 else a


class _RangeReader(io.RawIOBase):
    """Read-only seekable view of a remote file through HTTP range requests,
    enough for tifffile to parse a (Big)TIFF header without downloading it."""

    BLOCK = 1 << 20

    def __init__(self, url: str):
        self.url, self.pos, self.cache = url, 0, {}
        self.size = int(_get(url, 0, 0, full=True).headers['Content-Range'].rsplit('/', 1)[1])

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, off: int, whence: int = 0) -> int:
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def read(self, n: int = -1) -> bytes:
        n = self.size - self.pos if n < 0 else min(n, self.size - self.pos)
        out = bytearray()
        while n > 0:
            i, o = divmod(self.pos, self.BLOCK)
            if i not in self.cache:
                a = i * self.BLOCK
                self.cache[i] = _get(self.url, a, min(self.size, a + self.BLOCK) - 1)
            chunk = self.cache[i][o:o + n]
            out += chunk
            self.pos += len(chunk)
            n -= len(chunk)
        return bytes(out)

    def readinto(self, b) -> int:
        d = self.read(len(b))
        b[:len(d)] = d
        return len(d)


def _get(url: str, first: int, last: int, full: bool = False):
    req = urllib.request.Request(url, headers={'Range': f'bytes={first}-{last}'})
    for attempt in range(6):
        try:
            resp = urllib.request.urlopen(req, timeout=300)
            if full:
                return resp
            data = resp.read()
            if len(data) == last - first + 1:
                return data
        except OSError:
            if attempt == 5:
                raise
    raise OSError(f'short read from {url}')


def usgs_remote(name: str, w: int) -> np.ndarray:
    """A USGS global mosaic too large to download (4-13 GB), area-averaged to
    w x w/2 by streaming it through HTTP range requests, as float32 (H, W, C).

    These mosaics are uncompressed band-sequential (Big)TIFFs, one strip per
    row, already in Cosmolabe's convention (CenterLongitude 0, -180 at the
    left edge, east to the right). Rows are read in chunks that map to whole
    output rows, so the result does not depend on chunking or thread order.
    Cached under data/source/decimated/; the whole file still streams through
    once (see README for sizes)."""
    cache = SOURCES / 'decimated' / f'{name}.{w}.npy'
    if cache.exists():
        return np.load(cache)
    url = f'{USGS}/{name}.tif'
    tif = tifffile.TiffFile(_RangeReader(url))
    page = tif.pages[0]
    offsets = np.asarray(page.dataoffsets, dtype=np.int64)
    counts = np.asarray(page.databytecounts, dtype=np.int64)
    assert page.compression.name == 'NONE' and np.all(offsets[1:] == offsets[:-1] + counts[:-1]), name
    bands = page.samplesperpixel
    assert bands == 1 or page.planarconfig.name == 'SEPARATE', name
    H, W = page.imagelength, page.imagewidth
    h = w // 2
    dt = np.dtype(page.dtype).newbyteorder(tif.byteorder)
    row = W * dt.itemsize
    g = math.gcd(H, h)
    src_rows, out_rows = H // g, h // g  # smallest source block that maps to whole output rows
    per = max(1, (32 << 20) // (row * src_rows))
    out = np.zeros((bands, h, w), np.float32)

    def job(band: int, unit: int) -> None:
        r0 = unit * src_rows
        r1 = min(H, r0 + per * src_rows)
        a = offsets[0] + (band * H + r0) * row
        data = _get(url, int(a), int(a + (r1 - r0) * row - 1))
        block = np.frombuffer(data, dt).reshape(r1 - r0, W).astype(np.float32)
        o0, o1 = r0 // src_rows * out_rows, r1 // src_rows * out_rows
        out[band, o0:o1] = np.asarray(Image.fromarray(block, 'F').resize((w, o1 - o0), Image.BOX))

    jobs = [(b, u) for b in range(bands) for u in range(0, g, per)]
    print(f'  streaming {name} ({H}x{W}x{bands}, {page.dtype}) in {len(jobs)} requests', flush=True)
    with concurrent.futures.ThreadPoolExecutor(6) as ex:
        for i, _ in enumerate(ex.map(lambda j: job(*j), jobs)):
            if (i + 1) % max(1, len(jobs) // 10) == 0:
                print(f'    {100 * (i + 1) // len(jobs)}%', flush=True)
    a = np.moveaxis(out, 0, -1)
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.save(cache, a)
    return a


def load_tif(path: Path) -> np.ndarray:
    """A local TIFF as float32 (H, W, C); tifffile reads the planar RGB
    layouts Pillow can't."""
    a = tifffile.imread(path)
    if a.ndim == 3 and a.shape[0] in (3, 4) and a.shape[2] not in (3, 4):
        a = np.moveaxis(a, 0, -1)
    return (a[:, :, None] if a.ndim == 2 else a).astype(np.float32)


def previous(path: str, rev: str) -> Path:
    """A file as it was at `rev`, from git history (LFS pointers resolved),
    cached under data/source/previous/: for recipes that reuse something
    from the map they replace."""
    out = SOURCES / 'previous' / f'{rev}-{Path(path).name}'
    if not out.exists():
        blob = subprocess.run(['git', 'show', f'{rev}:{path}'], cwd=HERE, check=True, capture_output=True).stdout
        if blob.startswith(b'version https://git-lfs'):
            blob = subprocess.run(['git', 'lfs', 'smudge'], cwd=HERE, input=blob, check=True,
                                  capture_output=True).stdout
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(blob)
    return out


def resize(a: np.ndarray, w: int, h: int) -> np.ndarray:
    chans = [np.asarray(Image.fromarray(a[:, :, c]).resize((w, h), Image.LANCZOS), dtype=np.float32)
             for c in range(a.shape[2])]
    return np.stack(chans, axis=2)


def blur(a: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur per channel: periodic in longitude, reflected at the poles."""
    h, w = a.shape[:2]
    pad = min(h, int(3 * sigma) + 1)
    ext = np.concatenate([a[pad - 1::-1], a, a[:h - pad - 1:-1]], axis=0)

    def kernel(n: int) -> np.ndarray:
        f = np.fft.fftfreq(n)
        return np.exp(-2 * (np.pi * sigma * f) ** 2)

    out = np.fft.ifft(np.fft.fft(ext, axis=1) * kernel(w)[None, :, None], axis=1).real
    out = np.fft.ifft(np.fft.fft(out, axis=0) * kernel(ext.shape[0])[:, None, None], axis=0).real
    return out[pad:pad + h].astype(np.float32)


def valid_mask(src: np.ndarray, w: int, h: int, feather: float) -> np.ndarray:
    """1 where the mosaic has data, 0 in its no-data (0-valued) gaps, feathered at the boundary."""
    m = (src.max(axis=2) > 0).astype(np.float32)[:, :, None]
    m = resize(m, w, h).clip(0, 1)
    # Erode by the feather radius before blurring so the ramp sits inside the
    # data and the 0-valued edge never bleeds into the result.
    m = (blur(m, feather) > 0.999).astype(np.float32)
    return blur(m, feather).clip(0, 1)


def normalized_fill(a: np.ndarray, m: np.ndarray, sigma: float) -> np.ndarray:
    """Smooth extrapolation of the data under mask `m` into the areas outside it."""
    return blur(a * m, sigma) / np.maximum(blur(m, sigma), 1e-4)


def gap_fill(a: np.ndarray, m: np.ndarray) -> np.ndarray:
    """Fill no-data gaps of any size: fine-scale extrapolation near the data
    edge, blending into a wide-scale one further out and into the global mean
    where even that has no support (e.g. a polar-night cap hundreds of
    pixels tall). A single small sigma runs out of support mid-gap and goes
    black."""
    out = np.broadcast_to(a[m[:, :, 0] > 0.5].mean(axis=0), a.shape).astype(np.float32)
    for sigma in (256, 32):  # coarse first, then refine towards the edge
        support = blur(m, sigma)
        fill = blur(a * m, sigma) / np.maximum(support, 1e-4)
        w = np.clip(support / 0.25, 0, 1)
        out = fill * w + out * (1 - w)
    return out


def to_image(a: np.ndarray) -> Image.Image:
    a = np.clip(a + 0.5, 0, 255).astype(np.uint8)
    return Image.fromarray(a[:, :, 0], 'L') if a.shape[2] == 1 else Image.fromarray(a, 'RGB')


def rgb_to_ycc(a: np.ndarray) -> np.ndarray:
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    return np.stack([y, b - y, r - y], axis=2)


def ycc_to_rgb(a: np.ndarray) -> np.ndarray:
    y, cb, cr = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    r = cr + y
    b = cb + y
    g = (y - 0.299 * r - 0.114 * b) / 0.587
    return np.stack([r, g, b], axis=2)


def write_jpg(im: Image.Image, path: Path) -> None:
    im.save(path, 'JPEG', quality=90, optimize=True)


def write_dxt1(im: Image.Image, path: Path) -> None:
    """DXT1 DDS with a full mip chain. Pillow's DDS writer encodes BC1 but
    emits only level 0, so each level is encoded separately and the header is
    written here (same layout as the Cosmographia-era .dds maps)."""
    im = im.convert('RGB')
    w, h = im.size
    levels = []
    lw, lh = w, h
    while True:
        lvl = im if (lw, lh) == (w, h) else im.resize((lw, lh), Image.BOX)
        if lw < 4 or lh < 4:  # BC1 blocks are 4x4; pad the tail levels
            pad = Image.new('RGB', (max(lw, 4), max(lh, 4)))
            pad.paste(lvl, (0, 0))
            lvl = pad
        buf = io.BytesIO()
        lvl.save(buf, 'DDS', pixel_format='DXT1')
        levels.append(buf.getvalue()[128:])
        if lw == 1 and lh == 1:
            break
        lw, lh = max(1, lw // 2), max(1, lh // 2)
    flags = 0x1 | 0x2 | 0x4 | 0x1000 | 0x20000 | 0x80000  # CAPS HEIGHT WIDTH PIXELFORMAT MIPMAPCOUNT LINEARSIZE
    caps = 0x8 | 0x1000 | 0x400000  # COMPLEX TEXTURE MIPMAP
    header = (b'DDS ' + struct.pack('<7I', 124, flags, h, w, len(levels[0]), 0, len(levels))
              + b'\0' * 44
              + struct.pack('<2I4s5I', 32, 0x4, b'DXT1', 0, 0, 0, 0, 0)
              + struct.pack('<5I', caps, 0, 0, 0, 0))
    path.write_bytes(header + b''.join(levels))


# ── recipes ──────────────────────────────────────────────────────────────────

def ceres() -> None:
    """Dawn FC global mosaic (greyscale, as Ceres is) at 4096x2048. The
    mosaic's south-polar no-data gap is filled by smooth extrapolation of the
    surrounding data; nothing is taken from the previous map, a 512x256
    pre-Dawn reconstruction with no usable detail."""
    W, H = 4096, 2048
    src = load_usgs('Ceres_Dawn_FC_DLR_global_20ppd_Oct2015')
    m = valid_mask(src, W, H, feather=6)
    a = resize(src, W, H)
    out = a * m + gap_fill(a, m) * (1 - m)
    write_jpg(to_image(out), TEXTURES / 'ceres.jpg')


def charon() -> None:
    """New Horizons LORRI/MVIC global mosaic (Jul 2017), greyscale, at
    4096x2048. The previous 9520x4760 map is the same product's content (it
    registers at zero shift) at a size that costs 230 MiB of GPU memory; the
    unimaged south (polar night at encounter) was black and is now a smooth
    extrapolation of the surrounding terrain."""
    W, H = 4096, 2048
    src = load_usgs('Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit', center_lon=0)
    m = valid_mask(src, W, H, feather=6)
    a = resize(src, W, H)
    out = a * m + gap_fill(a, m) * (1 - m)
    write_jpg(to_image(out), TEXTURES / 'charon.jpg')


def pluto() -> None:
    """New Horizons global mosaic (Jul 2017) for luminance, at 4096x2048.

    Colour comes from the previous map, which is MVIC colour over the
    encounter hemisphere only and was centred on 180 E (half a turn off
    Cosmolabe's convention; see README), so it is rolled by half before use.
    Chroma is low-frequency, so blurring it hides the two maps' small
    misregistration. Outside the old colour coverage the chroma falls back to
    the mean of the covered area, so the rest of the globe is a neutral
    Pluto tint rather than grey. The unimaged south is filled as for Charon."""
    W, H = 4096, 2048
    src = load_usgs('Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit', center_lon=180)
    m = valid_mask(src, W, H, feather=6)
    a = resize(src, W, H)
    y = a * m + gap_fill(a, m) * (1 - m)

    old = np.asarray(Image.open(SOURCES / 'previous' / 'pluto.jpg').convert('RGB'), dtype=np.float32)
    old = np.roll(resize(old, W, H), W // 2, axis=1)
    cm = valid_mask(old, W, H, feather=24)
    ycc = rgb_to_ycc(old)
    w = cm[:, :, 0] > 0.5
    mean_chroma = ycc[:, :, 1:][w].mean(axis=0)
    chroma = normalized_fill(ycc[:, :, 1:], cm, sigma=8) * cm + mean_chroma * (1 - cm)
    # Old colour is darker/brighter in places than the USGS luminance; scale
    # chroma by the luminance ratio so saturation tracks the new brightness.
    ratio = np.clip(y / np.maximum(blur(ycc[:, :, :1], 8), 8), 0.25, 4)
    chroma = chroma * np.where(cm > 0.5, ratio, 1)
    write_jpg(to_image(ycc_to_rgb(np.concatenate([y, chroma], axis=2))), TEXTURES / 'pluto.jpg')


def titan() -> None:
    """Cassini ISS 938 nm global mosaic P19658 (USGS Astrogeology), greyscale,
    resampled 4040x2020 -> 4096x2048, written as DXT1 like the map it
    replaces (an early-Cassini mosaic with flat grey blocks where coverage
    was missing). Complete coverage, so no fill."""
    W, H = 4096, 2048
    src = load_usgs('Titan_ISS_P19658_Mosaic_Global_4km', center_lon=180)
    write_dxt1(to_image(resize(src, W, H)), TEXTURES / 'titan.dds')


def luminance(a: np.ndarray) -> np.ndarray:
    return (a[:, :, :3] @ np.array([0.299, 0.587, 0.114], np.float32))[:, :, None]


def stretch(a: np.ndarray, valid: np.ndarray, lo: float = 0.5, hi: float = 99.7) -> np.ndarray:
    """Linear stretch of the valid pixels' [lo, hi] percentiles to 0..1."""
    p0, p1 = np.percentile(a[valid], [lo, hi])
    return np.clip((a - p0) / (p1 - p0), 0, 1)


def mercury() -> None:
    """MESSENGER MDIS global basemaps (USGS), 4096x2048 DXT1.

    Luminance mixes the LOI basemap (low incidence: albedo and the bright
    ray systems a real view shows) with the BDR basemap (moderate incidence:
    relief), 55/45. LOI has no data within a few degrees of the poles; BDR
    is complete and fills it. Colour is a 35% tint from the MD3 colour
    basemap, whose stretch is too blue to use directly, plus a slight warm
    balance. The map it replaces is BDR-like with visible frame patches."""
    W, H = 4096, 2048
    bdr = usgs_remote('Mercury_MESSENGER_MDIS_Basemap_BDR_Mosaic_Global_166m', W)
    loi = usgs_remote('Mercury_MESSENGER_MDIS_Basemap_LOI_Mosaic_Global_166m', W)
    md3 = usgs_remote('Mercury_MESSENGER_MDIS_Basemap_MD3Color_Mosaic_Global_665m', W)
    b = stretch(bdr, np.ones(bdr.shape, bool))
    lm = valid_mask(loi, W, H, feather=4)
    l = stretch(loi, lm > 0.5)
    lum = 0.55 * (l * lm + b * (1 - lm)) + 0.45 * b
    cm = valid_mask(md3, W, H, feather=4)
    tint = md3 / (md3.mean(axis=2, keepdims=True) + 1e-3)
    tint = 1 + 0.35 * (tint - 1) * cm
    rgb = lum * tint * np.array([1.04, 1.0, 0.94], np.float32)
    write_dxt1(to_image(np.clip(rgb, 0, 1) * 235), TEXTURES / 'mercury.dds')


def mars() -> None:
    """Viking colour with MDIM 2.1 detail (USGS), 4096x2048 DXT1.

    The Viking colour mosaic has the familiar albedo and colour but is soft
    and posterised; the MOLA-controlled MDIM 2.1 mosaic is sharp but grey.
    Luminance is Viking's times MDIM's high-pass (its ratio to a blurred
    copy of itself), colour is Viking's chroma. The map it replaces is
    Cosmographia's, with a yellow cast and softer relief."""
    W, H = 4096, 2048
    viking = usgs_remote('Mars_Viking_ClrMosaic_global_925m', W)
    mdim = usgs_remote('Mars_Viking_MDIM21_Mosaic_global_232m', W)
    yv = luminance(viking)
    detail = mdim / (blur(mdim, 8) + 1e-3)
    rgb = np.clip(yv * detail, 0, 1.2 * 255) * viking / (yv + 1e-3)
    write_dxt1(to_image(np.clip(rgb, 0, 255)), TEXTURES / 'mars.dds')


def venus() -> None:
    """Magellan C3-MDIR colourised radar mosaic (USGS, natively 8192x4096,
    gaps already filled), 4096x2048 DXT1. The map it replaces was stored
    rotated 180 degrees."""
    src = load_tif(SOURCES / 'Venus_Magellan_C3-MDIR_Colorized_Global_Mosaic_4641m.tif')
    write_dxt1(to_image(resize(src, 4096, 2048)), TEXTURES / 'venus.dds')


def earth() -> None:
    """Blue Marble Next Generation, July 2004, topography + bathymetry, from
    the 21600x10800 original at 8192x4096. The 5400x2700 map it replaces is
    the same product's smallest size (byte-identical to NASA's file)."""
    # Resized as 8-bit RGB: the 233-Mpx original as float32 would need ~2.8 GB.
    src = Image.open(SOURCES / 'world.topo.bathy.200407.3x21600x10800.jpg').convert('RGB')
    write_jpg(src.resize((8192, 4096), Image.LANCZOS), TEXTURES / 'earth-8k.jpg')


def jupiter() -> None:
    """Cassini's Jupiter map PIA07782 (Dec 2000) from the lossless TIF,
    4096x2048 JPEG. The previous jupiter.dds was this same image upscaled
    and DXT1-compressed (green cast, colour banding in the belts); DXT1's
    4x4 blocks band a smooth gas-giant map, so this one is a JPEG. The TIF
    is 3601x1801 at 0.1 deg with 0 deg E at its left edge and the 360 deg
    column repeated: drop that column, roll by half."""
    src = np.asarray(Image.open(SOURCES / 'PIA07782.tif').convert('RGB'), dtype=np.float32)[:, :3600]
    src = np.roll(src, 1800, axis=1)
    write_jpg(to_image(resize(src, 4096, 2048)), TEXTURES / 'jupiter.jpg')


def mimas() -> None:
    """DLR Cassini ISS basemap of Mimas (Roatsch et al., 30 Jun 2017),
    5760x2880 greyscale, already -180..180 E: 4096x2048 DXT1. The map it
    replaces looks like an earlier DLR basemap with less late-mission
    coverage. Complete, so no fill."""
    src = np.asarray(Image.open(SOURCES / 'Cassini_DLR' / 'MI_170630_DLR_basemap_degrees.tif'), dtype=np.float32)
    write_dxt1(to_image(resize(src[:, :, None] if src.ndim == 2 else src, 4096, 2048)), TEXTURES / 'mimas.dds')


# Ring radii (km) of features identified along PIA11142's sample line, at
# that line's pixel x: C ring inner edge, Colombo gap, Maxwell gap, B ring
# inner and outer edges, Laplace gap, A ring inner edge, Encke and Keeler
# gaps, A ring outer edge, F ring. The mosaic's scale drifts (about 6-10
# km/px), so radius is piecewise linear between them.
RING_LANDMARKS = np.array([
    (1163, 74658), (1704, 77870), (3321, 87491), (3803, 91975), (8104, 117570), (8468, 119845),
    (8838, 122050), (10582, 133589), (11024, 136505), (11064, 136775), (11636, 140220)], np.float64)
RING_R0, RING_R1 = 74660, 140220  # radial extent of saturn-rings.png, km (base/saturn.json)


def saturn_rings() -> None:
    """Saturn ring colour from Cassini PIA11142 "A Full Sweep of Saturn's
    Rings" (natural colour, Nov 2008, about 6-7 km/px), 4096x2 RGBA.

    The rings curve across the mosaic; the profile is sampled along the
    straight line through the arc apexes (y = 850 - 0.0164 (x - 3140)),
    averaging 7 rows, and mapped to radius through RING_LANDMARKS. A lit-side
    photograph doesn't give transparency, so alpha is the previous texture's
    (1024 samples, interpolated), zeroed where the new profile shows a true
    gap and raised where the new profile resolves ringlets in a gap the old
    alpha had closed. The F ring stays faint because the old alpha there is."""
    N = 4096
    a = np.asarray(Image.open(SOURCES / 'PIA11142.tif').convert('RGB'), dtype=np.float64)
    xs = np.arange(a.shape[1])
    ys = np.round(850 - (xs - 3140) * 0.0164).astype(int)
    prof = np.stack([a[ys + d, xs] for d in range(-3, 4)]).mean(axis=0)
    r = RING_R0 + (np.arange(N) + 0.5) / N * (RING_R1 - RING_R0)
    x = np.interp(r, RING_LANDMARKS[:, 1], RING_LANDMARKS[:, 0])
    col = np.stack([np.interp(x, xs, prof[:, c]) for c in range(3)], axis=1)
    k = max(1, round((RING_R1 - RING_R0) / N / 6.5))  # area-average down to the sample spacing
    if k > 1:
        col = np.stack([np.convolve(col[:, c], np.ones(k) / k, 'same') for c in range(3)], axis=1)
    old = np.asarray(Image.open(previous('apps/viewer/test-catalogs/textures/saturn-rings.png', 'b593685'))
                     .convert('RGBA'), dtype=np.float64)[0]
    old_alpha = np.interp(r, RING_R0 + (np.arange(len(old)) + 0.5) / len(old) * (RING_R1 - RING_R0), old[:, 3])
    lum = col.mean(axis=1)
    alpha = old_alpha * np.clip((lum - 4) / 12, 0, 1)
    alpha = np.maximum(alpha, np.clip(lum * 1.2, 0, 255) * (old_alpha < 40))
    rgba = np.concatenate([np.clip(col, 0, 255), alpha[:, None]], axis=1)
    rgba = np.clip(rgba + 0.5, 0, 255).astype(np.uint8)
    Image.fromarray(np.stack([rgba, rgba])).save(TEXTURES / 'saturn-rings.png', optimize=True)


RECIPES = {
    'ceres': ceres, 'charon': charon, 'pluto': pluto, 'titan': titan,
    'mercury': mercury, 'venus': venus, 'earth': earth, 'mars': mars,
    'jupiter': jupiter, 'saturn_rings': saturn_rings, 'mimas': mimas,
}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('recipes', nargs='*', metavar='recipe', help=', '.join(RECIPES))
    args = p.parse_args()
    unknown = set(args.recipes) - set(RECIPES)
    if unknown:
        p.error(f'unknown recipe(s): {", ".join(sorted(unknown))}')
    for name in args.recipes or RECIPES:
        print(f'building {name}…', flush=True)
        RECIPES[name]()
    return 0


if __name__ == '__main__':
    sys.exit(main())
