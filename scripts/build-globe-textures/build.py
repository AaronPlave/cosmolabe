#!/usr/bin/env python3
"""Build the demo globe fallback maps that are derived from public sources.

Reproduces the derived files in apps/viewer/test-catalogs/textures/ listed in
RECIPES below. Run ./fetch-sources.sh first; see README.md for provenance and
the reasoning behind each step.

Every input is checked against sources.sha256 before use, and every output
against outputs.sha256 after it is written (a mismatch is reported, not
fatal: it is expected when a recipe is changed on purpose).

Requires Python 3.10+ and the packages in requirements.txt.

    python3 build.py              # build every recipe
    python3 build.py ceres        # build one
    python3 build.py --verify     # check the committed outputs against outputs.sha256
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import http.client
import io
import math
import os
import struct
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

HERE = Path(__file__).resolve().parent
SOURCES = HERE / 'data' / 'source'
TEXTURES = HERE.parent.parent / 'apps' / 'viewer' / 'test-catalogs' / 'textures'
SOURCE_MANIFEST = HERE / 'sources.sha256'
OUTPUT_MANIFEST = HERE / 'outputs.sha256'


def _manifest() -> dict[str, tuple[str, str]]:
    """sources.sha256: `<sha256>  <name>  <origin>` per line, `#` comments."""
    entries = {}
    for line in SOURCE_MANIFEST.read_text().splitlines():
        if line.strip() and not line.startswith('#'):
            digest, name, origin = line.split()
            entries[name] = (digest, origin)
    return entries


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 22), b''):
            h.update(chunk)
    return h.hexdigest()


_verified: set[str] = set()


def source(name: str) -> Path:
    """Path of a fetched input, after checking it against sources.sha256."""
    path = SOURCES / name
    if name not in _verified:
        expected = _manifest()[name][0]
        if not path.exists():
            sys.exit(f'missing source {name}; run ./fetch-sources.sh')
        got = sha256_file(path)
        if got != expected:
            sys.exit(f'source {name} has sha256 {got}, expected {expected}; run ./fetch-sources.sh')
        _verified.add(name)
    return path


def load_usgs(name: str, w: int, h: int, center_lon: float, ext: str = 'tif') -> tuple[np.ndarray, np.ndarray]:
    """A local 8-bit USGS mosaic resampled to w x h in Cosmolabe's longitude
    origin: (image, coverage), float32 (h, w, C) and (h, w, 1).

    Cosmolabe globe maps put longitude -180 at u=0 and the prime meridian at
    the centre, east to the right. `center_lon` is the label's
    CenterLongitude: at 180 the map runs 0..360 E from its left edge and is
    rolled by half its width; at 0 it is already in place. No mirroring is
    ever needed: ISIS computes map x from the eastward angle, so its maps are
    always drawn east-to-the-right, and LongitudeDirection only says whether
    the longitude *numbers* count east or west (a PositiveWest map with
    CenterLongitude 180 has 360 W = 0 E at its left edge). Each recipe's
    orientation is also checked against named features (see README).

    Resampling stays in 8 bits (Pillow, per band) so a mosaic of a few
    hundred megapixels never exists as float32. `coverage` is the
    area-averaged fraction of non-zero (non-no-data) source pixels."""
    a = np.asarray(Image.open(source(f'{name}.{ext}')))
    if a.ndim == 2:
        a = a[:, :, None]
    assert a.dtype == np.uint8, (name, a.dtype)
    assert center_lon in (0, 180), center_lon
    if center_lon == 180:
        a = np.roll(a, a.shape[1] // 2, axis=1)
    bands = [np.asarray(Image.fromarray(a[:, :, c]).resize((w, h), Image.LANCZOS), dtype=np.float32)
             for c in range(a.shape[2])]
    valid = (a.max(axis=2) > 0).view(np.uint8) * np.uint8(255)
    coverage = np.asarray(Image.fromarray(valid).resize((w, h), Image.BOX), dtype=np.float32) / 255
    return np.stack(bands, axis=2), coverage[:, :, None]


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
        except (OSError, http.client.HTTPException):  # IncompleteRead is not an OSError
            if attempt == 5:
                raise
        time.sleep(2 ** attempt)
    raise OSError(f'short read from {url}')


def usgs_remote(name: str, w: int) -> np.ndarray:
    """A USGS global mosaic too large to download (4-13 GB), area-averaged to
    w x w/2 by streaming it through HTTP range requests, as float32 (H, W, C).

    These mosaics are uncompressed band-sequential (Big)TIFFs, one strip per
    row, already in Cosmolabe's convention (CenterLongitude 0, -180 at the
    left edge, east to the right). Rows are read in chunks that map to whole
    output rows, so the result does not depend on chunking or thread order.

    Every pixel byte is streamed, so the data is verified as it goes: the
    sha256 of the concatenated per-chunk sha256s, in chunk order, must match
    the `stream:` entry in sources.sha256 or nothing is returned or cached.
    The reduction is cached under data/source/decimated/, keyed by that
    digest."""
    expected, origin = _manifest()[name]
    url = origin.removeprefix('stream:')
    cache = SOURCES / 'decimated' / f'{name}.{w}.{expected[:16]}.npy'
    if cache.exists():
        return np.load(cache)
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

    def job(band: int, unit: int) -> bytes:
        r0 = unit * src_rows
        r1 = min(H, r0 + per * src_rows)
        a = offsets[0] + (band * H + r0) * row
        data = _get(url, int(a), int(a + (r1 - r0) * row - 1))
        block = np.frombuffer(data, dt).reshape(r1 - r0, W).astype(np.float32)
        o0, o1 = r0 // src_rows * out_rows, r1 // src_rows * out_rows
        out[band, o0:o1] = np.asarray(Image.fromarray(block, 'F').resize((w, o1 - o0), Image.BOX))
        return hashlib.sha256(data).digest()

    jobs = [(b, u) for b in range(bands) for u in range(0, g, per)]
    print(f'  streaming {name} ({H}x{W}x{bands}, {page.dtype}) in {len(jobs)} requests', flush=True)
    digests = []
    with concurrent.futures.ThreadPoolExecutor(6) as ex:
        for i, d in enumerate(ex.map(lambda j: job(*j), jobs)):  # map keeps job order
            digests.append(d)
            if (i + 1) % max(1, len(jobs) // 10) == 0:
                print(f'    {100 * (i + 1) // len(jobs)}%', flush=True)
    got = hashlib.sha256(b''.join(digests)).hexdigest()
    if got != expected:
        sys.exit(f'{name}: streamed content digest {got}, expected {expected} (upstream file changed?)')
    a = np.moveaxis(out, 0, -1)
    cache.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_suffix('.part.npy')
    np.save(tmp, a)
    os.replace(tmp, cache)
    return a


def load_isis_tiled(path: Path) -> np.ndarray:
    """An 8-bit single-band ISIS cube in Tile format, as uint8 (lines, samples).

    Only what the label states is supported: one band, UnsignedByte,
    Base 0 / Multiplier 1. Tiles are stored row by row, each TileLines x
    TileSamples, and the last tile row is padded past Lines."""
    head = path.open('rb').read(65536).decode('latin-1')

    def field(key: str) -> str:
        line = next(l for l in head.splitlines() if l.strip().startswith(key + ' '))
        return line.split('=', 1)[1].strip()
    assert field('Format') == 'Tile' and field('Type') == 'UnsignedByte' and field('Bands') == '1', path
    assert float(field('Base')) == 0 and float(field('Multiplier')) == 1, path
    samples, lines = int(field('Samples')), int(field('Lines'))
    ts, tl = int(field('TileSamples')), int(field('TileLines'))
    start = int(field('StartByte')) - 1  # ISIS counts bytes from 1
    nx, ny = -(-samples // ts), -(-lines // tl)
    raw = np.fromfile(path, np.uint8, offset=start, count=nx * ny * ts * tl)
    tiles = raw.reshape(ny, nx, tl, ts).transpose(0, 2, 1, 3).reshape(ny * tl, nx * ts)
    return tiles[:lines, :samples]


def load_tif(path: Path) -> np.ndarray:
    """A local TIFF as float32 (H, W, C); tifffile reads the planar RGB
    layouts Pillow can't."""
    a = tifffile.imread(path)
    if a.ndim == 3 and a.shape[0] in (3, 4) and a.shape[2] not in (3, 4):
        a = np.moveaxis(a, 0, -1)
    return (a[:, :, None] if a.ndim == 2 else a).astype(np.float32)


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


