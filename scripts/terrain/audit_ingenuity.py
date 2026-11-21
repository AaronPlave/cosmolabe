#!/usr/bin/env python3
"""Read-only #246 source/datum audit. Never writes trajectories or a catalog.

Requires an independently rebuilt fusion. The historical fusion is comparison
evidence only. Cartesian alternatives are explicitly conditional on the MMGIS
coordinate/datum interpretation; scalar agreement is not absolute accuracy.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from osgeo import gdal

gdal.UseExceptions()


def pin(path):
    path = Path(path)
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b''):
            h.update(chunk)
    return {'file': path.name, 'bytes': path.stat().st_size, 'sha256': h.hexdigest()}


def stats(values):
    a = np.asarray(values, dtype=np.float64)
    if not a.size:
        return {'n': 0}
    if not np.isfinite(a).all():
        raise ValueError('nonfinite audit observations')
    return {'n': int(a.size), 'meanM': float(a.mean()),
            'rmsM': float(np.sqrt(np.mean(a * a))),
            'p95AbsM': float(np.percentile(np.abs(a), 95)),
            'maxAbsM': float(np.abs(a).max())}


def geographic_transform(ds):
    gt = ds.GetGeoTransform()
    srs = ds.GetSpatialRef()
    if srs.IsGeographic():
        return gt
    proj = srs.ExportToProj4()
    if not all(s in proj for s in ['+proj=eqc', '+lat_ts=0', '+lon_0=0']):
        raise ValueError(f'Unsupported source projection: {proj}')
    k = 180 / (math.pi * srs.GetSemiMajor())
    return tuple(v * k for v in gt)


def sample_raster(path, lon, lat, cubic=False):
    """Independent local-window pixel-centre interpolation, no overview reuse.

    Fail on invalid kernel support; do not interpolate through unknown nodata.
    Only used inside the mission footprint, never as a global fallback sampler.
    """
    ds = gdal.Open(str(path))
    gt = geographic_transform(ds)
    if gt[2] or gt[4]:
        raise ValueError('rotated source grids require a separate audit')
    x = (np.asarray(lon) - gt[0]) / gt[1] - .5
    y = (np.asarray(lat) - gt[3]) / gt[5] - .5
    ix, iy = np.floor(x).astype(int), np.floor(y).astype(int)
    offsets = [-1, 0, 1, 2] if cubic else [0, 1]
    x0, y0 = int(ix.min()) + offsets[0], int(iy.min()) + offsets[0]
    x1, y1 = int(ix.max()) + offsets[-1] + 1, int(iy.max()) + offsets[-1] + 1
    if x0 < 0 or y0 < 0 or x1 > ds.RasterXSize or y1 > ds.RasterYSize:
        raise ValueError(f'{path}: incomplete source support')
    band = ds.GetRasterBand(1)
    data = band.ReadAsArray(x0, y0, x1-x0, y1-y0)
    valid = band.GetMaskBand().ReadAsArray(x0, y0, x1-x0, y1-y0) != 0
    u, v = x - ix, y - iy

    def weights(t):
        return [-.5*t + t*t - .5*t**3, 1-2.5*t*t+1.5*t**3,
                .5*t+2*t*t-1.5*t**3, -.5*t*t+.5*t**3] if cubic else [1-t, t]

    result = np.zeros_like(x, dtype=float)
    for dy, wy in zip(offsets, weights(v)):
        for dx, wx in zip(offsets, weights(u)):
            a, b = iy + dy - y0, ix + dx - x0
            value = data[a, b]
            if not (valid[a, b] & np.isfinite(value) & (np.abs(value) < 1e5)).all():
                raise ValueError(f'{path}: invalid interpolation support')
            result += value * wx * wy
    return result * (band.GetScale() or 1) + (band.GetOffset() or 0)


def areoid_radius(label, lon, lat):
    """Decode the official pinned MEG016 bytes independently of dem.py/GDAL."""
    label = Path(label)
    if pin(label)['sha256'] != '83b4df3255dade92ab64c7261a3ce54728675e0f1e9c023b56e5facae9ec41ef':
        raise ValueError('Expected official MEG016 label')
    image = label.with_suffix('.IMG')
    if pin(image)['sha256'] != 'e80333b01489e66ebf20ac83ec7e130bd5a03f0c3f98f8f7b8d5c054cd6ad239':
        raise ValueError('Expected official MEG016 image')
    data = np.fromfile(image, '>i2').reshape(2880, 5760)
    x = (np.asarray(lon) % 360) * 16 - .5
    y = np.clip((90 - np.asarray(lat)) * 16 - .5, 0, 2879)
    i, j = np.floor(x).astype(int), np.floor(y).astype(int)
    u, v = x-i, y-j
    return (3396000 + (1-v)*((1-u)*data[j, i % 5760] + u*data[j, (i+1) % 5760])
            + v*((1-u)*data[np.minimum(j+1, 2879), i % 5760]
                 + u*data[np.minimum(j+1, 2879), (i+1) % 5760]))


def radial_xyz(lon, lat, radius):
    lon, lat = np.radians(lon), np.radians(lat)
    return np.stack([radius*np.cos(lat)*np.cos(lon), radius*np.cos(lat)*np.sin(lon),
                     radius*np.sin(lat)], axis=-1)


def legacy_xyz(lon, lat, height):
    lon, lat = np.radians(lon), np.radians(lat)
    e2 = 1 - (3376200 / 3396190)**2
    n = 3396190 / np.sqrt(1 - e2*np.sin(lat)**2)
    return np.stack([(n+height)*np.cos(lat)*np.cos(lon),
                     (n+height)*np.cos(lat)*np.sin(lon),
                     (n*(1-e2)+height)*np.sin(lat)], axis=-1)


def compare_rasters(old, new):
    a, b = gdal.Open(str(old)), gdal.Open(str(new))
    if (a.RasterXSize, a.RasterYSize, a.GetGeoTransform(), a.GetProjection()) != (
            b.RasterXSize, b.RasterYSize, b.GetGeoTransform(), b.GetProjection()):
        raise ValueError('fusion comparison grids differ')
    changed, maximum, cells = 0, 0., 0
    for row in range(0, a.RasterYSize, 256):
        n = min(256, a.RasterYSize-row)
        av = a.ReadAsArray(0, row, a.RasterXSize, n)
        bv = b.ReadAsArray(0, row, b.RasterXSize, n)
        if not np.isfinite(av).all() or not np.isfinite(bv).all():
            raise ValueError('nonfinite fusion output')
        changed += int(np.count_nonzero(av != bv))
        maximum = max(maximum, float(np.abs(av.astype(float)-bv).max()))
        cells += av.size
    return {'cells': cells, 'changedCells': changed, 'maximumDifference': maximum,
            'old': pin(old), 'clean': pin(new)}


def run(args):
    src, fresh, old = Path(args.source), Path(args.fusion), Path(args.old_fusion)
    base = src / 'Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif'
    detail = src / 'JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif'
    data = Path(args.flights)
    waypoint_file, path_file = data/'m20_heli_waypoints.json', data/'m20_heli_flight_path.json'
    wps = json.loads(waypoint_file.read_text())['features']
    paths = json.loads(path_file.read_text())['features']
    by_flight = {f['properties']['Flight']: f['properties'] for f in wps}
    if len(wps) != 73 or set(by_flight) != set(range(73)):
        raise ValueError('Expected all 73 MMGIS controls including deployment')
    metadata = json.loads((fresh/'fusion.json').read_text())
    if metadata['registration']['removed'] or metadata['taper']['blendM'] != 1000:
        raise ValueError('Audit requires the unchanged bias and 1 km taper')
    comparison = {name: compare_rasters(old/name, fresh/name)
                  for name in ['residual.tif', 'weight.tif', 'coverage.tif', 'fused.tif']}
    lon, lat = np.array([[by_flight[i]['Lon'], by_flight[i]['Lat']] for i in range(73)]).T
    elevation = np.array([by_flight[i]['Elev_Geoid'] for i in range(73)])
    field = sample_raster(base, lon, lat, True) + sample_raster(fresh/'residual.tif', lon, lat)
    dtm = sample_raster(detail, lon, lat)
    radii = areoid_radius(args.areoid, lon, lat)
    candidate = radial_xyz(lon, lat, radii+elevation)
    legacy = legacy_xyz(lon, lat, elevation)
    displacement = np.linalg.norm(candidate-legacy, axis=1)
    la = np.radians(lat)
    ellipsoid_ray_radius = 1/np.sqrt((np.cos(la)/3396190)**2+(np.sin(la)/3376200)**2)
    legacy_centric_lat = np.degrees(np.arctan2(legacy[:,2], np.hypot(legacy[:,0],legacy[:,1])))
    radial_unit = radial_xyz(lon, lat, np.ones(73))
    delta = candidate-legacy
    along_radial = np.sum(delta*radial_unit, axis=1)
    tangent = np.linalg.norm(delta-along_radial[:,None]*radial_unit, axis=1)
    config = json.loads(Path(args.mmgis_config).read_text())
    if config['msv']['mission'] != 'M20' or any(float(config['msv']['radius'][key]) != 3396190 for key in ['major', 'minor']):
        raise ValueError('Original MMGIS mission reference sphere changed')
    layer_urls = {layer.get('url') for layer in config['layers']}
    for name in ['m20_heli_waypoints.json', 'm20_heli_flight_path.json']:
        if 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/'+name not in layer_urls:
            raise ValueError('Original MMGIS configuration no longer binds the audited observations')
    k = 3396190*math.pi/180
    east = np.array([by_flight[i]['Easting'] for i in range(73)])
    north = np.array([by_flight[i]['Northing'] for i in range(73)])
    lx = lon*k
    east_factor = float(lx@east/(lx@lx))
    map_evidence = {'configuration': pin(args.mmgis_config), 'referenceSphereRadiusM': 3396190,
                    'inferredStandardParallelDeg': math.degrees(math.acos(east_factor)),
                    'projectedEastingResidualM': stats(east-lx*east_factor),
                    'projectedNorthingResidualM': stats(north-lat*k),
                    'interpretation': 'The original map uses a sphere; the 73 projected coordinates reproduce spherical EQC at standard parallel 18.4663 degrees. This corroborates source-map coordinates, not an independent SF3-to-IAU_MARS transform.'}
    rows = [{'flight': i, 'lon': lon[i], 'lat': lat[i], 'observedAreoidM': elevation[i],
             'fieldMinusObservationM': field[i]-elevation[i], 'dtmMinusObservationM': dtm[i]-elevation[i],
             'areoidRadiusM': radii[i], 'conditionalRadialBodyFixedM': candidate[i].tolist(),
             'legacyToConditionalDisplacementM': displacement[i]} for i in range(73)]
    flight_rows, all_shifts, all_clearances = [], [], []
    for i in range(1, 73):
        wp, prev = by_flight[i], by_flight[i-1]
        matches = [f for f in paths if abs(f['properties']['SCLK_END']-wp['SCLK_START']) < 1]
        if len(matches) != 1:
            raise ValueError(f'Flight {i}: missing or ambiguous time match')
        f = matches[0]
        coord = np.array(f['geometry']['coordinates'])
        lo, la = coord[:, 0], coord[:, 1]
        start, end = f['properties']['SCLK_START'], f['properties']['SCLK_END']
        duration = end-start
        if duration <= 0 or len(coord) < 2:
            raise ValueError(f'Flight {i}: invalid path timing or samples')
        t = np.linspace(0, duration, len(coord))
        climb = min(5, .3*duration)
        alt = wp['Max_Alt_m'] * np.clip(np.minimum(t/climb, (duration-t)/climb), 0, 1)
        height = prev['Elev_Geoid'] + (wp['Elev_Geoid']-prev['Elev_Geoid'])*t/duration + alt
        r = areoid_radius(args.areoid, lo, la)
        new_xyz, old_xyz = radial_xyz(lo, la, r+height), legacy_xyz(lo, la, height)
        shift = np.linalg.norm(new_xyz-old_xyz, axis=1)
        terrain = sample_raster(base, lo, la, True) + sample_raster(fresh/'residual.tif', lo, la)
        clearance = height-terrain
        actual = np.loadtxt(data/f'flight_{i:02}.xyzv')
        if actual.shape != (len(coord), 7):
            raise ValueError(f'Flight {i}: unexpected derived samples')
        flight_rows.append({'flight': i, 'sourcePathLabel': f['properties']['Flight'], 'samples': len(coord),
                            'sourceStart': start, 'sourceEnd': end, 'sourceDurationS': duration,
                            'waypointDurationS': wp['Duration_s'],
                            'legacyFileMinusReconstructionM': stats(np.linalg.norm(actual[:, 1:4]*1000-old_xyz, axis=1)),
                            'legacyToConditionalDisplacementM': stats(shift),
                            'conditionalRadialClearanceM': {'min': float(clearance.min()), 'max': float(clearance.max()),
                                'negativeSamples': int((clearance < 0).sum()),
                                'negativeBelowMinus1M': int((clearance < -1).sum())},
                            'takeoffTrackMinusControlM': float(np.linalg.norm(new_xyz[0]-candidate[i-1])),
                            'landingTrackMinusControlM': float(np.linalg.norm(new_xyz[-1]-candidate[i]))})
        all_shifts.extend(shift)
        all_clearances.extend(clearance)
    report = {'schemaVersion': 1, 'productionReady': False, 'trajectoriesRegenerated': False,
              'inputs': {k: pin(p) for k, p in [('base', base), ('detail', detail), ('waypoints', waypoint_file),
                  ('paths', path_file), ('areoidLabel', args.areoid), ('areoidImage', Path(args.areoid).with_suffix('.IMG'))]},
              'cleanFusion': {'metadata': pin(fresh/'fusion.json'), 'registration': metadata['registration'],
                              'comparisonToHistorical': comparison},
              'mmgisMapEvidence': map_evidence,
              'controls': {'count': 73, 'fieldMinusObservationM': stats(field-elevation),
                           'dtmMinusObservationM': stats(dtm-elevation),
                           'areoidMinusEllipsoidRayRadiusM': stats(radii-ellipsoid_ray_radius),
                           'legacyPhysicalCentricMinusSourceLatitudeDeg': {
                               'min': float((legacy_centric_lat-lat).min()), 'max': float((legacy_centric_lat-lat).max())},
                           'conditionalMinusLegacyAlongSourceRadialM': stats(along_radial),
                           'conditionalMinusLegacyTangentialM': stats(tangent),
                           'legacyToConditionalDisplacementM': stats(displacement), 'rows': rows},
              'flights': {'count': 72, 'samples': len(all_shifts),
                          'legacyToConditionalDisplacementM': stats(all_shifts),
                          'conditionalRadialClearanceMinimumM': float(min(all_clearances)), 'rows': flight_rows},
              'gate': {'decision': 'hold-derived-trajectory-regeneration',
                       'absolutePositionAccuracyM': None, 'sourceFrameTransform': None,
                       'reasons': ['MMGIS map configuration and projected coordinates support spherical source-map angles; the JSON supplies no explicit vertical model version or SF3-to-IAU_MARS transform.',
                                   'The radial alternative uses source-map planetocentric angles and assumes MEG016-compatible Elev_Geoid; absolute frame/datum accuracy remains unknown.',
                                   'The source has 2D paths: altitude profile and uniform sample timing remain synthesized.',
                                   'Source SCLK-to-ET semantics have not been independently established; preserve timing.',
                                   'Scalar controls share provenance with the DTM and cannot certify absolute positioning.']}}
    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2, allow_nan=False)+'\n')
    print(json.dumps({'controls': report['controls']['fieldMinusObservationM'],
                      'displacementM': report['flights']['legacyToConditionalDisplacementM'],
                      'gate': report['gate']}, indent=2))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for key in ['source', 'fusion', 'old-fusion', 'areoid', 'out']:
        p.add_argument('--'+key, required=True)
    p.add_argument('--flights', default='apps/viewer/test-catalogs/data/ingenuity')
    p.add_argument('--mmgis-config', required=True, help='Original NASA public M20 configuration response')
    run(p.parse_args())
