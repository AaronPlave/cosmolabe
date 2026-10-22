#!/usr/bin/env python3
"""Filesystem/GDAL worker for the finite surface executor. No network acquisition.

Only dispatches existing fusion/cube primitives. Source rasters must already have
the declared CRS/datum: this worker never guesses or reprojects them.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

import numpy as np
from osgeo import gdal

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/terrain'))
gdal.UseExceptions()


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def write(path, data):
    Path(path).write_text(json.dumps(data, sort_keys=True, indent=2) + '\n')


def raster(path, radius, global_base=False):
    ds = gdal.Open(str(path))
    assert ds.RasterCount == 1, 'elevation requires one band'
    srs = ds.GetSpatialRef()
    assert srs and srs.IsGeographic(), 'only geographic rasters are executable'
    assert abs(srs.GetSemiMajor() - radius) < 1e-4 and srs.GetInvFlattening() == 0, 'source reference shape differs from lock'
    assert ds.GetMetadataItem('AREA_OR_POINT') != 'Point', 'pixel-is-point raster is unsupported'
    gt = ds.GetGeoTransform()
    assert gt[1] > 0 and gt[5] < 0 and gt[2] == gt[4] == 0, 'requires north-up grid'
    if global_base:
        assert abs(gt[1] * ds.RasterXSize - 360) < 1e-6 and abs(gt[5] * ds.RasterYSize + 180) < 1e-6 and abs(gt[3] - 90) < 1e-6, 'base must cover entire globe'
    b = ds.GetRasterBand(1)
    valid_count = 0
    for row in range(0, ds.RasterYSize, 128):
        a = b.ReadAsArray(0, row, ds.RasterXSize, min(128, ds.RasterYSize - row))
        mask = b.GetMaskBand().ReadAsArray(0, row, ds.RasterXSize, a.shape[0])
        ok = np.isfinite(a) & (mask > 0)
        if b.GetNoDataValue() is not None:
            ok &= a != b.GetNoDataValue()
        assert ok.all(), 'v1 lock declared nodata none but raster has invalid pixels'
        valid_count += int(ok.sum())
    return {'width': ds.RasterXSize, 'height': ds.RasterYSize, 'validPixels': valid_count,
            'grid': list(gt), 'sourceSha256': sha(path), 'decodedBytes': valid_count * gdal.GetDataTypeSize(b.DataType) // 8}


def bundle(path, target, source_dir):
    from cube_xyz import validate
    doc = json.loads(Path(path).read_text())
    assert doc.get('version') == 1 and doc.get('kind') == 'locked-xyz-bundle', 'expected locked XYZ bundle v1'
    config = doc['config']
    allowed = {'type', 'projection', 'latitudeConvention', 'url', 'levels', 'dimension', 'minZoom', 'bounds'}
    assert not set(config) - allowed, 'unsupported/mutable XYZ configuration'
    validate(config)
    locked, size, seen = {}, 0, set()
    assert 0 < len(doc['tiles']) <= 100000, 'finite XYZ tile list required'
    for key, entry in sorted(doc['tiles'].items()):
        z, x, y = (int(p) for p in key.split('/'))
        assert 0 <= z < config['levels'] and 0 <= x < 2 ** (z + 1) and 0 <= y < 2 ** z, 'invalid XYZ address'
        local = (Path(source_dir) / entry['path']).resolve()
        assert sha(local) == entry['sha256'], f'XYZ checksum mismatch: {key}'
        frozen = Path(target).parent / (entry['sha256'] + '.image')
        shutil.copyfile(local, frozen)
        assert sha(frozen) == entry['sha256'], 'XYZ source changed during staging'
        from cube_xyz import decode
        image = decode(config, frozen, key)
        assert np.all(image[..., 3] == 255), 'v1 unmasked lock cannot contain source alpha/nodata'
        locked[key] = {'path': str(frozen), 'sha256': entry['sha256']}
        if entry['sha256'] not in seen:
            size += local.stat().st_size
            seen.add(entry['sha256'])
    write(target, {**config, 'cache': str(Path(target).parent), 'lockedTiles': locked})
    return {'responses': len(locked), 'responseBytes': size, 'sourceConfig': config}


def command(*args):
    subprocess.run([str(a) for a in args], check=True, cwd=ROOT)


def build(args):
    job = json.loads(Path(args.job).read_text())
    lock, dag = job['lock'], job['dag']
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=False)
    inputs = out / 'inputs'
    inputs.mkdir()
    paths = {}
    for source in lock['sources']:
        suffix = '.tif' if source['channel'] == 'elevation' else '.json'
        frozen = inputs / (source['asset']['checksum']['value'] + suffix)
        shutil.copyfile(job['paths'][source['id']], frozen)
        assert sha(frozen) == source['asset']['checksum']['value'], 'source changed during staging'
        paths[source['id']] = str(frozen)
    transform = next(s['transformations'][0] for s in lock['selections'] if s['channel'] == 'elevation')
    areoid_args = []
    if transform != 'identity':
        datum_dir = inputs / 'areoid'
        datum_dir.mkdir()
        for role, filename in [('label', 'MEGA90N000EB.LBL'), ('image', 'MEGA90N000EB.IMG')]:
            pin = transform['areoid'][role]
            frozen = datum_dir / filename
            shutil.copyfile(job['paths']['datum:areoid-' + role], frozen)
            assert frozen.stat().st_size == pin['bytes'] and sha(frozen) == pin['checksum']['value'], 'datum changed during staging'
        label = (datum_dir / 'MEGA90N000EB.LBL').read_text()
        import re
        assert re.search(r'\^IMAGE\s*=\s*"MEGA90N000EB.IMG"', label), 'unsupported detached areoid image reference'
        ds = gdal.Open(str(datum_dir / 'MEGA90N000EB.LBL'))
        assert {Path(p).resolve() for p in ds.GetFileList()} == {p.resolve() for p in datum_dir.iterdir()}, 'areoid label references unpinned files'
        ds = None
        areoid_args = ['--areoid', datum_dir / 'MEGA90N000EB.LBL']
    radius = lock['desired']['coordinates']['referenceShape']['radiusKm'] * 1000
    p = lock['processing']['parameters']
    terrain = p['terrain']
    audit = {'rasters': {}, 'imagery': {}}
    for source in lock['sources']:
        assert sha(paths[source['id']]) == source['asset']['checksum']['value'], 'source changed after preflight'
        if source['channel'] == 'elevation':
            audit['rasters'][source['id']] = raster(paths[source['id']], radius, source['id'] == terrain['base'])
        else:
            audit['imagery'][source['id']] = bundle(paths[source['id']], inputs / f'{source["asset"]["checksum"]["value"]}.config.json',
                                                   Path(job['paths'][source['id']]).parent)
    fusion = out / 'fusion'
    command(sys.executable, ROOT / 'scripts/terrain/dem.py', 'fuse', '--base', paths[terrain['base']],
            '--detail', paths[terrain['detail']], '--out', fusion, '--blend-m', terrain['blendM'],
            '--fit-stride', terrain['fitStride'], '--bias', 'none', '--vertical-datum', 'reference-sphere radial metres' if transform == 'identity' else 'MOLA areoid topography metres; radial conversion is explicit at cube construction')
    f = json.loads((fusion / 'fusion.json').read_text())
    assert abs(f['registration']['offsetM']) <= p['gates']['maxOffsetM'], 'registration offset exceeds locked gate'
    boundary = f['boundary']['fusedStepM']
    assert boundary.get('n', 0) == 0 or boundary['maxAbsM'] <= p['gates']['maxBoundaryStepM'], 'fused boundary step exceeds locked gate'
    # Volatile times/local paths must not affect the fused content revision.
    f.pop('created', None)
    for role in ('base', 'detail'):
        f[role]['path'] = f'{role}.tif'
    write(fusion / 'fusion.json', f)
    for product in dag['products']:
        dest = out / product['id']
        tile = product['tiling']
        regions = [part for r in tile['regions'] for part in ['--region', r]]
        if product['kind'] == 'cube-terrain':
            command(sys.executable, ROOT / 'scripts/terrain/dem.py', 'cube-tile', '--base', paths[terrain['base']],
                    '--fusion', fusion, '--out', dest, '--ellipsoid', radius, radius if transform == 'identity' else 3376200,
                    '--source-convention', 'sphere-radial' if transform == 'identity' else 'areoid-radial', *areoid_args,
                    '--body', 'Mars', '--frame', 'IAU_MARS', '--global-level', tile['globalLevel'], '--workers', args.workers, *regions)
            command(sys.executable, ROOT / 'scripts/terrain/dem.py', 'cube-error', dest, '--workers', args.workers)
        else:
            source = next(s for s in lock['sources'] if s['id'] == product['sourceIds'][0])
            config = inputs / f'{source["asset"]["checksum"]["value"]}.config.json'
            command(sys.executable, ROOT / 'scripts/terrain/cube_imagery.py', 'xyz', '--source', config,
                    '--out', dest, '--body', 'Mars', '--frame', 'IAU_MARS', '--radius-km', radius / 1000,
                    '--global-level', tile['globalLevel'], '--tile-size', lock['output']['tileSize'],
                    '--gutter', lock['output']['gutter'], '--supersample', 1, '--workers', args.workers, *regions)
        # Runtime manifests are immutable product metadata; execution timing and
        # temporary paths belong to the actual-vs-planned report, outside them.
        if product['kind'] == 'cube-terrain':
            meta_path = dest / 'terrain-product.json'
            meta = json.loads(meta_path.read_text())
            meta.pop('created', None)
            for k in ('generationSeconds', 'skirtGapSeconds', 'workers'):
                meta.pop(k, None)
            mesh_path = dest / 'mesh-error.json'
            mesh = json.loads(mesh_path.read_text())
            for k in ('created', 'seconds', 'workers', 'product'):
                mesh.pop(k, None)
            write(mesh_path, mesh)
        else:
            meta_path = dest / 'imagery.json'
            meta = json.loads(meta_path.read_text())
            meta['generator'].pop('seconds', None)
            meta['generator']['command'] = 'locked surface build (see lockIdentity in build receipt)'
        write(meta_path, meta)
    audit['workerPeakRssBytes'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1024 if sys.platform != 'darwin' else 1)
    audit['largestChildPeakRssBytes'] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * (1024 if sys.platform != 'darwin' else 1)
    audit['peakConcurrentRssBytes'] = None
    write(out / 'source-audit.json', audit)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--job', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--workers', type=int, default=1)
    args = p.parse_args()
    assert 1 <= args.workers <= 8
    build(args)