def valid_mask(coverage: np.ndarray, feather: float) -> np.ndarray:
    """1 where the mosaic has data, 0 in its no-data gaps, feathered at the
    boundary. `coverage` is the fraction of valid source pixels per output
    pixel (load_usgs), or any 0..1 map at output size."""
    m = coverage.clip(0, 1)
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
    """Dawn FC HAMO global mosaic (DLR, Feb 2016, 140 m/px, greyscale as
    Ceres is) at 2048x1024.

    2048 rather than 4096: Ceres is a distant body in every catalog that
    shows it, 2048 is already 1.4 km/px, and it keeps the fallback at
    11 MiB of GPU memory instead of 43 (see README). The HAMO mosaic is
    controlled, sharper than the 400 m Survey mosaic and complete to both
    poles, so nothing is extrapolated; it is already centred on 0 E. Nothing
    is taken from the previous map, a 512x256 pre-Dawn reconstruction."""
    W, H = 2048, 1024
    src = load_isis_tiled(source('Ceres_Dawn_FC_DLR_global_59ppd_Feb2016.cub'))
    assert src.min() > 0, 'HAMO mosaic was complete when this recipe was written'
    a = np.asarray(Image.fromarray(src).resize((W, H), Image.LANCZOS), dtype=np.float32)
    write_jpg(to_image(a[:, :, None]), TEXTURES / 'ceres.jpg')


