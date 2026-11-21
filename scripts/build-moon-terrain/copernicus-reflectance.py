#!/usr/bin/env python3
"""Pack the pinned Copernicus WAC I/F window into the existing cube imagery format."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

import numpy as np
from osgeo import gdal

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'terrain'))
import cube_imagery as cube

PRODUCT = 'WAC_EMP_643NM_E300N3150_304P'
PIXELS_SHA256 = 'c8862ba8e3d538f9922ce2ec0dfed819f239169d6291d21da6ae03511df0ea26'
URL = ('https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/'
       'LROLRC_2001/DATA/MDR/WAC_EMP/' + PRODUCT + '.IMG')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('crop', help='Native Float32 GeoTIFF from the source window in the validation report')
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    gdal.SetCacheMax(64 * 1024 * 1024)
    ds = gdal.Open(args.crop)
    band = ds.GetRasterBand(1)
    gt = ds.GetGeoTransform()
    expected = (10236524.716867765, 99.747863237334, 0, 354803.14953529695, 0, -99.747863237334)
    values = band.ReadAsArray()
    if (ds.GetMetadataItem('PRODUCT_ID') != PRODUCT or values.shape != (1250, 1250)
            or band.DataType != gdal.GDT_Float32 or not np.allclose(gt, expected, atol=1e-6, rtol=0)
            or ds.GetSpatialRef().ExportToProj4() != '+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +R=1737400 +units=m +no_defs'
            or hashlib.sha256(values.astype('<f4').tobytes()).hexdigest() != PIXELS_SHA256):
        raise SystemExit('Expected the pinned native Copernicus window')
    if args.out.exists():
        raise SystemExit('Use a fresh output directory')
    valid = (band.GetMaskBand().ReadAsArray() > 0) & np.isfinite(values) & (values >= 0) & (values <= 1)
    # Express the same region in west longitudes for the cube sampler.
    west = (gt[0] - 2 * math.pi * 1737400, *gt[1:])
    with TemporaryDirectory(prefix='copernicus-wac-') as scratch:
        prepared = str(Path(scratch) / 'if-and-validity.tif')
        raster = gdal.GetDriverByName('GTiff').Create(prepared, 1250, 1250, 2, gdal.GDT_Float32,
                                                      options=['TILED=YES'])
        raster.SetProjection(ds.GetProjection())
        raster.SetGeoTransform(west)
        raster.SetMetadataItem('COSMOLABE_PREMULTIPLIED_VALIDITY', '1')
        raster.GetRasterBand(1).WriteArray(np.where(valid, values, 0) * 255)
        raster.GetRasterBand(2).WriteArray(valid.astype(np.float32))
        raster.BuildOverviews('AVERAGE', [2, 4, 8, 16, 32, 64])
        raster = None

        region = cube.parse_cube_region('copernicus@9.6447,-20.3651:' + ','.join(f'{level}=91' for level in range(1, 8)))
        source = {
            'id': 'wac-emp-copernicus', 'kind': 'imagery', 'product': PRODUCT, 'productVersion': 'v1.2',
            'url': URL, 'attribution': 'NASA / LROC / ASU', 'resolutionMeters': gt[1],
            'nativeWindow': [20544, 14683, 1250, 1250], 'nativePixelsSha256LEFloat32': PIXELS_SHA256,
            'referenceGeometryDegrees': {'incidence': 30, 'emission': 0, 'phase': 30},
            'validSamples': int(valid.sum()), 'missingSamples': int(valid.size - valid.sum()),
            'sourceNoData': 'PDS CORE_NULL 0xFF7FFFFB; excludes non-finite samples and I/F outside [0,1]',
        }
        registration = {
            'crsId': 'cosmolabe:cube-gnomonic-1/MOON_ME_DE421', 'pixelConvention': 'corner',
            'latitude': 'planetocentric', 'registrationErrorKm': None,
            'footprint': '124.7 km native EQC window; cross-product absolute alignment has not been measured',
            'resampling': 'area-average premultiplied validity and linear I/F; 4x4 cube quadrature; 8-bit linear PNG',
        }
        job = argparse.Namespace(source=prepared, out=str(args.out), body='Moon', tile_size=256, gutter=4,
                                 supersample=4, workers=3, region=[], global_level=0)
        cube.run(job, 'raster', cube.select_tiles(0, [region]), source, registration, 'linear',
                 extra={'sourcePixelsSha256': PIXELS_SHA256})
    path = args.out / 'imagery.json'
    manifest = json.loads(path.read_text())
    manifest['generator']['command'] = 'python3 scripts/build-moon-terrain/copernicus-reflectance.py CROP_TIFF OUTPUT_DIRECTORY'
    manifest['generator']['builderSha256'] = cube.file_sha256(__file__)
    manifest['generator'].pop('seconds')
    path.write_text(json.dumps(manifest, indent=1) + '\n')


if __name__ == '__main__':
    main()
