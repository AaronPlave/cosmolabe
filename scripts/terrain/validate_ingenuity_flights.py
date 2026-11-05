#!/usr/bin/env python3
"""Check serialized Hermite flight curves against the unchanged native terrain.

Quarter-interval samples supplement every stored knot and all 73 landing sites.
These are representation/model checks, not new measured flight telemetry.
"""
import argparse
import json
from pathlib import Path
import numpy as np
from audit_ingenuity import areoid_radius, pin, sample_raster, stats
from reconstruct_ingenuity import DATA


def hermite(records):
    p0,p1=records[:-1,1:4],records[1:,1:4]
    dt=np.diff(records[:,0])*86400
    if not np.all(dt>0):raise ValueError('Serialized epochs must increase strictly')
    out=[]
    for u in [0,.25,.5,.75]:
        out.append((2*u**3-3*u*u+1)*p0+(u**3-2*u*u+u)*dt[:,None]*records[:-1,4:7]
                   +(-2*u**3+3*u*u)*p1+(u**3-u*u)*dt[:,None]*records[1:,4:7])
    return np.vstack([*out,records[-1:,1:4]])


def validate(fusion,areoid,output,legacy=None):
    rows=[];waypoints={f['properties']['Flight']:f for f in json.loads((DATA/'m20_heli_waypoints.json').read_text())['features']}
    landing_errors=[]
    for number in range(1,73):
        path=DATA/f'flight_{number:02}.xyzv';data=np.loadtxt(path)
        positions=hermite(data)*1000
        radius=np.linalg.norm(positions,axis=1)
        lon=np.degrees(np.arctan2(positions[:,1],positions[:,0]))
        lat=np.degrees(np.arctan2(positions[:,2],np.hypot(positions[:,0],positions[:,1])))
        ground=sample_raster(Path(fusion)/'fused.tif',lon,lat,cubic=True)
        datum=areoid_radius(areoid,lon,lat)
        clearance=radius-datum-ground
        assert clearance.min()>=-.05,f'Flight {number}: Hermite curve enters the unchanged terrain'
        for row,which in [(data[0],number-1),(data[-1],number)]:
            pos=row[1:4];r=np.linalg.norm(pos)
            angles=[np.degrees(np.arctan2(pos[1],pos[0])),np.degrees(np.arctan2(pos[2],np.hypot(pos[0],pos[1])))]
            wp=waypoints[which]['properties']
            error=np.linalg.norm((np.array(angles)-[wp['Lon'],wp['Lat']])*np.array([np.cos(np.radians(wp['Lat'])),1]))*np.pi/180*3396190
            assert error<.001,'Landing horizontal observation changed'
            landing_errors.append(float(error))
        comparison={}
        if legacy is not None:
            old_path=legacy/path.name;old=np.loadtxt(old_path)
            epochs=data[:,0]
            use=(epochs>=old[0,0])&(epochs<=old[-1,0])
            old_positions=np.column_stack([np.interp(epochs[use],old[:,0],old[:,i]) for i in range(1,4)])
            comparison=dict(legacyInput=pin(old_path),sameEpochDisplacementM=stats(np.linalg.norm(data[use,1:4]-old_positions,axis=1)*1000),
                            comparisonSamples=int(use.sum()))
        rows.append(dict(flight=number,input=pin(path),serializedKnots=len(data),hermiteSamples=len(positions),**comparison,
                         minimumEstimatedClearanceM=float(clearance.min()),maximumEstimatedClearanceM=float(clearance.max()),
                         minimumEpochIntervalS=float((np.diff(data[:,0])*86400).min())))
    result=dict(kind='estimated-flight-representation-validation',flights=72,landingSites=73,
                sampling='All serialized knots plus quarter points of every Hermite interval; not a formal continuous bound.',
                totalHermiteSamples=sum(r['hermiteSamples'] for r in rows),
                maximumHorizontalLandingChangeM=max(landing_errors),
                minimumEstimatedClearanceM=min(r['minimumEstimatedClearanceM'] for r in rows),
                sourceAccuracyM=None,rows=rows)
    if legacy is not None:
        result['legacyComparison']='New serialized knots within the common time range versus linearly interpolated legacy Cartesian positions at the same epochs; coordinate and estimated profile changes combined, not an accuracy claim.'
    output.write_text(json.dumps(result,indent=2)+'\n')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--fusion',type=Path,required=True);p.add_argument('--areoid',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--legacy',type=Path,help='Optional immutable baseline xyzv directory for same-epoch displacement comparison')
    a=p.parse_args();validate(a.fusion,a.areoid,a.out,a.legacy)
