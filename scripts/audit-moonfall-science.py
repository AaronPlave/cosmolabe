"""Check original MoonFall science candidates without assembling viewer assets.

See docs/validation/moonfall-science-source-audit.md for file names and hashes.
"""
import argparse
import json
from math import radians, tan
from pathlib import Path
import subprocess

import numpy as np
from osgeo import gdal, ogr, osr


RADIUS_M = 1_737_400
CPR_SHAPE = (8107, 8107)
CPR_AFFINE = (-304125, 75, 0, 304125, 0, -75)
CPR_INVALID_MIN = 0xFF7FFFFB
CPR_INVALID_MAX = 0xFF7FFFFF


def south_polar_xy(latitude, longitude):
    distance = 2 * RADIUS_M * np.tan(np.radians((90 + latitude) / 2))
    return distance * np.sin(np.radians(longitude)), distance * np.cos(np.radians(longitude))


def valid_cpr(values):
    bits = values.view('<u4')
    return np.isfinite(values) & ((bits < CPR_INVALID_MIN) | (bits > CPR_INVALID_MAX))


def audit_radar(raster):
    width = raster.shape[1]
    x = CPR_AFFINE[0] + 75 * (np.arange(width) + .5)
    radii = [2 * RADIUS_M * tan(radians((90 + lat) / 2)) for lat in (-80, -88, -89)]
    counts = [[0, 0] for _ in radii]
    valid_count, value_sum = 0, 0.0
    for row in range(0, raster.shape[0], 128):
        values = raster[row:row + 128]
        good = valid_cpr(values)
        valid_count += int(np.count_nonzero(good))
        value_sum += float(np.sum(values, where=good, dtype=np.float64))
        y = CPR_AFFINE[3] - 75 * (np.arange(row, row + len(values)) + .5)
        distance = np.hypot(x[None, :], y[:, None])
        for index, radius in enumerate(radii):
            cap = distance <= radius
            counts[index][0] += int(np.count_nonzero(cap & good))
            counts[index][1] += int(np.count_nonzero(cap))
    return {'valid': valid_count, 'total': raster.size, 'mean': value_sum / valid_count,
            'caps': dict(zip(('80S', '88S', '89S'), counts))}


def read_diviner(table_path):
    x, y, lon, lat, values = np.loadtxt(table_path, delimiter=',', skiprows=1, unpack=True)
    calc_x, calc_y = south_polar_xy(lat, lon)
    # Compare both coordinate representations printed in the source table.
    x, y = RADIUS_M * x, RADIUS_M * y
    x_axis, y_axis = np.unique(x), np.unique(y)
    if (len(x_axis), len(y_axis)) != (2533, 2533):
        raise ValueError('Unexpected Diviner axis lengths')
    i, j = np.searchsorted(x_axis, x), np.searchsorted(y_axis, y)
    if np.unique(j * len(x_axis) + i).size != values.size:
        raise ValueError('Duplicate Diviner cells')
    grid = np.full((len(y_axis), len(x_axis)), np.nan)
    good = np.isfinite(values) & (values != -9998) & (values != -9999)
    grid[j[good], i[good]] = values[good]
    stats = {
        'valid': int(good.sum()), 'centerLatitudeRange': [float(lat.min()), float(lat.max())],
        'temperatureRangeK': [float(np.nanmin(grid)), float(np.nanmax(grid))],
        'projectedVsAngularColumnsMaxResidualM': float(np.max(np.hypot(x - calc_x, y - calc_y))),
        'meanAxisSpacingM': [float(np.diff(axis).mean()) for axis in (x_axis, y_axis)],
    }
    return x_axis, y_axis, grid, stats


def cell_index(axis, coordinate):
    half_first = (axis[1] - axis[0]) / 2
    half_last = (axis[-1] - axis[-2]) / 2
    if axis[0] - half_first <= coordinate < axis[-1] + half_last:
        return int(np.searchsorted((axis[:-1] + axis[1:]) / 2, coordinate, side='right'))
    return None


def containing_features(layer, id_field, point):
    layer.SetSpatialFilter(point)
    hits = [
        {'id': feature.GetField(id_field), 'boundaryDistanceM': feature.GetGeometryRef().Boundary().Distance(point)}
        for feature in layer if feature.GetGeometryRef().Contains(point)
    ]
    layer.SetSpatialFilter(None)
    return hits


