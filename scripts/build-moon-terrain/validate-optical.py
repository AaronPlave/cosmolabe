#!/usr/bin/env python3
"""Independent native-to-cube PSR registration/mask check (#147).

Uses the analytic south-polar stereographic equations and original 10 m PDS
pixels, never the builder's prepared raster, GDAL transform, or cube sampler.
Checks level-10 interiors and gutters against 4x4 mask-aware native quadrature.
"""
import argparse
import json
import math
from pathlib import Path
import sys

import numpy as np
from osgeo import gdal

gdal.UseExceptions()
gdal.SetCacheMax(64 * 1024 * 1024)
sys.dont_write_bytecode = True


def native_reference(band, level, x, y, i, j, size, gutter):
    numerator = coverage = 0.
    for dy in range(4):
        for dx in range(4):
            u = -1 + (x + (i + (dx + .5) / 4 - gutter) / size) * 2 / 2**level
            v = -1 + (y + 1 - (j + (dy + .5) / 4 - gutter) / size) * 2 / 2**level
            # nz cube direction = normalize(-u, v, -1).
            lon = math.atan2(v, -u)
            lat = math.atan2(-1, math.hypot(u, v))
            rho = 2 * 1737400 * math.tan((math.pi / 2 + lat) / 2)
            col = (rho * math.sin(lon) + 304010) / 10 - .5
            row = (304010 - rho * math.cos(lon)) / 10 - .5
            c, r = math.floor(col), math.floor(row)
            assert 0 <= c < band.XSize - 1 and 0 <= r < band.YSize - 1
            a = band.ReadAsArray(c, r, 2, 2).astype(float)
            valid = (a >= 3) & (a <= 254)
            fx, fy = col - c, row - r
            w = np.array([[(1-fx)*(1-fy), fx*(1-fy)], [(1-fx)*fy, fx*fy]])
            numerator += float(np.sum(np.where(valid, a, 0) * w))
            coverage += float(np.sum(valid * w))
    return (numerator / coverage if coverage > 0 else 0), coverage / 16


def validate(source, product):
    manifest = json.loads((product / 'imagery.json').read_text())
    assert manifest['registration']['crsId'].endswith('/MOON_ME_DE421')
    assert manifest['source']['nativeResolutionMeters'] == 10
    ds = gdal.Open(str(source)); band = ds.GetRasterBand(1)
    assert (ds.RasterXSize, ds.RasterYSize) == (60802, 60802)
    assert np.allclose(ds.GetGeoTransform(), [-304010, 10, 0, 304010, 0, -10])
    tiles = [t for t in manifest['tiles'] if t.startswith('nz/10/')]
    assert len(tiles) >= 8
    rng = np.random.default_rng(147)
    checked = valid = transparent = partial = gutters = 0
    max_dn = max_alpha = 0.
    # Spread across the finite footprint, including its masked edges.
    for key in sorted(rng.choice(tiles, min(24, len(tiles)), replace=False)):
        _, level, x, y = key.split('/'); level, x, y = map(int, (level, x, y))
        image = gdal.Open(str(product / 'tiles' / (key + '.png'))).ReadAsArray()
        assert image.shape[0] == 2, 'PSR must carry its independent alpha mask'
        size, g = manifest['tileSize'], manifest['gutter']
        points = [(i, j) for i in [0, g, size//2+g, size+2*g-1]
                  for j in [0, g, size//2+g, size+2*g-1]]
        points += list(zip(rng.integers(g, size+g, 24), rng.integers(g, size+g, 24)))
        for i, j in points:
            dn, alpha = native_reference(band, level, x, y, i, j, size, g)
            max_dn = max(max_dn, abs(float(image[0, j, i]) - dn))
            max_alpha = max(max_alpha, abs(float(image[1, j, i]) - alpha * 255))
            checked += 1; valid += alpha > 0; transparent += alpha == 0; partial += 0 < alpha < 1
            gutters += i < g or j < g or i >= size+g or j >= size+g
    assert max_dn <= .501 and max_alpha <= .501, 'source-to-output registration or validity mismatch'
    assert valid and transparent and partial and gutters, 'must test signal, nodata, partial coverage, and gutters'
    # Record true native coverage around Shackleton; the product extent is not
    # a claim that the whole floor was photographed or controlled.
    rho = 2 * 1737400 * math.tan(math.radians(.33) / 2)
    col = int((rho * math.sin(math.radians(129.78)) + 304010) / 10)
    row = int((304010 - rho * math.cos(math.radians(129.78))) / 10)
    window = band.ReadAsArray(col-1500, row-1500, 3000, 3000)
    return {'checkedPixels': checked, 'valid': int(valid), 'transparent': int(transparent),
            'partialCoverage': int(partial), 'gutterPixels': int(gutters),
            'maximumDnError': max_dn, 'maximumAlphaByteError': max_alpha,
            'shackleton30KmWindow': {'pixelWindow': [col-1500, row-1500, 3000, 3000],
                                    'validFraction': float(np.mean((window >= 3) & (window <= 254))),
                                    'specialValueCounts': {str(v): int(np.sum(window == v)) for v in [0, 1, 2, 255]}},
            'absoluteRegistrationErrorKm': None}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--product', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(validate(args.source, args.product), indent=2))
