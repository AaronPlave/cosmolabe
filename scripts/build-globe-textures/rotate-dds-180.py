#!/usr/bin/env python3
"""Rotate DXT1 .dds globe maps by 180 degrees in place, losslessly.

    cd apps/viewer/test-catalogs/textures
    python3 ../../../../scripts/build-globe-textures/rotate-dds-180.py \
        venus.dds triton.dds ariel.dds miranda.dds oberon.dds titania.dds umbriel.dds

Some Cosmographia-era maps (Venus, Triton, the Uranian moons) are stored
rotated 180 degrees relative to the north-up, -180..180 E convention. Once
DDS globe maps render north-up (BodyMesh flipGlobeDDS), such a map shows
upside-down with east and west swapped; rotating it fixes both.

The rotation is done on the compressed blocks: block order is reversed and
the 2-bit texel indices are reversed inside each block, so every mip level is
bit-for-bit the 180-degree rotation of the original with no re-encoding loss.
It is its own inverse, so running it twice restores the input; it is a
one-off fix, not part of build.py.
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

import numpy as np


def rotate_level(data: bytes, w: int, h: int) -> bytes:
    bw, bh = max(1, (w + 3) // 4), max(1, (h + 3) // 4)
    blocks = np.frombuffer(data, dtype=np.uint8).reshape(bh, bw, 8)
    colors = blocks[::-1, ::-1, :4]
    idx = blocks[::-1, ::-1, 4:]
    # Texel (x, y) of a block is bits 2x..2x+1 of byte y. A level smaller than
    # one block (the tail mips) only uses its top-left vw x vh texels; rotate
    # within those so the content stays where the sampler reads it.
    vw, vh = min(4, w), min(4, h)
    texels = np.stack([(idx >> (2 * x)) & 3 for x in range(4)], axis=-1)  # (bh, bw, y, x)
    rot = texels.copy()
    rot[:, :, :vh, :vw] = texels[:, :, :vh, :vw][:, :, ::-1, ::-1]
    packed = sum((rot[..., x].astype(np.uint8) << (2 * x)) for x in range(4)).astype(np.uint8)
    return np.concatenate([colors, packed], axis=-1).tobytes()


def rotate_file(path: Path) -> None:
    buf = path.read_bytes()
    if buf[:4] != b'DDS ' or buf[84:88] != b'DXT1':
        raise SystemExit(f'{path}: not a DXT1 DDS')
    h, w = struct.unpack_from('<2I', buf, 12)
    mips = max(1, struct.unpack_from('<I', buf, 28)[0])
    out, off = [buf[:128]], 128
    for _ in range(mips):
        size = max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * 8
        out.append(rotate_level(buf[off:off + size], w, h))
        off += size
        w, h = max(1, w // 2), max(1, h // 2)
    if off != len(buf):
        raise SystemExit(f'{path}: {len(buf) - off} unexpected trailing bytes')
    path.write_bytes(b''.join(out))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    for p in sys.argv[1:]:
        rotate_file(Path(p))
        print(f'rotated {p}')
