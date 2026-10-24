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


def reject_external_masks(path):
    ds = gdal.Open(str(path))
    ds.GetRasterBand(1).GetMaskBand()
    assert not Path(str(path) + '.msk').exists() and not any(
        name.lower().endswith('.msk') for name in ds.GetFileList()
    ), 'external mask dependencies are unsupported; use a pinned TIFF with an internal mask'


def prepare_imagery(source, target):
    """Deterministic area-average pyramid of premultiplied DN and coverage.

    Averaging both channels preserves invalid-area transparency at every level;
    averaging already-normalized DN would bleed invalid values into valid data.
    Original bytes are immutable. Derived overviews use the pinned GDAL version.
    """
    ds = gdal.Open(str(source)); band = ds.GetRasterBand(1)
    assert band.DataType == gdal.GDT_Byte and ds.RasterCount == 1, 'raster imagery requires one byte band'
    out = gdal.GetDriverByName('GTiff').Create(str(target), ds.RasterXSize, ds.RasterYSize, 2, gdal.GDT_Float32,
                                             options=['TILED=YES', 'COMPRESS=DEFLATE', 'PREDICTOR=3'])
    out.SetGeoTransform(ds.GetGeoTransform()); out.SetProjection(ds.GetProjection())
    out.SetMetadataItem('COSMOLABE_PREMULTIPLIED_VALIDITY', '1')
    for row in range(0, ds.RasterYSize, 128):
        height = min(128, ds.RasterYSize-row)
        a = band.ReadAsArray(0,row,ds.RasterXSize,height)
        valid = np.isfinite(a) & (band.GetMaskBand().ReadAsArray(0,row,ds.RasterXSize,height)>0)
        if band.GetNoDataValue() is not None: valid &= a != band.GetNoDataValue()
        out.GetRasterBand(1).WriteArray(np.where(valid,a,0).astype(np.float32),0,row)
        out.GetRasterBand(2).WriteArray(valid.astype(np.float32),0,row)
    factors=[]; factor=2
    while factor <= max(ds.RasterXSize,ds.RasterYSize):
        factors.append(factor); factor*=2
    if factors: out.BuildOverviews('AVERAGE', factors)
    out=None
    return {'method':'GDAL area-average power-of-two overviews of premultiplied native DN and binary validity; 4x4 cube-footprint quadrature',
            'overviewFactors':factors,'sha256':sha(target),'bytes':Path(target).stat().st_size,
            'gdal':gdal.VersionInfo('RELEASE_NAME'),'supersample':4}


def valid_subset(ds, source, gt):
    """Prove every native cell touched by the declared subset and kernel halo.

    This accepts the existing geographic/zero-origin EQC transform only. No
    reprojection, bounding-box replacement or sampled-mask approximation occurs.
    """
    from osgeo import ogr
    import math
    evidence = source.get('metadata', {}).get('validData')
    if not evidence:
        return None
    proofs = []
    for feature in evidence['geometry']['features']:
        geometry = ogr.CreateGeometryFromJson(json.dumps(feature['geometry']))
        west, east, south, north = geometry.GetEnvelope()
        x0 = math.floor((west - gt[0]) / gt[1]) - 2
        x1 = math.ceil((east - gt[0]) / gt[1]) + 2
        y0 = math.floor((north - gt[3]) / gt[5]) - 2
        y1 = math.ceil((south - gt[3]) / gt[5]) + 2
        assert 0 <= x0 < x1 <= ds.RasterXSize and 0 <= y0 < y1 <= ds.RasterYSize, 'valid subset/kernel support exceeds source raster'
        assert (x1-x0)*(y1-y0) <= 16000000, 'valid-subset inspection window exceeds bounded pilot limit'
        band = ds.GetRasterBand(1)
        data = band.ReadAsArray(x0, y0, x1-x0, y1-y0)
        valid = np.isfinite(data) & (band.GetMaskBand().ReadAsArray(x0, y0, x1-x0, y1-y0) > 0)
        if band.GetNoDataValue() is not None:
            valid &= data != band.GetNoDataValue()
        mask = gdal.GetDriverByName('MEM').Create('', x1-x0, y1-y0, 1, gdal.GDT_Byte)
        mask.SetGeoTransform((gt[0]+x0*gt[1], gt[1], 0, gt[3]+y0*gt[5], 0, gt[5]))
        vectors = ogr.GetDriverByName('Memory').CreateDataSource('')
        layer = vectors.CreateLayer('valid')
        item = ogr.Feature(layer.GetLayerDefn()); item.SetGeometry(geometry); layer.CreateFeature(item)
        gdal.RasterizeLayer(mask, [1], layer, burn_values=[1], options=['ALL_TOUCHED=TRUE'])
        inside = mask.ReadAsArray().astype(bool)
        support = inside.copy()
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                support |= np.roll(np.roll(inside, dy, axis=0), dx, axis=1)
        assert inside.any() and valid[support].all(), 'declared native-valid subset intersects nodata or invalid kernel support'
        proofs.append({'featureId': feature['id'], 'window': [x0,y0,x1-x0,y1-y0],
                       'nativeCells': int(inside.sum()), 'kernelSupportCells': int(support.sum()),
                       'maskSha256': hashlib.sha256(inside.tobytes()).hexdigest()})
    return {'extent': 'known-valid-subset', 'declaredExtent': evidence['extent'], 'method': 'all touched native cells plus two-cell interpolation halo', 'features': proofs}


