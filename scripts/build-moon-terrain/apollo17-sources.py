#!/usr/bin/env python3
"""Fetch bounded, native-grid Apollo 17 PDS windows without downloading entire NAC images."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import argparse
import math
import re
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from osgeo import gdal, osr


ARCHIVE = ('https://pds.mcp.nasa.gov/data/store/img/lunar_reconnaissance_orbiter/'
           'pds4/lroc/lro-l-lroc-5-rdr/LROLRC_2001/DATA/SDP')
OBSERVATIONS = ('M109032389L', 'M129086118L', 'M131447374L')
DTM = 'NAC_DTM_APOLLO17_1_E199N0308'
# Native crops include the southern valley wall and margin for view comparison.
BOUNDS = (30.755, 20.15, 30.835, 20.23)


def fetch_range(url, start, end, total=None):
    for attempt in range(4):
        try:
            request = Request(url, headers={'Range': f'bytes={start}-{end}'})
            with urlopen(request, timeout=30) as response:
                match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
                if response.status != 206 or not match:
                    raise IOError(f'Expected a byte-range response from {url}')
                first, last, length = map(int, match.groups())
                if (first, last) != (start, end) or (total is not None and length != total):
                    raise IOError(f'Unexpected byte range {match[0]}')
                payload = response.read(end - start + 2)
                if len(payload) != end - start + 1:
                    raise IOError(f'Short byte range at {start} for {url}')
                return payload, length
        except OSError as error:
            if isinstance(error, HTTPError) and error.code == 429:
                raise IOError(f'PDS rate limited the request; Retry-After: {error.headers.get("Retry-After", "unspecified")}') from error
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def crop_observation(observation, target):
    product = f'NAC_PHO_E199N0308_{observation}'
    url = f'{ARCHIVE}/NAC_PHO/E199N0308/{product}.IMG'
    label, total = fetch_range(url, 0, 16383)
    with tempfile.TemporaryDirectory(dir=target.parent) as scratch:
        image = Path(scratch) / f'{product}.IMG'
        with image.open('wb') as stream:
            stream.write(label)
            stream.truncate(total)
        ds = gdal.Open(str(image))
        width, height = ds.RasterXSize, ds.RasterYSize
        record = width * 4
        header = label.split(b'OBJECT = IMAGE_MAP_PROJECTION')[0]
        version = re.search(rb'PRODUCT_VERSION_ID\s*=\s*"([^"]+)"', header)
        bands = re.search(rb'BAND_NAME\s*=\s*\(BROADBAND,\s*"PHASE ANGLE",\s*"LOCAL EMISSION\s+ANGLE",\s*"LOCAL INCIDENCE ANGLE"\)', label)
        if (ds.GetMetadataItem('PRODUCT_ID') != product or ds.RasterCount != 4
                or ds.GetRasterBand(1).DataType != gdal.GDT_Float32
                or total != record * (1 + 4 * height)
                or not re.search(rb'\^IMAGE\s*=\s*2\r?\n', header)
                or version is None or bands is None
                or b'BAND_SEQUENTIAL' not in label or b'PC_REAL' not in label):
            raise ValueError(f'Unexpected PDS layout for {product}')
        srs = ds.GetSpatialRef()
        geo = srs.CloneGeogCS()
        geo.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        proj = osr.CoordinateTransformation(geo, srs)
        west, south, east, north = BOUNDS
        inverse = gdal.InvGeoTransform(ds.GetGeoTransform())
        c0, r0 = gdal.ApplyGeoTransform(inverse, *proj.TransformPoint(west, north)[:2])
        c1, r1 = gdal.ApplyGeoTransform(inverse, *proj.TransformPoint(east, south)[:2])
        c0, c1 = max(0, math.floor(c0)), min(width, math.ceil(c1))
        r0, r1 = max(0, math.floor(r0)), min(height, math.ceil(r1))
        if c0 >= c1 or r0 >= r1:
            raise ValueError(f'{product} misses the pilot window')
        ranges = []
        chunk = 32 * 1024 * 1024
        for band in range(4):
            first = record * (1 + band * height + r0)
            end = record * (1 + band * height + r1)
            ranges.extend((start, min(start + chunk, end) - 1) for start in range(first, end, chunk))
        with ThreadPoolExecutor(max_workers=2) as pool, image.open('r+b') as stream:
            for (start, _), (data, _) in zip(ranges, pool.map(lambda r: fetch_range(url, *r, total), ranges)):
                stream.seek(start)
                stream.write(data)
        # Reopen after filling the sparse ranges so GDAL sees the fetched bytes.
        ds = None
        ds = gdal.Open(str(image))
        out = gdal.Translate(str(target), ds, srcWin=[c0, r0, c1 - c0, r1 - r0],
                             creationOptions=['TILED=YES', 'COMPRESS=DEFLATE', 'PREDICTOR=3'])
        out.SetMetadataItem('PDS_SOURCE_URL', url)
        out.SetMetadataItem('PDS_SOURCE_VERSION', version[1].decode('ascii'))
        out.SetMetadataItem('PDS_NATIVE_WINDOW', f'{c0},{r0},{c1-c0},{r1-r0}')
        out.Close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('out', type=Path)
    parser.add_argument('--observation', choices=OBSERVATIONS, action='append',
                        help='fetch only the chosen observation (repeatable)')
    args = parser.parse_args()
    gdal.UseExceptions()
    args.out.mkdir(parents=True, exist_ok=True)
    terrain = args.out / f'{DTM}.IMG'
    temp = terrain.with_suffix('.part')
    if not terrain.exists():
        url = f'{ARCHIVE}/NAC_DTM/APOLLO17_1/{DTM}.IMG'
        with urlopen(url, timeout=60) as response, temp.open('wb') as stream:
            while chunk := response.read(1024 * 1024):
                stream.write(chunk)
        if temp.stat().st_size != 139753440 or gdal.Open(str(temp)).GetMetadataItem('PRODUCT_ID') != DTM:
            raise ValueError('Unexpected Apollo 17 terrain payload')
        temp.rename(terrain)
    for observation in args.observation or OBSERVATIONS:
        target = args.out / f'{observation}-native.tif'
        if target.exists():
            continue
        pending = target.with_suffix('.part.tif')
        crop_observation(observation, pending)
        pending.rename(target)
        print(target, flush=True)


if __name__ == '__main__':
    main()
