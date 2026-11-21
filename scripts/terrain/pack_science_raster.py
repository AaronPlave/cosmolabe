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


def aggregate_overview(data, stride, *, categorical):
    """Summarize blocks anchored at the original grid's northwest corner."""
    height, width = data.shape
    rows, columns = np.arange(0, height, stride), np.arange(0, width, stride)
    block_sizes = np.multiply.outer(np.minimum(stride, height - rows),
                                    np.minimum(stride, width - columns))

    def block_sums(values, dtype):
        return np.add.reduceat(np.add.reduceat(values, columns, axis=1, dtype=dtype),
                               rows, axis=0, dtype=dtype)

    present = np.isfinite(data)
    if categorical:
        return block_sums(present & (data > 0), np.int32) / block_sizes

    count = block_sums(present, np.int32)
    sums = block_sums(np.where(present, data, 0), np.float64)
    overview = np.empty((*count.shape, 2), dtype=np.float32)
    overview[..., 0] = np.divide(sums, count, out=np.full_like(sums, np.nan), where=count > 0)
    overview[..., 1] = count / block_sizes
    return overview


def pack(output, data, grid, *, display_stride, polar_limit_deg, source, features=None, legacy_overview=False):
    """Write a grid-aligned display overview and lossless native tiles."""
    output = Path(output)
    tile_size = 256
    height, width = data.shape
    west, north, step = grid
    encoding = None
    if features is not None:
        overview = aggregate_overview(data, display_stride, categorical=True)
        encoding = "psr-coverage"
    elif display_stride == 1:
        overview = data
    elif legacy_overview:
        # Reproduce the archived bistatic products.
        start = display_stride // 2
        overview = np.full(((height + display_stride - 1) // display_stride,
                            (width + display_stride - 1) // display_stride), np.nan, dtype=np.float32)
        sampled = data[start::display_stride, start::display_stride]
        overview[:sampled.shape[0], :sampled.shape[1]] = sampled
    else:
        overview = aggregate_overview(data, display_stride, categorical=False)
        encoding = "mean-with-coverage"
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
    if encoding is not None:
        metadata["overviewEncoding"] = encoding
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
