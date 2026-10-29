#!/usr/bin/env python3
"""Reproduce the #247 source decision gate; never fit terrain or rover states.

Inputs are the original pinned NASA sample scene/tileset, PLACES CSVs, a native
Gale DEM window, and the unchanged audit-msl-spice.mjs export. PLACES camera
controls are correlated operational evidence, not independent absolute truth.
"""
import argparse
import csv
import json
import math
import re
import struct
from pathlib import Path
import numpy as np
from osgeo import gdal
from audit_ingenuity import areoid_radius, pin, radial_xyz, sample_raster

gdal.UseExceptions()


def rows(path):
    return list(csv.DictReader(Path(path).open()))


def root_triangles(path):
    """Read this sample's untransformed, uncompressed single GLB primitive.
    Fail on schema changes rather than silently ignoring a geometry transform.
    """
    data = path.read_bytes()
    magic, version, size, *lengths = struct.unpack_from('<4s6I', data)
    assert magic == b'b3dm' and version == 1 and size == len(data)
    glb = data[28+sum(lengths):]
    assert glb[:4] == b'glTF' and struct.unpack_from('<I', glb, 4)[0] == 2
    length = struct.unpack_from('<I', glb, 12)[0]
    doc = json.loads(glb[20:20+length])
    assert doc['nodes'] == [{'mesh': 0}], 'Unexpected source node transform'
    binary = glb[28+length:]
    primitive = doc['meshes'][0]['primitives'][0]
    assert primitive['mode'] == 4

    def accessor(index, width):
        a = doc['accessors'][index]
        view = doc['bufferViews'][a['bufferView']]
        assert 'byteStride' not in view and 'sparse' not in a
        dtype = {5126: '<f4', 5123: '<u2', 5125: '<u4'}[a['componentType']]
        return np.frombuffer(binary, dtype=dtype, count=a['count']*width,
                             offset=view.get('byteOffset', 0)+a.get('byteOffset', 0)).reshape(-1, width)
    vertices = accessor(primitive['attributes']['POSITION'], 3).astype(float)
    indices = accessor(primitive['indices'], 1).reshape(-1)
    return vertices[indices].reshape(-1, 3, 3)


def down_intersection(triangles, north, east):
    a, b, c = triangles[:, 0], triangles[:, 1], triangles[:, 2]
    u, v = b-a, c-a
    den = u[:, 0]*v[:, 1]-u[:, 1]*v[:, 0]
    valid = np.abs(den) > 1e-12
    den = np.where(valid, den, 1)
    x, y = north-a[:, 0], east-a[:, 1]
    t = (x*v[:, 1]-y*v[:, 0])/den
    s = (u[:, 0]*y-u[:, 1]*x)/den
    valid &= (t >= -1e-9) & (s >= -1e-9) & (t+s <= 1+1e-9)
    heights = (a[:, 2]+t*u[:, 2]+s*v[:, 2])[valid]
    return float(heights.min()) if len(heights) else None


