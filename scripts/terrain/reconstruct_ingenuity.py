#!/usr/bin/env python3
"""Explicitly estimated Ingenuity trajectories on the documented orbital map.

MMGIS paths/landing locations and event epochs remain unchanged. Their 2D
vertices have no observed time/altitude samples. We assign distance-based timing
with acceleration/deceleration and estimate terrain-relative altitude. NASA's
rounded summary statistics constrain the model; conflicts remain in the report.
Never changes the terrain or uses an ellipsoidal geodetic source latitude.
"""
import argparse
import json
import math
from pathlib import Path
import numpy as np
from audit_ingenuity import areoid_radius, pin, radial_xyz, sample_raster, stats

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT/'apps/viewer/test-catalogs/data/ingenuity'


def path_schedule(coords, duration, peak, max_speed):
    """Return original vertex times plus hover-climb/descent knots.

    Smooth velocity ramps cover the horizontal polyline in the remaining time.
    Vertical speed uses a cosine ramp; its peak is reported explicitly and can
    exceed 2 m/s when the summary leaves little time for climb and descent.
    The published speed can be inconsistent with the mapped path: preserve both
    and report the modeled speed instead of silently scaling the observations.
    """
    if duration <= 0 or peak <= 0 or max_speed < 0:
        raise ValueError('Invalid flight summary')
    coords = np.asarray(coords, float)
    if coords.ndim != 2 or coords.shape[1] != 2 or len(coords) < 2 or not np.isfinite(coords).all():
        raise ValueError('Expected a finite horizontal polyline')
    direction = radial_xyz(coords[:, 0], coords[:, 1], np.ones(len(coords)))
    segments = np.linalg.norm(np.diff(direction, axis=0), axis=1)*3396190
    distance = np.r_[0, np.cumsum(segments)]
    # Reserve an initially plausible 1 m/s average climb/descent; shorten toward
    # a 2 m/s average only when the horizontal path needs the published speed.
    climb = min(peak, duration*.22)
    if max_speed > 0:
        room = (duration - distance[-1]/max_speed)/2
        climb = min(climb, max(peak/2, room*.85))
    climb = min(climb, duration*.22)
    travel = duration - 2*climb
    # Trapezoidal ground speed. Ramp fraction chosen to stay under the reported
    # peak when possible; a zero reported speed cannot constrain a nonzero path.
    ramp = .08
    mean = distance[-1]/travel
    if max_speed > mean:
        ramp = min(ramp, max(.005, (1-mean/max_speed)*.8))
    speed = mean/(1-ramp)
    if distance[-1] > 1e-8:
        q = distance/distance[-1]
        a = ramp/(2*(1-ramp))
        u = np.where(q < a, np.sqrt(2*ramp*(1-ramp)*q),
                     np.where(q > 1-a, 1-np.sqrt(2*ramp*(1-ramp)*(1-q)),
                              q*(1-ramp)+ramp/2))
    else:
        u = np.linspace(0, 1, len(coords))
    # Consecutive duplicate vertices carry no additional observation. Retain a
    # single copy so there are no duplicate epochs in InterpolatedStates.
    keep = np.r_[True, np.diff(u) > 1e-12]
    times = climb + u[keep]*travel
    original = coords[keep]
    knots = np.linspace(0, climb, max(16, math.ceil(climb*4)+1))
    t = np.r_[knots[:-1], times, duration-knots[-2::-1]]
    xy = np.vstack([np.repeat(coords[:1], len(knots)-1, axis=0), original,
                    np.repeat(coords[-1:], len(knots)-1, axis=0)])
    phase = np.minimum(np.minimum(t/climb, (duration-t)/climb), 1)
    altitude = peak*.5*(1-np.cos(np.pi*np.maximum(0, phase)))
    return t, xy, altitude, dict(pathDistanceM=float(distance[-1]), modeledMaxGroundspeedMS=float(speed),
                               modeledMaxVerticalSpeedMS=float(peak*math.pi/(2*climb)),
                               climbDurationS=float(climb), horizontalDurationS=float(travel))


