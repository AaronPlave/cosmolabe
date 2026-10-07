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
import sys
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

HERE = Path(__file__).resolve().parent
SOURCES = HERE / 'data' / 'source'
TEXTURES = HERE.parent.parent / 'apps' / 'viewer' / 'test-catalogs' / 'textures'


def load_usgs(name: str) -> np.ndarray:
    """Load a USGS mosaic as float32 (H, W, C), rolled to Cosmolabe's longitude origin.

    Cosmolabe globe maps put longitude -180 at u=0 and the prime meridian at
    the centre (simple cylindrical, east to the right). The USGS mosaics used
    here run 0..360 E from the left edge (CenterLongitude = 180 in the .lbl),
    so they are rolled by half their width.
    """
    a = np.asarray(Image.open(SOURCES / f'{name}.tif'), dtype=np.float32)
    if a.ndim == 2:
        a = a[:, :, None]
    return np.roll(a, a.shape[1] // 2, axis=1)


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


def to_image(a: np.ndarray) -> Image.Image:
    a = np.clip(a + 0.5, 0, 255).astype(np.uint8)
    return Image.fromarray(a[:, :, 0], 'L') if a.shape[2] == 1 else Image.fromarray(a, 'RGB')


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
    out = a * m + normalized_fill(a, m, sigma=48) * (1 - m)
    to_image(out).save(TEXTURES / 'ceres.jpg', 'JPEG', quality=90, optimize=True)


RECIPES = {'ceres': ceres}


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
