#!/usr/bin/env python3
"""Independent lunar optical products (#147), using the existing cube sampler.

split --base WAC_COG --baseline SHIPPED_IMAGERY_JSON --out DATA_DIRECTORY
psr --source ORIGINAL_PDS_IMG --out DATA_DIRECTORY

No composited JPEG is used as an input raster. The baseline supplies only the
shipped tile selection and sampling parameters, preserving fallback at every LOD.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import urllib.request

sys.dont_write_bytecode = True
# GDAL's machine-sized default cache is multiplied by every spawned worker.
# Bound it before importing GDAL, including in multiprocessing children.
os.environ['GDAL_CACHEMAX'] = '64'
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'terrain'))
sys.path.insert(0, str(HERE.parent / 'surface-build'))
import cube_imagery as cube
from worker import prepare_imagery
from osgeo import gdal
import numpy as np
gdal.SetCacheMax(64 * 1024 * 1024)

NAC_URL = ('https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/'
           'Lunar_safed/LMAP/SouthPolar/LRO_LROC_NAC_SPOLE-90_Mosaic_1m_controlled_cog.tif')
NAC_ETAG = '"bed0aa45cad34ee85a59fa4084b4522d-9200"'
NAC_BYTES = 77174580438
WAC_SHA256 = 'fa1af0ace36c1d481b246c8362c3fd6128b7757ee5114a9d69ef98efdfecbdac'
BASELINE = 'cube-imagery-composite-3f34a19541af7710'
FRAME = 'MOON_ME_DE421'
PSR_URL = ('https://pds.mcp.nasa.gov/data/store/img/lunar_reconnaissance_orbiter/pds4/lroc/'
           'lro-l-lroc-5-rdr/LROLRC_2001/DATA/BDR/NAC_POLE/NAC_POLE_PSR_SOUTH/'
           'NAC_POLE_PSR_SOUTH_STRETCH.IMG')
PSR_SHA256 = '7d8f3f48a439f673263a46e133fe37803203786597f35ee328b1621326383a1d'


def pin_nac():
    with urllib.request.urlopen(urllib.request.Request(NAC_URL, method='HEAD'), timeout=60) as response:
        assert response.headers['ETag'] == NAC_ETAG, 'NAC source changed; audit before rebuilding'
        assert int(response.headers['Content-Length']) == NAC_BYTES
    return {'url': NAC_URL, 'etag': NAC_ETAG, 'bytes': NAC_BYTES}


def registration(footprint, resampling):
    return {'crsId': f'cosmolabe:cube-gnomonic-1/{FRAME}', 'pixelConvention': 'corner',
            'latitude': 'planetocentric', 'registrationErrorKm': None,
            'footprint': footprint, 'resampling': resampling}


def source_grid(path):
    ds = cube.raster_open(str(path))['ds']
    return {'dimensions': [ds.RasterXSize, ds.RasterYSize],
            'affine': list(ds.GetGeoTransform()), 'crsWkt': ds.GetProjection(),
            'nodata': ds.GetRasterBand(1).GetNoDataValue()}


def public_metadata(path):
    """Publish a reproduction template without disclosing local source paths.

    This changes only the descriptive command. Tile identity, source pins and
    the generator hashes used for the actual build are retained.
    """
    path = Path(path)
    manifest = json.loads(path.read_text())
    name = manifest['source']['id']
    if name == 'psr-nac-stretch':
        command = 'psr --source PINNED_NAC_POLE_PSR_SOUTH_STRETCH.IMG'
    else:
        assert name in ('wac', 'nac-independent')
        command = ('split --base PINNED_WAC_COG --baseline PINNED_COMPOSITE/imagery.json '
                   '--only ' + ('wac' if name == 'wac' else 'nac'))
    manifest['generator']['command'] = f'python3 scripts/build-moon-terrain/optical.py {command} --out DATA_DIRECTORY'
    manifest['generator']['commandKind'] = 'reproduction-template'
    path.write_text(json.dumps(manifest, indent=1) + '\n')


def emit(args, name, kind, source, tiles, provenance, reg, supersample=3):
    output = Path(args.out) / f'moon-imagery-cube-{name}'
    assert not (output / 'imagery.json').exists(), f'{output}: use a fresh output directory'
    job = argparse.Namespace(source=str(source), out=str(output), body='Moon', frame=FRAME,
                             tile_size=args.tile_size, gutter=args.gutter, supersample=supersample,
                             workers=args.workers, region=[], global_level=0)
    provenance = {**provenance, 'builderSha256': cube.file_sha256(str(Path(__file__))),
                  'frameAudit': 'docs/validation/lunar-frames/README.md',
                  'absoluteRegistrationErrorKm': None, 'gdal': gdal.VersionInfo('RELEASE_NAME'),
                  'inputGrid': source_grid(source)}
    cube.run(job, kind, tiles, {'id': name, 'kind': 'imagery', **provenance}, reg, 'srgb',
             extra={'provenance': provenance})
    public_metadata(output / 'imagery.json')


def split(args):
    baseline = json.loads(Path(args.baseline).read_text())
    assert baseline['source']['version'] == BASELINE, 'expected the pinned production baseline'
    assert baseline['tileSize'] == args.tile_size and baseline['gutter'] == args.gutter
    tiles = [(f, int(l), int(x), int(y)) for f, l, x, y in (t.split('/') for t in baseline['tiles'])]
    ss = baseline['generator']['supersample']
    # Sample the same original rasters and overview policy as the shipped composite.
    # In particular, retain WAC at deep polar levels for partial-alpha fallback.
    assert cube.file_sha256(args.base) == WAC_SHA256, 'WAC COG differs from pinned production input'
    nac_pin = pin_nac()
    sampling = f'original source overviews, bilinear validity weighting, {ss}x{ss} box per cube texel'
    if args.only in (None, 'wac'):
        emit(args, 'wac', 'base', args.base, tiles,
             {'baselineRevision': BASELINE, 'nativeResolutionMeters': 100,
              'sha256': WAC_SHA256,
              'attribution': 'LROC team / USGS; WAC global morphology, June 2013 mosaic edition; images November 2009-February 2011; acquisition shading retained'},
             registration('global; same bounded tile selection as shipped WAC+NAC', sampling), ss)
    if args.only in (None, 'nac'):
        emit(args, 'nac-independent', 'nac', '/vsicurl/' + NAC_URL,
             [t for t in tiles if t[1] == 0 or cube.nac_intersects(*t)],
             {'baselineRevision': BASELINE, 'nativeResolutionMeters': 1, **nac_pin,
              'attribution': 'LROC team / USGS controlled south-pole NAC mirror; nodata 0 transparent; acquisition shading retained'},
             registration('original 364214 square at 1 m; polar stereographic +/-182107 m; nodata transparent', sampling), ss)
    pin_nac()  # detect a changed source during windowed acquisition


def psr(args):
    source = Path(args.source)
    assert source.stat().st_size == 3696944006, 'PSR source size differs from the verified PDS product'
    source_sha = cube.file_sha256(str(source))
    assert source_sha == PSR_SHA256, 'PSR source bytes changed; audit before rebuilding'
    ds = gdal.Open(str(source))
    assert ds.GetDriver().ShortName == 'PDS', 'use original PDS IMG, not the resampled browse TIFF'
    assert (ds.RasterXSize, ds.RasterYSize) == (60802, 60802)
    assert np.allclose(ds.GetGeoTransform(), [-304010, 10, 0, 304010, 0, -10], rtol=0, atol=1e-8)
    label = source.open('rb').read(60802).decode('ascii')
    assert 'NAC_POLE_PSR_SOUTH_STRETCH' in label and '2022-12-02T19:58:55' in label
    cube.raster_open(str(source))  # enforces 1737400 m sphere
    prepared = Path(args.work) / 'psr-validity.tif'
    prepared.parent.mkdir(parents=True, exist_ok=True)
    assert not prepared.exists(), 'use fresh output; never reuse unverified validity overviews'
    print('Preparing original PSR DN and validity overviews (64 MB GDAL cache)', flush=True)
    receipt = prepare_imagery(source, prepared, valid_range=(3, 254))
    print('PSR validity preparation complete', flush=True)
    regions = [cube.parse_cube_region(r) for r in [
        'south-pole@-90,0:1=500,2=500,3=500,4=500,5=500,6=400,7=310,8=100,9=50,10=25',
        'shackleton@-89.67,129.78:8=100,9=50,10=25']]
    emit(args, 'psr-nac-stretch', 'raster', prepared, cube.select_tiles(0, regions),
         {'url': PSR_URL, 'sha256': source_sha, 'productVersion': 'v1.1',
          'nativeResolutionMeters': 10, 'effectivePixelDimensionsMeters': '10-40 by 1-4 (long exposure)',
          'acquisitionStart': '2012-08-01T13:41:45', 'acquisitionEnd': '2017-08-31T00:44:41',
          'created': '2022-12-02T19:58:55', 'validityPreparation': receipt,
          'attribution': 'NASA / LROC / ASU; Brown et al. 2022, abstract 5033',
          'interpretation': 'PSR observational imagery: stretched, indirectly lit; arbitrary DN, not reflectance or simulation-time sunlight; uncontrolled'},
         registration('finite built south-polar subset; original valid DN 3-254 only; missing/saturated pixels transparent',
                      'premultiplied native DN/validity area-average overviews; bilinear reconstruction; 4x4 cube quadrature'), 4)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('split', 'psr'):
        p = sub.add_parser(name)
        p.add_argument('--out', required=True)
        p.add_argument('--workers', type=int, choices=range(1, 5), default=1)
        p.add_argument('--tile-size', type=int, default=256)
        p.add_argument('--gutter', type=int, default=4)
    sub.choices['split'].add_argument('--base', required=True)
    sub.choices['split'].add_argument('--baseline', required=True)
    sub.choices['split'].add_argument('--only', choices=('wac', 'nac'))
    sub.choices['psr'].add_argument('--source', required=True)
    sub.choices['psr'].add_argument('--work', default='work/lunar-optical')
    args = parser.parse_args()
    (split if args.command == 'split' else psr)(args)


if __name__ == '__main__':
    main()