def audit_summer_maximum(path, x_axis, y_axis, noon, controls):
    ds = gdal.Open(str(path))
    data = ds.ReadAsArray()
    west, dx, _, north, _, dy = ds.GetGeoTransform()
    row, col = np.nonzero(np.isfinite(noon))
    x, y = x_axis[col], y_axis[row]
    noon_values = noon[row, col]
    col, row = np.floor((x - west) / dx).astype(int), np.floor((y - north) / dy).astype(int)
    residual = np.hypot(x - west - (col + .5) * dx, y - north - (row + .5) * dy)
    shifts = []
    for ry, cx in ((0, 0), (0, 1), (0, -1), (1, 0), (-1, 0)):
        i, j = row + ry, col + cx
        inside = (i >= 0) & (i < data.shape[0]) & (j >= 0) & (j < data.shape[1])
        difference = data[i[inside], j[inside]] - noon_values[inside]
        shifts.append({'rowColShift': [ry, cx], 'pairs': int(inside.sum()),
                       'belowNoon': int((difference < -.01).sum()), 'equalWithin0.0001K': int((abs(difference) < .0001).sum())})
    samples = {}
    for control in controls:
        x, y = south_polar_xy(control['latitude'], control['longitudeEast'])
        i, j = int((y - north) // dy), int((x - west) // dx)
        value = data[i, j] if 0 <= i < data.shape[0] and 0 <= j < data.shape[1] else np.nan
        samples[control['name']] = float(value) if np.isfinite(value) else None
    return {'maxPcpCenterResidualM': float(residual.max()), 'valid': int(np.isfinite(data).sum()),
            'rangeK': [float(np.nanmin(data)), float(np.nanmax(data))], 'shiftChecks': shifts, 'controlsK': samples}


def audit_radar_ground(s1_path, lola_path):
    # A regional diagnostic without moving the raster. Total return can track
    # along-look terrain slope, but varies with roughness and viewing geometry.
    ds = gdal.Open(str(lola_path))
    west, step, _, north, _, dy = ds.GetGeoTransform()
    if step != 160 or dy != -160:
        raise ValueError('Radar diagnostic expects the 160 m LOLA overview')
    dem = ds.ReadAsArray()
    radar = np.memmap(s1_path, mode='r', dtype='<f4', shape=CPR_SHAPE)
    controls = {}
    for name, lat, lon in [('Cabeus', -84.90, -35.5), ('Haworth', -87.45, -5.17), ('Amundsen', -84.4398, 83.0691)]:
        x, y = south_polar_xy(lat, lon)
        cx, cy = int((x - west) // step), int((y - north) // dy)
        rows = cy + np.arange(-92, 93) * 2
        cols = cx + np.arange(-92, 93) * 2
        radar_cols = np.floor((west + (cols + .5) * step - CPR_AFFINE[0]) / CPR_AFFINE[1]).astype(int)
        radar_rows = np.floor((north + (rows + .5) * dy - CPR_AFFINE[3]) / CPR_AFFINE[5]).astype(int)
        power = radar[np.ix_(radar_rows, radar_cols)]
        mask = (power > 0) & (power < 1)
        measured = np.log(power[mask]).astype(float)
        measured -= measured.mean()
        squares = measured @ measured
        quality = []
        for oy in range(-8, 9):
            for ox in range(-8, 9):
                gy, gx = np.gradient(dem[np.ix_(rows + oy, cols + ox)])
                slope = np.stack((gx[mask], gy[mask], np.hypot(gx, gy)[mask]), axis=1).astype(float)
                slope -= slope.mean(axis=0)
                error = measured - slope @ np.linalg.lstsq(slope, measured, rcond=None)[0]
                quality.append((float(1 - (error @ error) / squares), ox * step, oy * dy))
        best, sx, sy = max(quality)
        controls[name] = {'valid': int(mask.sum()), 'nativeR2': quality[len(quality) // 2][0],
                          'bestR2': best, 'bestDiagnosticShiftM': [sx, sy]}
    return controls


def audit(root, summer_max=None, radar_s1=None, lola_control=None):
    gdal.UseExceptions()
    ogr.UseExceptions()
    radar = np.memmap(root / 'cpr.img', mode='r', dtype='<f4', shape=CPR_SHAPE)
    pds = gdal.Open(str(root / 'cpr.lbl'))
    if pds.GetGeoTransform() != CPR_AFFINE or radar.nbytes != (root / 'cpr.img').stat().st_size:
        raise ValueError('Unexpected Mini-SAR affine or source byte count')

    x_axis, y_axis, temperature, diviner = read_diviner(root / 'diviner.tab')
    psr = ogr.Open(str(root / 'psr.shp'))
    reference = ogr.Open('/vsizip/' + str(root / 'psr-reference.zip'))
    layer, reference_layer = psr.GetLayer(), reference.GetLayer()
    invalid_psr_ids = [f.GetField('gid') for f in layer if not f.GetGeometryRef().IsValid()]

    projected = layer.GetSpatialRef()
    geographic = projected.CloneGeogCS()
    geographic.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transform = osr.CoordinateTransformation(geographic, projected)
    barker = []
    for lat, expected in [(-88.1813, -39000), (-77.3199, -273000)]:
        x, y, _ = transform.TransformPoint(225, lat)
        barker.append(float(np.hypot(x - expected, y - expected)))

    def sample(name, latitude, longitude):
        x, y = south_polar_xy(latitude, longitude)
        p = ogr.Geometry(ogr.wkbPoint)
        p.AddPoint_2D(x, y)
        x_origin, x_spacing, _, y_origin, _, y_spacing = CPR_AFFINE
        col, row = int((x - x_origin) // x_spacing), int((y - y_origin) // y_spacing)
        cpr = radar[row, col]
        if pds.ReadAsArray(col, row, 1, 1)[0, 0].view(np.uint32) != cpr.view(np.uint32):
            raise ValueError(f'GDAL and raw-byte Mini-SAR samples differ at {name}')
        i, j = cell_index(x_axis, x), cell_index(y_axis, y)
        kelvin = None if i is None or j is None else float(temperature[j, i])
        return {
            'name': name, 'latitude': latitude, 'longitudeEast': longitude,
            'divinerK': kelvin if kelvin is not None and np.isfinite(kelvin) else None,
            'miniSarRowColumn': [row, col], 'cpr': float(cpr) if valid_cpr(cpr) else None,
            'barkerPsr': containing_features(layer, 'gid', p),
            'mazaricoPsr': containing_features(reference_layer, 'PSR_ID', p),
        }

    controls = [
        sample('Shackleton', -89.67, 129.78),
        sample('Haworth PSR control', -87.35, -2.57),
        sample('Amundsen PSR control', -83.68, 91.28),
        sample('Haworth gazetteer anchor', -87.45, -5.17),
        sample('Amundsen gazetteer anchor', -84.4398, 83.0691),
        sample('Connecting Ridge C2 (Williams et al. Figure 10d)', -89.3157, -114.06),
        sample('Region 5', -87.03, 15.05),
        sample('South pole', -90, 0),
    ]
    schedule = (Path(__file__).resolve().parent / 'moonfall-schedule.mjs').as_uri()
    hoppers = json.loads(subprocess.check_output([
        'node', '--input-type=module', '-e',
        f"import {{ hoppers }} from {json.dumps(schedule)}; console.log(JSON.stringify(hoppers));",
    ]))
    for hopper in hoppers:
        for number, flight in enumerate(hopper['flights'], 1):
            landing = flight['waypoints'][-1]
            controls.append(sample(f"{hopper['name']} landing {number}", landing['lat'], landing['lon']))

    report = {
        'psr': {'features': layer.GetFeatureCount(), 'invalidIds': invalid_psr_ids,
                'barkerPublishedProjectionControlsResidualM': barker},
        'diviner': diviner, 'miniSar': audit_radar(radar), 'controls': controls,
    }
    if summer_max:
        report['divinerSummerMaximum'] = audit_summer_maximum(summer_max, x_axis, y_axis, temperature, controls)
    if radar_s1 and lola_control:
        report['miniSarGroundDiagnostics'] = audit_radar_ground(radar_s1, lola_control)
    print(json.dumps(report, indent=2, allow_nan=False))



if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--summer-max', type=Path)
    parser.add_argument('--radar-s1', type=Path)
    parser.add_argument('--lola-control', type=Path)
    args = parser.parse_args()
    if bool(args.radar_s1) != bool(args.lola_control):
        parser.error('--radar-s1 and --lola-control must be used together')
    audit(args.source.resolve(), args.summer_max, args.radar_s1, args.lola_control)