def audit(inputs, areoid, base, spice, control_snapshot=None):
    scene = json.loads((inputs / 'dingo-scene.json').read_text())
    tiles = json.loads((inputs / 'dingo-tileset.json').read_text())
    snapshot = json.loads(control_snapshot.read_text()) if control_snapshot else None
    localized = snapshot['sources']['localized_interp'] if snapshot else rows(inputs / 'localized_interp.csv')
    controls = {int(r['drive']): r for r in localized if r['site'] == '26' and r['frame'] == 'ROVER'}
    anchor = controls[184]
    assert scene['tilesets'][0]['frame_id'] == 'sitedrive_0260184'
    assert tiles['root']['transform'] == np.eye(4).flatten().tolist()
    nodes = []

    def walk(node):
        nodes.append(node)
        for child in node.get('children', []):
            walk(child)
    walk(tiles['root'])
    assert sum('transform' in n for n in nodes) == 1
    poses = {}
    for frame in scene['frames']:
        match = re.search(r'_00026(\d{5})', frame['id'])
        if match:
            assert frame['parent_id'] == 'sitedrive_0260184'
            poses.setdefault(int(match[1]), []).append(frame)
    residuals = []
    for drive, frames in sorted(poses.items()):
        assert drive in controls, f'No PLACES control for drive {drive}'
        row = controls[drive]
        expected = np.array([float(row[k]) - float(anchor[k]) for k in ['landing_x', 'landing_y', 'landing_z']])
        actual = np.array([[f['translation'][k] for k in ['x', 'y', 'z']] for f in frames])
        assert np.max(np.abs(actual - actual[0])) < 1e-9, 'Frame origins disagree within a site/drive'
        delta = actual[0] - expected
        residuals.append(dict(site=26, drive=drive, sol=int(row['sol']), cameras=len(frames),
                              role='origin' if drive == 184 else 'held-out-relative-check',
                              sampleTranslationNedM=actual[0].tolist(), placesTranslationNedM=expected.tolist(),
                              residualNedM=delta.tolist(), normM=float(np.linalg.norm(delta))))
    lat, lon = float(anchor['planetocentric_latitude']), float(anchor['longitude'])
    radius = float(areoid_radius(areoid, np.array([lon]), np.array([lat]))[0])
    xyz = radial_xyz(np.array([lon]), np.array([lat]), np.array([radius + float(anchor['elevation'])]))[0]
    phi, lam = math.radians(lat), math.radians(lon)
    north = np.array([-math.sin(phi)*math.cos(lam), -math.sin(phi)*math.sin(lam), math.cos(phi)])
    east = np.array([-math.sin(lam), math.cos(lam), 0])
    down = -xyz / np.linalg.norm(xyz)
    matrix = np.eye(4)
    matrix[:3, :3] = np.stack([north, east, down], axis=1) / 1000
    matrix[:3, 3] = xyz / 1000
    dem = inputs / 'gale-dingo-dem-window.tif'
    source = gdal.Open(str(dem))
    values = source.GetRasterBand(1).ReadAsArray()
    mask = source.GetRasterBand(1).GetMaskBand().ReadAsArray() != 0
    assert mask.all() and np.isfinite(values).all(), 'Native crop contains invalid data'
    dem_height = float(sample_raster(dem, np.array([lon]), np.array([lat]), cubic=True)[0])
    base_height = float(sample_raster(base, np.array([lon]), np.array([lat]), cubic=True)[0])
    spice_rows = []
    for row in json.loads(spice.read_text())['rows']:
        p = np.array([row['positionKm'][k] for k in ['x', 'y', 'z']]) * 1000
        local = np.stack([north, east, down]) @ (p - xyz)
        spice_rows.append(dict(utc=row['utc'], positionBodyFixedM=p.tolist(),
                               relativeToMeshOriginNedM=local.tolist(),
                               distanceFromMeshOriginM=float(np.linalg.norm(local)),
                               radialDifferenceFromOriginM=float(np.linalg.norm(p) - np.linalg.norm(xyz))))
    triangles = root_triangles(inputs / 'dingo-root.b3dm')
    physical_sites = []
    sites = [('origin', 0, 0), ('north-50m', 50, 0), ('east-50m', 0, 50)]
    sites += [(r['utc'], *r['relativeToMeshOriginNedM'][:2]) for r in spice_rows]
    for name, n, e in sites:
        down_m = down_intersection(triangles, n, e)
        if down_m is None:
            physical_sites.append(dict(name=name, localNorthEastM=[n, e], coverage='unavailable'))
            continue
        point = xyz + north*n + east*e + down*down_m
        r = float(np.linalg.norm(point))
        lo, la = math.degrees(math.atan2(point[1], point[0])), math.degrees(math.asin(point[2]/r))
        expected = float(areoid_radius(areoid, np.array([lo]), np.array([la]))[0])
        dem_m = float(sample_raster(dem, np.array([lo]), np.array([la]), cubic=True)[0])
        base_m = float(sample_raster(base, np.array([lo]), np.array([la]), cubic=True)[0])
        physical_sites.append(dict(name=name, localNorthEastM=[n, e], coverage='root-triangle',
                                   meshDownM=down_m, meshRadiusM=r, demRadiusM=expected+dem_m,
                                   baseRadiusM=expected+base_m, meshMinusDemM=r-expected-dem_m,
                                   meshMinusBaseM=r-expected-base_m))
    held_out = [r['normM'] for r in residuals if r['drive'] != 184]
    used = [inputs/'dingo-scene.json', inputs/'dingo-tileset.json', inputs/'dingo-root.b3dm', dem,
            areoid, areoid.with_suffix('.IMG'), base, spice]
    used += [control_snapshot] if snapshot else [inputs/(n+'.csv') for n in ['localized_interp', 'localized_pos', 'telemetry']]
    return dict(version=1, kind='curiosity-registration-source-gate', productionReady=False,
                inputs={p.name: pin(p) for p in used},
                controlProvenance=snapshot['primaryInputs'] if snapshot else None,
                sample=dict(revision='76444abbb4faff1b05f46a09b81ca2c24602b333',
                            frame='sitedrive_0260184', axes='north/east/down', units='metres',
                            rootTransform='identity', otherTransforms=0, tiles=len(nodes),
                            boundingBox=tiles['root']['boundingVolume']['box']),
                registration=dict(version='places-26-184-meg016-estimate-v1', bodyFixedFrame='IAU_MARS',
                                  bodyFixedKmFromLocalMeters=matrix.flatten(order='F').tolist(),
                                  status='estimated', uncertaintyKm=None,
                                  provenance='docs/validation/curiosity-gale/source-registration.md'),
                anchor=dict(row=anchor, areoidRadiusM=radius, bodyFixedM=xyz.tolist(),
                            convention='planetocentric radial; MEG016 radius + unchanged PLACES areoid elevation'),
                relativeControls=dict(rows=residuals, heldOutCount=len(held_out),
                                      maxM=max(held_out), rmsM=float(np.sqrt(np.mean(np.square(held_out)))),
                                      absoluteAccuracyM=None, independentLandmarks=0),
                terrain=dict(windowSize=[source.RasterXSize, source.RasterYSize],
                             geoTransform=source.GetGeoTransform(), allPixelsValid=True,
                             gridSpacingM=1, nativeSourceAtDingoGap='unknown; mixed DEM has no per-pixel source index',
                             anchorDemAreoidM=dem_height, anchorPlacesAreoidM=float(anchor['elevation']),
                             anchorBaseAreoidM=base_height, baseMinusDemM=base_height-dem_height),
                spice=spice_rows,
                physicalSites=physical_sites,
                policy=dict(physicalQueryPolicy='visual-only', overlapPolicy='composite',
                            picking='global heightfield', clearance='global heightfield',
                            measurement='global heightfield', fallback='global heightfield remains active'),
                limits=['Camera controls share PLACES/rover provenance and are not independent geodetic controls.',
                        'No adjustment of source geometry, terrain, SPICE positions or attitudes was fitted.',
                        'Source scene omits its absolute PLACES solution/version; the transform is an estimate.',
                        'A spherical radial tangent basis approximates local gravity; absolute orientation uncertainty is unknown.',
                        'SPICE positions differ from orbital localization. Relative origin differences are not terrain clearances.',
                        'Native 1m source-grid validity does not establish native HiRISE stereo data or physical accuracy.',
                        'Physical mesh comparisons use the coarse root, whose geometricError is 4.192m; fine LOD residuals remain unvalidated.',
                        'Gale inventory DTEEC_016520_1750_016375_1750_A01 at 138.43-138.57E does not cover this site.',
                        'Hosted cube/imagery, physical-site residuals and visual acceptance remain required.'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ['inputs', 'areoid', 'base', 'spice', 'out']:
        parser.add_argument('--'+key, type=Path, required=True)
    parser.add_argument('--control-snapshot', type=Path)
    args = parser.parse_args()
    report = audit(args.inputs, args.areoid, args.base, args.spice, args.control_snapshot)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps({k: report[k] for k in ['sample', 'relativeControls', 'terrain', 'spice']}, indent=2))
