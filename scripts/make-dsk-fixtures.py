#!/usr/bin/env python3
"""
Write the small synthetic DSK fixtures the cspice-wasm DSK reader tests load.

  kernels/fixtures/dsk-two-segments.bds  two type-2 segments, one body (Mars,
                                         IAU_MARS): a tetrahedron and a cube, so
                                         the reader's segment merge and index
                                         offsets have a known answer.
  kernels/fixtures/dsk-mixed-frames.bds  two type-2 segments for different bodies
                                         (Mars / IAU_MARS and Phobos / IAU_PHOBOS),
                                         which the reader must refuse to merge.

The shapes are synthetic and tiny (a few KB each), so they are committed; the
MU69 fixture next to them covers a real mission product. Rerun only if the
fixtures need to change:

  python3 -m venv .venv && .venv/bin/pip install spiceypy numpy
  .venv/bin/python scripts/make-dsk-fixtures.py
"""

import os

import numpy as np
import spiceypy as sp

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kernels", "fixtures")

TETRA_V = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]]
# 1-based, outward-facing.
TETRA_P = [[1, 2, 3], [1, 4, 2], [2, 4, 3], [3, 4, 1]]

CUBE_V = [[x, y, z] for x in (10, 12) for y in (-1, 1) for z in (-1, 1)]
CUBE_P = [
    [1, 2, 4], [1, 4, 3],   # x = 10
    [5, 7, 8], [5, 8, 6],   # x = 12
    [1, 5, 6], [1, 6, 2],   # y = -1
    [3, 4, 8], [3, 8, 7],   # y = +1
    [1, 3, 7], [1, 7, 5],   # z = -1
    [2, 6, 8], [2, 8, 4],   # z = +1
]


def segment(handle, center, surface, frame, verts, plates):
    v = np.array(verts, dtype=float)
    p = np.array(plates, dtype=np.int32)
    finscl, corscl = 5.0, 4
    worksz, voxpsz, voxlsz, spaisz = 10000, 1000, 10000, 200000
    spaixd, spaixi = sp.dskmi2(v, p, finscl, corscl, worksz, voxpsz, voxlsz, False, spaisz)
    # Planetocentric latitudinal bounds covering the whole sphere; the radius
    # bounds come from the vertices.
    r = np.linalg.norm(v, axis=1)
    corpar = np.zeros(10)
    mncor1, mxcor1 = -np.pi, np.pi
    mncor2, mxcor2 = -np.pi / 2, np.pi / 2
    mncor3, mxcor3 = float(r.min()), float(r.max())
    sp.dskw02(handle, center, surface, 1, frame, 1, corpar,
              mncor1, mxcor1, mncor2, mxcor2, mncor3, mxcor3,
              -1e9, 1e9, v, p, spaixd, spaixi)


def write(name, segs):
    path = os.path.join(OUT, name)
    if os.path.exists(path):
        os.remove(path)
    handle = sp.dskopn(path, name, 0)
    for s in segs:
        segment(handle, *s)
    sp.dskcls(handle, True)
    print(f"wrote {path} ({os.path.getsize(path)} bytes)")


write("dsk-two-segments.bds", [
    (499, 1, "IAU_MARS", TETRA_V, TETRA_P),
    (499, 2, "IAU_MARS", CUBE_V, CUBE_P),
])
write("dsk-mixed-frames.bds", [
    (499, 1, "IAU_MARS", TETRA_V, TETRA_P),
    (401, 2, "IAU_PHOBOS", CUBE_V, CUBE_P),
])
