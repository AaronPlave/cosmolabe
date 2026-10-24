"""Bounded EPSG:4326 XYZ -> cube adapter for planetary *planetocentric* imagery.

Uses the existing cube layout, pixel/gutter convention and pyramid writer. Source
HTTP responses are cached on disk; decoded windows live only for one output tile.
No terrain is generated. Missing source tiles stay transparent; lower runtime
layers supply fallback. The resulting manifest declares only tiles actually built.
"""
import hashlib
import json
import math
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
from osgeo import gdal

gdal.UseExceptions()


def validate(config):
    if config.get('type', 'xyz') != 'xyz' or config.get('projection', 'EPSG:4326') != 'EPSG:4326':
        raise ValueError('cube XYZ adapter requires an explicit EPSG:4326 XYZ source')
    if config.get('latitudeConvention') != 'planetocentric':
        raise ValueError('declare latitudeConvention=planetocentric; never infer source latitude from the terrain ellipsoid')
    for token in ('{z}', '{x}', '{y}'):
        if token not in config.get('url', ''):
            raise ValueError(f'source URL missing {token}')
    if not 1 <= config.get('levels', 8) <= 25 or not 1 <= config.get('dimension', 256) <= 4096:
        raise ValueError('invalid source pyramid')
    return config


def source_pixel(lon, lat, level, dimension):
    """Pixel centres are integers. XYZ y grows south; longitude wraps at ±180°."""
    across = 2 ** (level + 1) * dimension
    down = 2 ** level * dimension
    return ((lon + 180) / 360 * across - 0.5,
            np.clip((90 - lat) / 180 * down - 0.5, 0, down - 1))


def in_bounds(lon, lat, bounds):
    if bounds is None:
        return np.ones(lon.shape, bool)
    west, south, east, north = bounds
    longitude = ((lon >= west) & (lon <= east)) if west <= east else ((lon >= west) | (lon <= east))
    return longitude & (lat >= south) & (lat <= north)


def read_tile(config, cache, level, x, y):
    # Finite locked builds never fall through to live HTTP or a mutable URL cache.
    # The bundle itself is pinned by the executor; every response has its own hash.
    if 'lockedTiles' in config:
        key = f'{level}/{x}/{y}'
        entry = config['lockedTiles'].get(key)
        if entry is None:
            raise ValueError(f'locked XYZ bundle missing required tile {key}')
        path = Path(entry['path'])
        if hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError(f'locked XYZ checksum mismatch: {key}')
        if entry.get('unavailable'):
            # Explicitly acquired failed response; no generated parent pixels
            # masquerade as native coverage. Other independent layers supply
            # runtime fallback. Staging verifies the failure declaration.
            return None
        return decode(config, path, key)
    url = config['url'].replace('{z}', str(level)).replace('{x}', str(x)).replace('{y}', str(y))
    key = hashlib.sha256(url.encode()).hexdigest()
    path = Path(cache) / key[:2] / (key + '.image')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.with_suffix('.url').write_text(url)
    failure = path.with_suffix('.fallback.json')
    if failure.exists() and config.get('allowSourceFallback'):
        return fallback(config, cache, level, x, y)
    for attempt in range(5):
        try:
            if not path.exists():
                with urllib.request.urlopen(url, timeout=60) as response:
                    data = response.read()
                tmp = path.with_suffix(f'.{os.getpid()}.tmp')
                tmp.write_bytes(data)
                tmp.replace(path)
            return decode(config, path, url)
        except urllib.error.HTTPError as error:
            if error.code in (404, 204):
                return None
            if attempt == 4:
                raise
        except (OSError, TimeoutError, RuntimeError, ValueError) as error:
            # Some source responses are truncated PNGs despite HTTP 200. Verify
            # decoding before trusting the disk cache; refetch on a later try.
            path.unlink(missing_ok=True)
            if attempt == 4:
                if not config.get('allowSourceFallback') or level <= config.get('minZoom', 0):
                    raise RuntimeError(f'Original XYZ response failed after 5 attempts: {url} '
                                       f'({type(error).__name__}: {error})') from error
                failure.write_text(json.dumps({'url': url, 'reason': 'HTTP 200 image decode failure after retries', 'sourceLevel': level, 'fallbackLevel': level - 1}))
                return fallback(config, cache, level, x, y)
        time.sleep(2 ** attempt)


