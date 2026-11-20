"""Pack finite, source-registered south polar rasters without altering sampled values."""
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np


def write_grid(path, values):
    path.parent.mkdir(parents=True, exist_ok=True)
    # A file-level gzip stream supports the same static hosting as other products.
    path.write_bytes(gzip.compress(np.asarray(values, dtype="<f4").tobytes(), mtime=0))


def pack(output, data, grid, *, display_stride, polar_limit_deg, source, features=None):
    """Write a nearest-sample overview and lossless native tiles (NaN = no data)."""
    output = Path(output)
    tile_size = 256
    height, width = data.shape
    west, north, step = grid
    # Pad cells at the edges by missing data. A center sample from each coarse
    # cell has the same grid registration even when the native size is odd.
    start = display_stride // 2
    overview = np.full(((height + display_stride - 1) // display_stride,
                        (width + display_stride - 1) // display_stride), np.nan, dtype=np.float32)
    sampled = data[start::display_stride, start::display_stride]
    overview[:sampled.shape[0], :sampled.shape[1]] = sampled
    write_grid(output / "overview.f32.gz", overview)
    tiles = []
    for y in range(0, height, tile_size):
        for x in range(0, width, tile_size):
            tile = data[y:y + tile_size, x:x + tile_size]
            if np.isfinite(tile).any():
                key = f"{x // tile_size}/{y // tile_size}"
                write_grid(output / "native" / f"{key}.f32.gz", tile)
                tiles.append(key)
    metadata = {
        "format": "cosmolabe-south-polar-raster-1",
        "frame": "MOON_ME_DE421",
        "radiusKm": 1737.4,
        "polarLimitDeg": polar_limit_deg,
        "grid": {"westM": west, "northM": north, "stepM": step, "width": width, "height": height},
        "displayStride": display_stride,
        "tileSize": tile_size,
        "nativeTiles": tiles,
        "source": source,
    }
    if features is not None:
        metadata["features"] = features
    # The manifest pins every delivered file, including native values and exact
    # geometry. Hash the manifest for the immutable product directory name.
    metadata["files"] = {}
    for path in sorted(output.rglob("*")):
        if path.is_file() and path.name != "science.json":
            with path.open("rb") as stream:
                metadata["files"][path.relative_to(output).as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
    manifest = json.dumps(metadata, separators=(",", ":"), allow_nan=False).encode() + b"\n"
    (output / "science.json").write_bytes(manifest)
    return hashlib.sha256(manifest).hexdigest()