def raster(path, radius, source, global_base=False):
    from dem import geographic_grid
    ds = gdal.Open(str(path))
    assert ds.RasterCount == 1, 'elevation requires one band'
    srs = ds.GetSpatialRef()
    assert srs, 'raster has no CRS'
    assert abs(srs.GetSemiMajor() - radius) < 1e-4 and srs.GetInvFlattening() == 0, 'source reference shape differs from lock'
    assert (source['projection'] == 'EPSG:4326') == bool(srs.IsGeographic()), 'source projection differs from lock'
    assert ds.GetMetadataItem('AREA_OR_POINT') != 'Point', 'pixel-is-point raster is unsupported'
    gt = geographic_grid(ds)
    assert gt[1] > 0 and gt[5] < 0 and gt[2] == gt[4] == 0, 'requires north-up grid'
    if global_base:
        assert abs(gt[1] * ds.RasterXSize - 360) <= abs(gt[1]) and abs(gt[5] * ds.RasterYSize + 180) <= abs(gt[5]) and abs(gt[3] - 90) < 1e-6, 'base must cover globe to within one source pixel'
    raster_gsd = abs(gt[5]) * np.pi / 180 * radius
    declared_grid = source.get('metadata', {}).get('rasterGsdM')
    assert declared_grid is None or abs(raster_gsd-declared_grid) <= max(1e-6, raster_gsd*1e-6), 'source raster interval differs from locked metadata'
    b = ds.GetRasterBand(1)
    valid_count = 0
    for row in range(0, ds.RasterYSize, 128):
        a = b.ReadAsArray(0, row, ds.RasterXSize, min(128, ds.RasterYSize - row))
        mask = b.GetMaskBand().ReadAsArray(0, row, ds.RasterXSize, a.shape[0])
        ok = np.isfinite(a) & (mask > 0)
        if b.GetNoDataValue() is not None:
            ok &= a != b.GetNoDataValue()
        if source['nodata'] == 'none':
            assert ok.all(), 'lock declared nodata none but raster has invalid pixels'
        valid_count += int(ok.sum())
    return {'width': ds.RasterXSize, 'height': ds.RasterYSize, 'validPixels': valid_count,
            'invalidPixels': ds.RasterXSize*ds.RasterYSize-valid_count, 'rasterGsdM': float(raster_gsd),
            'nativeValidSubset': valid_subset(ds, source, gt),
            'grid': list(gt), 'nativeGrid': list(ds.GetGeoTransform()), 'crsWkt': srs.ExportToWkt(), 'sourceSha256': sha(path), 'decodedBytes': ds.RasterXSize*ds.RasterYSize * gdal.GetDataTypeSize(b.DataType) // 8}


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
    toolchain = {'python': sys.version.split()[0], 'gdal': gdal.VersionInfo('RELEASE_NAME'), 'numpy': np.__version__}
    pins = lock['processing']['parameters'].get('toolchain')
    assert pins is None or pins == toolchain, 'Python/GDAL/NumPy toolchain differs from lock'
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=False)
    from resources import ResourceSampler
    sampler = ResourceSampler(out)
    inputs = out / 'inputs'
    inputs.mkdir()
    # The orchestrator has verified current bindings and the complete prior
    # inventories, including audit evidence. Only changed products need private
    # source copies, native-pixel scans, datum staging or fusion construction.
    reused = job.get('reusedProducts', {})
    required = [p for p in dag['products'] if p['id'] not in reused]
    required_sources = {sid for p in required for sid in p['sourceIds']}
    terrain_required = any(p['kind'] == 'cube-terrain' for p in required)
    prior_terrain = next((reused[p['id']]['audit'] for p in dag['products']
                          if p['kind'] == 'cube-terrain' and p['id'] in reused), None)
    paths = {}
    for source in lock['sources']:
        if source['id'] not in required_sources: continue
        suffix = '.tif' if source['channel'] == 'elevation' or source['projection'] == 'Mars-EQC-0-0' else '.json'
        if suffix == '.tif': reject_external_masks(job['paths'][source['id']])
        frozen = inputs / (source['asset']['checksum']['value'] + suffix)
        shutil.copyfile(job['paths'][source['id']], frozen)
        assert sha(frozen) == source['asset']['checksum']['value'], 'source changed during staging'
        paths[source['id']] = str(frozen)
    terrain = lock['processing']['parameters']['terrain']
    if terrain_required and terrain.get('baseOverviewAsset'):
        pin = terrain['baseOverviewAsset']
        overview = Path(paths[terrain['base']] + '.ovr')
        shutil.copyfile(job['paths']['terrain:base-overview'], overview)
        assert overview.stat().st_size == pin['bytes'] and sha(overview) == pin['checksum']['value'], 'overview changed during staging'
    transform = next(s['transformations'][0] for s in lock['selections'] if s['channel'] == 'elevation')
    areoid_args = []
    if terrain_required and transform != 'identity':
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
    audit = {'rasters': {}, 'imagery': {}, 'toolchain': toolchain,
             'executionWork': {'stagedSources': sorted(required_sources),
                               'terrainStaging': terrain_required, 'fusion': terrain_required,
                               'auditedSources': sorted(required_sources)}}
    if prior_terrain:
        audit['rasters'].update(prior_terrain['rasters'])
    for previous in reused.values():
        for sid, evidence in previous['audit']['imagery'].items():
            if sid not in required_sources: audit['imagery'][sid] = evidence
    for source in lock['sources']:
        if source['id'] not in required_sources: continue
        assert sha(paths[source['id']]) == source['asset']['checksum']['value'], 'source changed after preflight'
        if source['channel'] == 'elevation':
            audit['rasters'][source['id']] = raster(paths[source['id']], radius, source, source['id'] == terrain['base'])
        elif source['projection'] == 'Mars-EQC-0-0':
            audit['imagery'][source['id']] = raster(paths[source['id']], radius, source)
        else:
            audit['imagery'][source['id']] = bundle(paths[source['id']], inputs / f'{source["asset"]["checksum"]["value"]}.config.json',
                                                   Path(job['paths'][source['id']]).parent)
    fusion = out / 'fusion'
    if terrain_required:
        if terrain.get('fusionAsset'):
            manifest = Path(job['paths']['terrain:fusion'])
            receipt_bytes = manifest.read_bytes()
            pin = terrain['fusionAsset']
            assert len(receipt_bytes) == pin['bytes'] and hashlib.sha256(receipt_bytes).hexdigest() == pin['checksum']['value'], 'fusion manifest changed after preflight'
            (inputs / 'fusion-bundle.json').write_bytes(receipt_bytes)
            receipt = json.loads(receipt_bytes)
            assert receipt['version'] == 1 and receipt['kind'] == 'locked-fusion-bundle'
            assert receipt['baseSha256'] == next(s['asset']['checksum']['value'] for s in lock['sources'] if s['id'] == terrain['base']), 'fusion base differs from locked raster'
            assert receipt['detailSha256'] == next(s['asset']['checksum']['value'] for s in lock['sources'] if s['id'] == terrain['detail']), 'fusion detail differs from locked raster'
            assert set(receipt['files']) == {'fusion.json', 'residual.tif', 'coverage.tif', 'weight.tif', 'fused.tif'}, 'unsupported fusion dependency inventory'
            fusion.mkdir()
            for filename, entry in receipt['files'].items():
                assert Path(filename).name == filename, 'unsafe fusion filename'
                src = manifest.parent / entry['path']
                assert src.stat().st_size == entry['bytes'] and sha(src) == entry['sha256'], 'fusion input changed'
                shutil.copyfile(src, fusion / filename)
                assert sha(fusion / filename) == entry['sha256'], 'fusion changed during staging'
        else:
            command(sys.executable, ROOT / 'scripts/terrain/dem.py', 'fuse', '--base', paths[terrain['base']],
                    '--detail', paths[terrain['detail']], '--out', fusion, '--blend-m', terrain['blendM'],
                    '--fit-stride', terrain['fitStride'], '--bias', 'none', '--vertical-datum', 'reference-sphere radial metres' if transform == 'identity' else 'MOLA areoid topography metres; radial conversion is explicit at cube construction')
        f = json.loads((fusion / 'fusion.json').read_text())
    else:
        f = prior_terrain['fusion']
    audit['fusion'] = f
    assert abs(f['registration']['offsetM']) <= p['gates']['maxOffsetM'], 'registration offset exceeds locked gate'
    boundary = f['boundary']['fusedStepM']
    assert boundary.get('n', 0) == 0 or boundary['maxAbsM'] <= p['gates']['maxBoundaryStepM'], 'fused boundary step exceeds locked gate'
    assert f['registration']['removed'] is False, 'locked fusion must preserve the registration plane'
    assert f['taper']['blendM'] == terrain['blendM'] and f['registration']['fitStridePx'] == terrain['fitStride'], 'fusion settings differ from lock'
    # Existing fusion bytes are authoritative. Generated fixtures normalize only
    # their volatile provenance before computing immutable product revisions.
    if terrain_required and not terrain.get('fusionAsset'):
        f.pop('created', None)
        for role in ('base', 'detail'):
            f[role]['path'] = f'{role}.tif'
        write(fusion / 'fusion.json', f)
    for product in dag['products']:
        previous = job.get('reusedProducts', {}).get(product['id'])
        if previous:
            if product['kind'] == 'cube-terrain':
                audit['baselineSampling'] = previous['audit'].get('baselineSampling')
            else:
                sid = product['sourceIds'][0]
                if sid not in required_sources: audit['imagery'][sid] = previous['audit']['imagery'][sid]
            continue
        dest = out / product['id']
        tile = product['tiling']
        regions = [part for r in tile['regions'] for part in ['--region', r]]
        if product['kind'] == 'cube-terrain':
            command(sys.executable, ROOT / 'scripts/terrain/dem.py', 'cube-tile', '--base', paths[terrain['base']],
                    '--fusion', fusion, '--out', dest, '--ellipsoid', radius, radius if transform == 'identity' else 3376200,
                    '--source-convention', 'sphere-radial' if transform == 'identity' else 'areoid-radial', *areoid_args,
                    '--body', 'Mars', '--frame', 'IAU_MARS', '--global-level', tile['globalLevel'], '--workers', args.workers, *regions)
            command(sys.executable, ROOT / 'scripts/terrain/dem.py', 'cube-error', dest, '--workers', args.workers)
            from source_kernels import verify
            audit['baselineSampling'] = verify(paths[terrain['base']], dest / 'cpu-grids.json')
        else:
            source = next(s for s in lock['sources'] if s['id'] == product['sourceIds'][0])
            is_raster = source['projection'] == 'Mars-EQC-0-0'
            config = paths[source['id']] if is_raster else inputs / f'{source["asset"]["checksum"]["value"]}.config.json'
            if is_raster:
                config = inputs / f'{source["asset"]["checksum"]["value"]}.filtered.tif'
                filtering = prepare_imagery(paths[source['id']], config)
                audit['imagery'][source['id']]['filtering'] = filtering
            command(sys.executable, ROOT / 'scripts/terrain/cube_imagery.py', 'raster' if is_raster else 'xyz', '--source', config,
                    '--out', dest, '--body', 'Mars', '--frame', 'IAU_MARS', '--radius-km', radius / 1000,
                    '--global-level', tile['globalLevel'], '--tile-size', lock['output']['tileSize'],
                    '--gutter', lock['output']['gutter'], '--supersample', 4 if is_raster else 1, '--workers', args.workers, *regions)
            if is_raster:
                manifest_path = dest / 'imagery.json'
                manifest = json.loads(manifest_path.read_text())
                manifest['filtering'] = filtering
                write(manifest_path, manifest)
                descriptor = inputs / f'{source["asset"]["checksum"]["value"]}.descriptor.json'
                write(descriptor, source)
                requests = []
                for selection in lock['selections']:
                    if selection['channel'] != 'imagery' or source['id'] not in selection['sourceIds']: continue
                    region = next(r for r in lock['desired']['regions'] if r['id'] == selection['regionId'])
                    layer = next(l for l in lock['desired']['layers'] if l['id'] == region['feature']['layerId'])
                    feature = next(f for f in layer['geojson']['features'] if ('number:' if isinstance(f['id'], (int,float)) else 'string:') + str(f['id']) == region['feature']['featureId'])
                    requests.append({'outputGsdM': selection['outputGsdM'], 'geometry': {'type':'FeatureCollection','features':[feature]}})
                requests_file = inputs / f'{source["id"]}-requests.json'
                write(requests_file, requests)
                check = out / f'{source["id"]}-registration.json'
                command(sys.executable, ROOT / 'scripts/surface-build/validate_imagery.py', '--source', paths[source['id']],
                        '--descriptor', descriptor, '--manifest', dest / 'imagery.json', '--out', check, '--requests', requests_file)
                audit['imagery'][source['id']]['sourceToOutputRegistration'] = json.loads(check.read_text())
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
            if is_raster: meta['filtering'] = filtering
        meta['provenance'] = {
            'version':1, 'productionReady':False, 'productIdentity':product['productIdentity'],
            'sources':[{key:s[key] for key in ('id','productId','asset','license','nativeGsdM','accuracyM','coordinates','projection','datum','nodata')}
                       | {key:s.get('metadata',{}).get(key) for key in ('validData','registration','illumination','unknowns')} for s in lock['sources'] if s['id'] in product['sourceIds']],
            'transform':transform if product['kind']=='cube-terrain' else 'identity',
            'caveats':p['caveats'],
        }
        if product['kind']=='cube-imagery':
            proof=audit['imagery'][source['id']]
            meta['coverage']={
                'nativeValidSubset':proof.get('nativeValidSubset'),
                'continuousRequestedCoverage':proof.get('sourceToOutputRegistration',{}).get('continuousRequestedCoverage'),
                'availabilityMeaning':'Emitted tiles only; alpha/nodata apply inside tiles. Native continuous coverage is limited to the explicit proof, when present.',
            }
            meta['source']['id']=source['productId']
            meta['source']['attribution']=source['license'].get('attribution',source['license']['name'])
        write(meta_path, meta)
    # Cross-product grid gates also apply when either product was reused.
    for product in dag['products']:
        if product['kind'] != 'cube-imagery': continue
        source = next(s for s in lock['sources'] if s['id'] == product['sourceIds'][0])
        if source['projection'] != 'Mars-EQC-0-0': continue
        from osgeo import osr
        detail_grid = audit['rasters'][terrain['detail']]
        image_grid = audit['imagery'][source['id']]
        detail_srs, image_srs = osr.SpatialReference(), osr.SpatialReference()
        detail_srs.ImportFromWkt(detail_grid['crsWkt'])
        image_srs.ImportFromWkt(image_grid['crsWkt'])
        assert detail_srs.IsSame(image_srs), 'DTM and ortho map projections differ'
        dgt, igt = detail_grid['nativeGrid'], image_grid['nativeGrid']
        ratio = dgt[1]/igt[1]
        phase = [(igt[0]-dgt[0])/igt[1], (igt[3]-dgt[3])/igt[5]]
        phase_error = max(abs(p-round(p))*abs(igt[1]) for p in phase)
        assert ratio>=1 and abs(ratio-round(ratio))<1e-8 and phase_error<1e-6, 'DTM/ortho native grid alignment exceeds gate'
        audit['imagery'][source['id']]['dtmGridAlignment'] = {'nativePixelRatio':ratio,'originOffsetsInImagePixels':phase,
            'maximumGridPhaseErrorM':phase_error,'absoluteGeolocationErrorM':None,
            'note':'Checks preservation of the supplied controlled source grids, not independent absolute image/DTM registration.'}
    audit['workerPeakRssBytes'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1024 if sys.platform != 'darwin' else 1)
    audit['largestChildPeakRssBytes'] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * (1024 if sys.platform != 'darwin' else 1)
    audit['sampledResources'] = sampler.finish()
    audit['peakConcurrentRssBytes'] = audit['sampledResources']['peakConcurrentRssBytes']
    write(out / 'source-audit.json', audit)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--job', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--workers', type=int, default=1)
    args = p.parse_args()
    assert 1 <= args.workers <= 8
    build(args)
