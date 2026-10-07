#!/usr/bin/env python3
"""Build the demo globe fallback maps that are derived from public USGS mosaics.

Reproduces the derived files in apps/viewer/test-catalogs/textures/ listed in
RECIPES below. Run ./fetch-sources.sh first; see README.md for provenance and
the reasoning behind each step.

Requires Python 3.10+, Pillow and numpy.

    python3 build.py              # build every recipe
    python3 build.py ceres        # build one
"""
from __future__ import annotations

import argparse
import io
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

HERE = Path(__file__).resolve().parent
SOURCES = HERE / 'data' / 'source'
TEXTURES = HERE.parent.parent / 'apps' / 'viewer' / 'test-catalogs' / 'textures'


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


RECIPES = {'ceres': ceres, 'charon': charon, 'pluto': pluto, 'titan': titan}


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
