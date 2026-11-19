#!/usr/bin/env python3
"""Fetch source-stretched browse windows for the baked fallback and visual validation."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import urlopen
import argparse
import html
import io
import json
import math
import re

import numpy as np
from osgeo import gdal, osr
from PIL import Image

LROC = 'https://data.lroc.im-ldi.com'
EXPECT = ('M109032389L', 'M129086118L', 'M131447374L')
BOUNDS = (30.755, 20.15, 30.835, 20.23)


def get(url):
    with urlopen(url, timeout=45) as response:
        return response.read()


def crop(source, output):
    west, south, east, north = BOUNDS
    srs = osr.SpatialReference()
    srs.ImportFromProj4('+proj=eqc +lat_ts=20 +lat_0=0 +lon_0=180 +R=1737400 +units=m +no_defs')
    geo = srs.CloneGeogCS()
    geo.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    proj = osr.CoordinateTransformation(geo, srs)
    min_x, max_y = proj.TransformPoint(west, north)[:2]
    max_x, min_y = proj.TransformPoint(east, south)[:2]
    coord, properties = source['coord'], source['properties']
    width, height = properties['width'], properties['height']
    scale_x = (coord['maxX'] - coord['minX']) / width
    scale_y = (coord['maxY'] - coord['minY']) / height
    x0 = max(0, math.floor((min_x - coord['minX']) / scale_x))
    x1 = min(width, math.ceil((max_x - coord['minX']) / scale_x))
    y0 = max(0, math.floor((coord['maxY'] - max_y) / scale_y))
    y1 = min(height, math.ceil((coord['maxY'] - min_y) / scale_y))
    tile_size = properties['tile_size']
    level = properties['zoom_levels'] - 1
    pyramid = [(math.ceil(width / (tile_size << i)), math.ceil(height / (tile_size << i)))
               for i in range(level, -1, -1)]
    offset = sum(w * h for w, h in pyramid[:-1])
    root = f"{LROC}/ptif/zoomify{source['file_specification_name']}"
    pixels = np.zeros((y1 - y0, x1 - x0), dtype=np.uint8)
    tiles = [(x, y) for y in range(y0 // tile_size, (y1 - 1) // tile_size + 1)
             for x in range(x0 // tile_size, (x1 - 1) // tile_size + 1)]

    def read_tile(tile):
        x, y = tile
        group = (offset + y * pyramid[-1][0] + x) // 256
        payload = get(f'{root}/TileGroup{group}/{level}-{x}-{y}.png')
        return np.asarray(Image.open(io.BytesIO(payload)).convert('L'))

    with ThreadPoolExecutor(max_workers=3) as pool:
        for (x, y), values in zip(tiles, pool.map(read_tile, tiles)):
            tx, ty = x * tile_size, y * tile_size
            left, right, top, bottom = max(x0, tx), min(x1, tx + tile_size), max(y0, ty), min(y1, ty + tile_size)
            pixels[top - y0:bottom - y0, left - x0:right - x0] = values[top - ty:bottom - ty, left - tx:right - tx]
    temporary = output.with_suffix('.part.tif')
    raster = gdal.GetDriverByName('GTiff').Create(str(temporary), x1 - x0, y1 - y0,
                                                  1, gdal.GDT_Byte, ['TILED=YES', 'COMPRESS=DEFLATE'])
    raster.SetSpatialRef(srs)
    raster.SetGeoTransform((coord['minX'] + x0 * scale_x, scale_x, 0,
                            coord['maxY'] - y0 * scale_y, 0, -scale_y))
    raster.SetMetadataItem('PRODUCT_ID', source['product_id'])
    raster.SetMetadataItem('BROWSE_URL', root)
    raster.SetMetadataItem('BROWSE_NATIVE_WINDOW', f'{x0},{y0},{x1-x0},{y1-y0}')
    raster.SetMetadataItem('SUN_AZIMUTH_DEG', str(source['sub_solar_azimuth']))
    raster.SetMetadataItem('MEAN_INCIDENCE_DEG', str(abs(source['incidence_angle'])))
    raster.GetRasterBand(1).WriteArray(pixels)
    raster.Close()
    temporary.rename(output)
    print(output, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    gdal.UseExceptions()
    args.out.mkdir(parents=True, exist_ok=True)
    listing = get(f'{LROC}/lroc/view_rdr/NAC_PHO_E199N0308').decode('utf-8')
    observations = json.loads(html.unescape(re.search("data-photometric-image='([^']+)'", listing)[1]))
    for source in observations:
        if source['image'] in EXPECT:
            output = args.out / (source['image'] + '-browse.tif')
            if not output.exists():
                crop(source, output)


if __name__ == '__main__':
    main()
