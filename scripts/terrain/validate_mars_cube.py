#!/usr/bin/env python3
"""Source/registration audit for a bounded Mars cube product; no re-fitting.

Compare emitted vertices against the original #50 field + official areoid,
and measure triangles at MMGIS source-coordinate controls and blend samples.
The JS cube validator separately exercises the viewer's physical CPU queries.
"""
import argparse
import json
import math
from pathlib import Path

import numpy as np
from osgeo import gdal
import dem


def stats(v):
    a = np.asarray(v, np.float64)
    return {'n': len(a), 'rmsM': float(np.sqrt(np.mean(a * a))),
            'p95AbsM': float(np.percentile(np.abs(a), 95)), 'maxAbsM': float(np.abs(a).max())} if len(a) else {'n': 0}


def run(args):
    root, fusion = Path(args.dir), Path(args.fusion)
    manifest = json.loads((root / 'cpu-grids.json').read_text())
    meta = json.loads((fusion / 'fusion.json').read_text())
    assert manifest['datum'] == {'referenceShape': {'kind': 'ellipsoid', 'radiiKm': [3396.19, 3396.19, 3376.2]},
                                 'verticalDatum': 'ellipsoid', 'heightConvention': 'geodetic-normal'}
    assert manifest['source']['fusion']['sha256'] == dem.file_sha256(fusion / 'fusion.json')
    assert not meta['registration']['removed'], 'this audit expects the existing #50 --bias none field'
    a = manifest['geometry']['referenceRadiusKm'] * 1000
    spacing = [math.degrees(2 / ((dem.GRID - 1) * 2 ** L)) for L in range(manifest['maxLevel'] + 1)]
    dem.load_field(args.base, args.fusion, spacing + [1e-9])
    ads = gdal.Open(args.areoid)
    band = ads.GetRasterBand(1)
    areoid = band.ReadAsArray()
    # This audit deliberately pins the exact official MEG016 label/grid rather
    # than deriving angular coordinates from its rounded 3.705 km map scale.
    assert (ads.RasterXSize, ads.RasterYSize) == (5760, 2880)
    assert band.GetOffset() == 3396000 and band.GetScale() == 1
    assert 'AREOID_RADIUS' in Path(args.areoid).read_text()
    for name, path in [('base', Path(args.base)), ('residual', fusion / 'residual.tif'), ('areoid', Path(args.areoid))]:
        assert manifest['source']['build']['inputs'][name]['sha256'] == dem.file_sha256(path), f'{name} changed'
    for entry in manifest['source']['build']['inputs']['areoidFiles']:
        assert entry['sha256'] == dem.file_sha256(Path(args.areoid).parent / entry['file'])

    def radius(lon, lat):
        return dem.bilinear(areoid, (0, 1 / 16, 0, 90, 0, -1 / 16), lon, lat, wrap_lon=True) + 3396000

    vertices = []
    keys = {tuple(t[:4]) for t in manifest['tiles']}
    for face, L, x, y in keys:
        h = np.fromfile(root / 'heights' / face / str(L) / str(x) / f'{y}.f32', '<f4')
        ij = np.array([[0, 0], [32, 32], [64, 64], [0, 64], [64, 0]], np.float64)
        d = dem.cube_lattice_rays(face, L, x, y, ij)
        lon, lat = dem.direction_lonlat(d)
        expected = dem.field_heights(lon, lat, spacing[L]) + radius(lon, lat) - a
        vertices.extend(h[(ij[:, 1] * dem.GRID + ij[:, 0]).astype(int)] - expected)
    assert max(np.abs(vertices)) < 0.002, 'radial conversion changed the fused field'

    controls = json.loads(Path(args.controls).read_text())['features']
    points = [{'id': f"flight-{p['Flight']}", 'lat': p['Lat'], 'lon': p['Lon'], 'expectedAreoidM': p['Elev_Geoid']}
              for p in (f['properties'] for f in controls)]
    # Sample the stored blend weight at coarse coverage positions, then score
    # the original field and emitted geometry there at full precision.
    wds = gdal.Open(str(fusion / 'weight.tif'))
    grid = dem.Grid(wds)
    w = wds.ReadAsArray(buf_xsize=160, buf_ysize=160)
    for label, mask in [('outside', w == 0), ('blend', (w > 0) & (w < 1)), ('interior', w == 1)]:
        indices = np.argwhere(mask)
        for j, i in indices[::max(1, len(indices) // 12)][:12]:
            gx = grid.gt[0] + (i + 0.5) * grid.size[0] / 160 * grid.gt[1]
            gy = grid.gt[3] + (j + 0.5) * grid.size[1] / 160 * grid.gt[5]
            lon, lat = grid.unproject(gx, gy)
            points.append({'id': label, 'lat': float(lat), 'lon': float(lon)})
    rows = []
    cache = {}
    for cp in points:
        lon, lat = np.array([cp['lon']]), np.array([cp['lat']])
        h = dem.field_heights(lon, lat, 1e-9)[0]
        r0 = radius(lon, lat)[0]
        la, lo = math.radians(cp['lat']), math.radians(cp['lon'])
        d = np.array([math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)])
        key = next(k for L in range(manifest['maxLevel'], -1, -1) if (k := dem.cube_tile_at(d, L)) in keys)
        if key not in cache:
            face, L, x, y = key
            P, tri, extras = dem.read_glb_mesh(root / face / str(L) / str(x) / f'{y}.glb')
            cache[key] = (P, tri[:extras['surfaceTriangles']])
        P, tri = cache[key]
        A, B, C = (P[tri[:, i]] for i in range(3))
        e1, e2 = B - A, C - A
        pv = np.cross(d, e2)
        det = (e1 * pv).sum(1)
        u = (-A * pv).sum(1) / det
        q = np.cross(-A, e1)
        v = q @ d / det
        t = (e2 * q).sum(1) / det
        hits = t[(u >= -1e-10) & (v >= -1e-10) & (u + v <= 1 + 1e-10) & (t > 0)]
        assert len(hits), f'no emitted triangle at {cp}'
        row = {**cp, 'fieldAreoidM': h, 'areoidRadiusM': r0, 'tile': '/'.join(map(str, key)),
               'triangleMinusFinestFieldM': float(hits.min() - r0 - h)}
        if 'expectedAreoidM' in cp:
            row['fieldMinusControlM'] = h - cp['expectedAreoidM']
        rows.append(row)
    report = {'revision': manifest['source']['version'], 'registration': meta['registration'],
              'sourceControlNote': 'MMGIS lon/lat numbers sampled in the USGS source map convention (planetocentric); this is not a certification of existing trajectory Cartesian placement',
              'areoidModelNote': 'MEG016 GMM3 mgm1025 degree/order 50; integer-metre grid, bilinear interpolation; datum/model/source uncertainty remains unbounded here',
              'vertexConversionM': stats(vertices), 'sourceControlsM': stats([r['fieldMinusControlM'] for r in rows if 'fieldMinusControlM' in r]),
              'triangleMinusFinestFieldM': {label: stats([r['triangleMinusFinestFieldM'] for r in rows if (r['id'].startswith('flight-') if label == 'controls' else r['id'] == label)])
                                           for label in ('controls', 'outside', 'blend', 'interior')}, 'rows': rows}
    Path(args.out).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k not in ('rows', 'registration')}, indent=2))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for key in ('dir', 'base', 'fusion', 'areoid', 'out'):
        p.add_argument('--' + key, required=True)
    p.add_argument('--controls', default='apps/viewer/test-catalogs/data/ingenuity/m20_heli_waypoints.json')
    run(p.parse_args())
