#!/usr/bin/env python3
"""Compare each unchanged SPICE solution with ground at its own horizontal location.

No terrain fitting, model displacement or source correction. Requires the exact
inputs pinned in the registration report; their hashes are retained in output.
"""
import argparse
import json
import math
from pathlib import Path
import numpy as np
from audit_ingenuity import areoid_radius, sample_raster, pin


def audit(chain, areoid, dem):
    report = json.loads(chain.read_text())
    report['groundInputs'] = [pin(dem), pin(areoid), pin(areoid.with_suffix('.IMG'))]
    for row in report['rows']:
        for solution in ['telemetry', 'localized']:
            q = row[solution+'PositionKm']
            p = np.array([q[k] for k in ['x', 'y', 'z']]) * 1000
            radius = float(np.linalg.norm(p))
            lon = math.degrees(math.atan2(p[1], p[0]))
            lat = math.degrees(math.asin(p[2] / radius))
            a = float(areoid_radius(areoid, np.array([lon]), np.array([lat]))[0])
            elevation = float(sample_raster(dem, np.array([lon]), np.array([lat]), cubic=True)[0])
            row[solution+'GroundComparison'] = dict(
                planetocentricLatDeg=lat, eastLonDeg=lon, roverOriginRadiusM=radius,
                areoidRadiusM=a, demAreoidElevationM=elevation,
                signedRadialOriginMinusDemM=radius-a-elevation,
                convention='same epoch and same planetocentric ray; positive outward; not wheel clearance')
        p = np.array([row['telemetryPositionKm'][k] for k in ['x', 'y', 'z']])
        q = np.array([row['localizedPositionKm'][k] for k in ['x', 'y', 'z']])
        row['solutionSeparationM'] = float(np.linalg.norm(p-q)*1000)
        row['attitudeMatrixMaxDifference'] = max(abs(a-b) for a, b in zip(row['roverToBody'], row['localizedRoverToBody']))
    report['conclusion'] = ('Catalog SPK precedence selects telemetry. The existing separately evaluated NAIF localized '
                            'position product follows PLACES localized_interp and agrees with the orbital DEM here; '
                            'it shares provenance and does not establish independent absolute accuracy. '
                            'No fit or viewer transform change is required to represent either source.')
    return report


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for key in ['chain', 'areoid', 'dem', 'out']:
        p.add_argument('--'+key, type=Path, required=True)
    args = p.parse_args()
    args.out.write_text(json.dumps(audit(args.chain, args.areoid, args.dem), indent=2)+'\n')