def reconstruct(fusion, areoid, output, report):
    paths = json.loads((DATA/'m20_heli_flight_path.json').read_text())['features']
    waypoints = {f['properties']['Flight']: f for f in json.loads((DATA/'m20_heli_waypoints.json').read_text())['features']}
    log = json.loads((DATA/'official-flight-log.json').read_text())
    output.mkdir(parents=True, exist_ok=True)
    rows, index = [], []
    for summary in log['flights']:
        number = summary['flight']; wp = waypoints[number]['properties']
        matches = [f for f in paths if abs(f['properties']['SCLK_END']-wp['SCLK_START']) < 1]
        if len(matches) != 1:
            raise ValueError(f'Flight {number}: ambiguous original event matching')
        path = matches[0]; p = path['properties']
        start, end = p['SCLK_START'], p['SCLK_END']; duration = end-start
        coords = np.asarray(path['geometry']['coordinates'])[:, :2]
        # Require observed landing continuity; do not hide different endpoints.
        for c, f in [(coords[0], waypoints[number-1]), (coords[-1], waypoints[number])]:
            if not np.allclose(c, f['geometry']['coordinates'][:2], atol=1e-8, rtol=0):
                raise ValueError(f'Flight {number}: path endpoint differs from landing observation')
        t, xy, altitude, metrics = path_schedule(coords, duration, summary['maxAltitudeM'], summary['maxGroundspeedMS'])
        lon, lat = xy.T
        # Ground elevations inside the documented mission footprint are model
        # inputs to an estimated AGL flight, never an observed vertical series.
        ground = sample_raster(Path(fusion)/'fused.tif', lon, lat, cubic=True)
        radius = areoid_radius(areoid, lon, lat)
        positions = radial_xyz(lon, lat, radius+ground+altitude)/1000
        velocities = np.gradient(positions, t, axis=0, edge_order=2)
        name = f'flight_{number:02}.xyzv'
        header = [f'# Ingenuity Flight {number}; ESTIMATED 3D reconstruction, not flight telemetry.',
                  '# Source angles: planetocentric latitude, east longitude; documented M20 orbital map.',
                  '# Radius = pinned MEG016 areoid + unmodified TRN terrain + estimated radial AGL.',
                  '# MMGIS event numbers retained as approximate J2000 seconds; clock drift is uncalibrated.',
                  '# Interior timing is distance-based; cosine climb/descent with published peak altitude.',
                  '# Frame: Mars map body-fixed Z north. Absolute frame/position uncertainty is not certified.',
                  '# JD(TDB approximation) x y z vx vy vz; km and km/s. See reconstruction.json.']
        lines = [' '.join([f'{2451545+(start+ti)/86400:.12f}',
                          *(f'{x:.9f}' for x in pos), *(f'{v:.9e}' for v in vel)])
                 for ti, pos, vel in zip(t, positions, velocities)]
        (output/name).write_text('\n'.join(header+lines)+'\n')
        row = dict(flight=number, pathLabel=p['Flight'], samples=len(t), eventDurationS=duration,
                   published=summary, **metrics,
                   durationMinusPublishedS=duration-summary['durationS'],
                   pathMinusPublishedDistanceM=metrics['pathDistanceM']-summary['distanceM'],
                   modeledMinusPublishedMaxGroundspeedMS=metrics['modeledMaxGroundspeedMS']-summary['maxGroundspeedMS'],
                   endpointTerrainMinusObservedM=[float(ground[0]-waypoints[number-1]['properties']['Elev_Geoid']),
                                                   float(ground[-1]-wp['Elev_Geoid'])],
                   minimumEstimatedAglM=float(altitude.min()), maximumEstimatedAglM=float(altitude.max()))
        rows.append(row)
        index.append(dict(flight=number, file='data/ingenuity/'+name, etStart=start, etEnd=end,
                          durationS=duration, peakAltM=summary['maxAltitudeM'], fromAirfld=wp['FromAirfld'],
                          toAirfld=wp['ToAirfld'], reconstruction='estimated-terrain-relative'))
    (output/'flights_index.json').write_text(json.dumps(index, indent=2)+'\n')
    result = dict(kind='estimated-ingenuity-reconstruction', version=1,
                  inputs={k: pin(p) for k, p in [('paths', DATA/'m20_heli_flight_path.json'),
                           ('waypoints', DATA/'m20_heli_waypoints.json'), ('officialLog', DATA/'official-flight-log.json'),
                           ('terrain', Path(fusion)/'fused.tif'), ('areoidLabel', areoid),
                           ('areoidImage', Path(areoid).with_suffix('.IMG'))]},
                  policy='Terrain chosen independently. Observed horizontal vertices and landing locations preserved; interior times and radial AGL explicitly estimated.',
                  coordinateEvidence='PDS Mars 2020 Camera SIS v3.7 section 20.11: HELI_M to HELI_G to SITE(3), positive-down Z, orbital EQC standard parallel 18.4663 degrees; direct map coordinates do not require an invented SF3 rotation.',
                  clockPolicy='Original mission epochs retained. PDS SIS documents J2000 nominal SCLK epoch and possible clock drift. No calibrated MMGIS clock-to-ET solution is asserted.',
                  limitations=['No complete public 3D time series established; NAIF archive explicitly excludes Ingenuity kernels.',
                               'Terrain-relative cruise is an estimated visualization profile, not the onboard guidance law.',
                               'Summary distances and speeds can conflict with mapped paths; observations are not rescaled to force agreement.',
                               'Zero-distance/zero-speed summaries do not erase the nonzero observed tracks, including Flights 1, 71 and 72.',
                               'Absolute map frame, datum uncertainty and PCK realization remain uncertified.'], flights=rows)
    report.write_text(json.dumps(result, indent=2)+'\n')
    return result


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--fusion', required=True, type=Path)
    p.add_argument('--areoid', required=True, type=Path)
    p.add_argument('--output', type=Path, default=DATA)
    p.add_argument('--report', type=Path, default=DATA/'reconstruction.json')
    a = p.parse_args()
    reconstruct(a.fusion, a.areoid, a.output, a.report)