def fallback(config, cache, level, x, y):
    """Explicitly recorded source failure: resample the true parent, never invent detail."""
    image = read_tile(config, cache, level - 1, x // 2, y // 2)
    if image is None:
        return None
    dim = config.get('dimension', 256)
    px = np.clip((np.arange(dim) + 0.5) / 2 + (x % 2) * dim / 2 - 0.5, 0, dim - 1)
    py = np.clip((np.arange(dim) + 0.5) / 2 + (y % 2) * dim / 2 - 0.5, 0, dim - 1)
    x0, y0 = np.floor(px).astype(int), np.floor(py).astype(int)
    fx, fy = px - x0, py - y0
    rgba = image.astype(float) / 255
    rgba[..., :3] *= rgba[..., 3:4]
    out = np.zeros((dim, dim, 4))
    for dx, dy, weight in ((0, 0, (1-fy)[:, None]*(1-fx)), (1, 0, (1-fy)[:, None]*fx), (0, 1, fy[:, None]*(1-fx)), (1, 1, fy[:, None]*fx)):
        out += rgba[np.minimum(y0 + dy, dim - 1)[:, None], np.minimum(x0 + dx, dim - 1)[None, :]] * weight[..., None]
    out[..., :3] /= np.maximum(out[..., 3:4], 1e-12)
    return np.clip(np.round(out * 255), 0, 255).astype(np.uint8)


def decode(config, path, url):
    ds = gdal.Open(str(path))
    dim = config.get('dimension', 256)
    if ds is None or ds.RasterXSize != dim or ds.RasterYSize != dim:
        raise ValueError(f'Unexpected source dimensions: {url}')
    bands = [ds.GetRasterBand(i + 1) for i in range(ds.RasterCount)]
    if len(bands) == 1 and bands[0].GetColorTable():
        table = bands[0].GetColorTable()
        palette = np.array([table.GetColorEntry(i) for i in range(table.GetCount())], np.uint8)
        return palette[bands[0].ReadAsArray()]
    arrays = [b.ReadAsArray() for b in bands]
    if len(arrays) in (1, 2):
        rgb = np.repeat(arrays[0][..., None], 3, axis=-1)
        alpha = arrays[1] if len(arrays) == 2 else np.full((dim, dim), 255, np.uint8)
    else:
        rgb = np.stack(arrays[:3], axis=-1)
        alpha = arrays[3] if len(arrays) >= 4 else np.full((dim, dim), 255, np.uint8)
    return np.concatenate([rgb, alpha[..., None]], axis=-1).astype(np.uint8)


def sample(config, lon, lat, level, cache, read=read_tile):
    """Bilinear RGBA sampling across source tile edges, with premultiplied alpha.

    Nodata contributes no colour; dividing by accumulated alpha avoids dark rims.
    Source responses stay separate, preserving alpha and the layer's provenance.
    """
    dim = config.get('dimension', 256)
    px, py = source_pixel(lon, lat, level, dim)
    x0, y0 = np.floor(px).astype(np.int64), np.floor(py).astype(np.int64)
    fx, fy = px - x0, py - y0
    num = np.zeros(lon.shape + (3,), np.float64)
    alpha = np.zeros(lon.shape, np.float64)
    cover = in_bounds(lon, lat, config.get('bounds'))
    decoded = {}
    for dx, dy, weights in ((0, 0, (1-fx)*(1-fy)), (1, 0, fx*(1-fy)), (0, 1, (1-fx)*fy), (1, 1, fx*fy)):
        cols = (x0 + dx) % (2 ** (level + 1) * dim)
        rows = np.clip(y0 + dy, 0, 2 ** level * dim - 1)
        tx, ty = cols // dim, rows // dim
        ids = tx + ty * 2 ** (level + 1)
        for tile_id in np.unique(ids[cover]):
            mask = (ids == tile_id) & cover
            x, y = int(tile_id % 2 ** (level + 1)), int(tile_id // 2 ** (level + 1))
            if tile_id not in decoded:
                decoded[tile_id] = read(config, cache, level, x, y)
            image = decoded[tile_id]
            if image is None:
                continue
            rgba = image[(rows[mask] % dim).astype(int), (cols[mask] % dim).astype(int)] / 255
            a = rgba[:, 3] * weights[mask]
            num[mask] += rgba[:, :3] * a[:, None]
            alpha[mask] += a
    return num, alpha


def tile(config_path, face, level, x, y, tile_size, gutter, supersample):
    from cube_imagery import pixel_samples, directions, lonlat
    config = validate(json.load(open(config_path)))
    u, v = pixel_samples(level, x, y, tile_size, gutter, supersample)
    lon, lat = lonlat(directions(face, u, v))
    # Match the face-centre output texel; never request above the source's limit.
    source_level = min(config.get('levels', 8) - 1,
                       max(0, level + math.ceil(math.log2(math.pi * tile_size / config.get('dimension', 256)))))
    n = tile_size + 2 * gutter
    if source_level < config.get('minZoom', 0):
        return np.zeros((n, n, 4), np.uint8)
    num, alpha = sample(config, lon, lat, source_level, config['cache'])
    num, alpha = num.mean(axis=-2), alpha.mean(axis=-1)
    rgb = num / np.maximum(alpha[..., None], 1e-12)
    return np.clip(np.round(np.concatenate([rgb, alpha[..., None]], axis=-1) * 255), 0, 255).astype(np.uint8)