def charon() -> None:
    """New Horizons LORRI/MVIC global mosaic (Jul 2017), greyscale, at
    4096x2048. The previous 9520x4760 map is the same product's content (it
    registers at zero shift) at a size that costs 230 MiB of GPU memory; the
    unimaged south (polar night at encounter) was black and is now a smooth
    extrapolation of the surrounding terrain."""
    W, H = 4096, 2048
    a, coverage = load_usgs('Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit', W, H, center_lon=0)
    m = valid_mask(coverage, feather=6)
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
    a, coverage = load_usgs('Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit', W, H, center_lon=180)
    m = valid_mask(coverage, feather=6)
    y = a * m + gap_fill(a, m) * (1 - m)

    old = np.asarray(Image.open(source('previous/pluto.jpg')).convert('RGB'), dtype=np.float32)
    old = np.roll(resize(old, W, H), W // 2, axis=1)
    cm = valid_mask((old.max(axis=2, keepdims=True) > 0).astype(np.float32), feather=24)
    ycc = rgb_to_ycc(old)
    w = cm[:, :, 0] > 0.5
    mean_chroma = ycc[:, :, 1:][w].mean(axis=0)
    chroma = normalized_fill(ycc[:, :, 1:], cm, sigma=8) * cm + mean_chroma * (1 - cm)
    # Old colour is darker/brighter in places than the USGS luminance; scale
    # chroma by the luminance ratio so saturation tracks the new brightness.
    ratio = np.clip(y / np.maximum(blur(ycc[:, :, :1], 8), 8), 0.25, 4)
    chroma = chroma * np.where(cm > 0.5, ratio, 1)
    write_jpg(to_image(ycc_to_rgb(np.concatenate([y, chroma], axis=2))), TEXTURES / 'pluto.jpg')


TITAN_702M = 'Titan_Controlled_GlobalEqui_V6NoArcEdgesClouds_702M_WeightedAverage_ComboIncV2Ema60_Sharpen31x31'


def titan() -> None:
    """Cassini ISS 938 nm controlled global mosaic at 702 m (USGS, 2025,
    doi:10.5066/P14FAEKS), greyscale, 23048x11524 -> 4096x2048 DXT1. Its
    images are tied by bundle adjustment to the Cassini RADAR geodetic frame,
    and it replaces the uncontrolled P19658 4 km mosaic (visible frame
    patches, a flat grey block at high northern latitudes). The 8-bit PNG
    release is used, the same data as the 1 GB float cube. The few no-data
    pixels (a wedge near 60 S, slivers at the south pole) are filled."""
    W, H = 4096, 2048
    a, coverage = load_usgs(TITAN_702M, W, H, center_lon=180, ext='png')
    m = valid_mask(coverage, feather=4)
    write_dxt1(to_image(a * m + gap_fill(a, m) * (1 - m)), TEXTURES / 'titan.dds')


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
    lm = valid_mask((loi > 0).astype(np.float32), feather=4)
    l = stretch(loi, lm > 0.5)
    lum = 0.55 * (l * lm + b * (1 - lm)) + 0.45 * b
    cm = valid_mask((md3.max(axis=2, keepdims=True) > 0).astype(np.float32), feather=4)
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
    src = load_tif(source('Venus_Magellan_C3-MDIR_Colorized_Global_Mosaic_4641m.tif'))
    write_dxt1(to_image(resize(src, 4096, 2048)), TEXTURES / 'venus.dds')


def earth() -> None:
    """Blue Marble Next Generation, July 2004, topography + bathymetry, from
    the 21600x10800 original at 8192x4096. The 5400x2700 map it replaces is
    the same product's smallest size (byte-identical to NASA's file)."""
    # Resized as 8-bit RGB: the 233-Mpx original as float32 would need ~2.8 GB.
    src = Image.open(source('world.topo.bathy.200407.3x21600x10800.jpg')).convert('RGB')
    write_jpg(src.resize((8192, 4096), Image.LANCZOS), TEXTURES / 'earth-8k.jpg')


def jupiter() -> None:
    """Cassini's Jupiter map PIA07782 (Dec 2000) from the lossless TIF,
    4096x2048 JPEG. The previous jupiter.dds was this same image upscaled
    and DXT1-compressed (green cast, colour banding in the belts); DXT1's
    4x4 blocks band a smooth gas-giant map, so this one is a JPEG. The TIF
    is 3601x1801 at 0.1 deg with 0 deg E at its left edge and the 360 deg
    column repeated: drop that column, roll by half."""
    src = np.asarray(Image.open(source('PIA07782.tif')).convert('RGB'), dtype=np.float32)[:, :3600]
    src = np.roll(src, 1800, axis=1)
    write_jpg(to_image(resize(src, 4096, 2048)), TEXTURES / 'jupiter.jpg')


def mimas() -> None:
    """DLR Cassini ISS basemap of Mimas (Roatsch et al., 30 Jun 2017),
    5760x2880 greyscale, already -180..180 E: 4096x2048 DXT1. The map it
    replaces looks like an earlier DLR basemap with less late-mission
    coverage. Complete, so no fill."""
    with zipfile.ZipFile(source('Cassini_DLR_Mimas.zip')) as z:
        src = np.asarray(Image.open(io.BytesIO(z.read('Cassini_DLR/MI_170630_DLR_basemap_degrees.tif'))),
                         dtype=np.float32)
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
    """Saturn's rings, 4096x2 RGBA over RING_R0..RING_R1.

    Colour: Cassini PIA11142 "A Full Sweep of Saturn's Rings" (natural
    colour, Nov 2008, about 6-7 km/px). The rings curve across the mosaic;
    the profile is sampled along the straight line through the arc apexes
    (y = 850 - 0.0164 (x - 3140)), averaging 7 rows, and mapped to radius
    through RING_LANDMARKS.

    Alpha: measured, from the Cassini RSS X-band radio occultation of Rev 7
    egress (PDS CORSS_8001, 2005-123, 1 km resolution, 0.25 km sampling):
    the opacity seen face-on, 1 - exp(-tau), with tau the normal optical
    depth. Samples at or above the profile's detection threshold (the
    densest B ring) are opaque. Each texel is 1 minus the mean transmission
    of the samples it covers, so narrow gaps and ringlets average correctly.
    The narrow, eccentric F ring is not in it: this occultation shows no
    F-ring core, and its mean radius sits on the texture's outer edge."""
    N = 4096
    a = np.asarray(Image.open(source('PIA11142.tif')).convert('RGB'), dtype=np.float64)
    xs = np.arange(a.shape[1])
    ys = np.round(850 - (xs - 3140) * 0.0164).astype(int)
    prof = np.stack([a[ys + d, xs] for d in range(-3, 4)]).mean(axis=0)
    r = RING_R0 + (np.arange(N) + 0.5) / N * (RING_R1 - RING_R0)
    x = np.interp(r, RING_LANDMARKS[:, 1], RING_LANDMARKS[:, 0])
    col = np.stack([np.interp(x, xs, prof[:, c]) for c in range(3)], axis=1)
    k = max(1, round((RING_R1 - RING_R0) / N / 6.5))  # area-average down to the sample spacing
    if k > 1:
        col = np.stack([np.convolve(col[:, c], np.ones(k) / k, 'same') for c in range(3)], axis=1)

    # RING RADIUS, NORMAL OPTICAL DEPTH, NORMAL OPTICAL DEPTH THRESHOLD (columns 1, 7, 9)
    radius, tau, threshold = np.loadtxt(source('RSS_2005_123_X43_E_TAU_01KM.TAB'), delimiter=',',
                                        usecols=(0, 6, 8)).T
    transmission = np.where(tau >= threshold, 0.0, np.exp(-np.clip(tau, 0, None)))
    texel = np.floor((radius - RING_R0) / (RING_R1 - RING_R0) * N).astype(int)
    inside = (texel >= 0) & (texel < N)
    count = np.bincount(texel[inside], minlength=N)
    assert count.min() > 0, 'occultation profile does not cover the texture'
    alpha = 255 * (1 - np.bincount(texel[inside], transmission[inside], minlength=N) / count)

    rgba = np.concatenate([np.clip(col, 0, 255), alpha[:, None]], axis=1)
    rgba = np.clip(rgba + 0.5, 0, 255).astype(np.uint8)
    Image.fromarray(np.stack([rgba, rgba])).save(TEXTURES / 'saturn-rings.png', optimize=True)


# recipe -> (function, output file in TEXTURES)
RECIPES = {
    'ceres': (ceres, 'ceres.jpg'), 'charon': (charon, 'charon.jpg'), 'pluto': (pluto, 'pluto.jpg'),
    'titan': (titan, 'titan.dds'), 'mercury': (mercury, 'mercury.dds'), 'venus': (venus, 'venus.dds'),
    'earth': (earth, 'earth-8k.jpg'), 'mars': (mars, 'mars.dds'), 'jupiter': (jupiter, 'jupiter.jpg'),
    'saturn_rings': (saturn_rings, 'saturn-rings.png'), 'mimas': (mimas, 'mimas.dds'),
}


def check_output(filename: str) -> bool:
    """Compare a file in TEXTURES with its outputs.sha256 entry; print the result."""
    expected = {}
    for line in OUTPUT_MANIFEST.read_text().splitlines():
        if line.strip() and not line.startswith('#'):
            digest, name = line.split()
            expected[name] = digest
    path = TEXTURES / filename
    got = sha256_file(path) if path.exists() else 'missing'
    ok = got == expected.get(filename)
    print(f'  {"OK      " if ok else "MISMATCH"} {filename} {got}'
          + ('' if ok else f' (expected {expected.get(filename, "no entry")})'), flush=True)
    return ok


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('recipes', nargs='*', metavar='recipe', help=', '.join(RECIPES))
    p.add_argument('--verify', action='store_true',
                   help='check the outputs in the textures directory against outputs.sha256; build nothing')
    args = p.parse_args()
    unknown = set(args.recipes) - set(RECIPES)
    if unknown:
        p.error(f'unknown recipe(s): {", ".join(sorted(unknown))}')
    names = args.recipes or list(RECIPES)
    ok = True
    for name in names:
        fn, filename = RECIPES[name]
        if not args.verify:
            print(f'building {name}…', flush=True)
            fn()
        ok = check_output(filename) and ok
    return 0 if ok or not args.verify else 1


if __name__ == '__main__':
    sys.exit(main())
