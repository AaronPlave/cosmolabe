#!/usr/bin/env python3
"""Independently replay an archived helicopter image's published frame chain.

This is a sparse observed geometry check, not a claim that the public image
archive contains continuous flight telemetry or complete ascent/descent series.
"""
import argparse
import csv
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET
import numpy as np
from audit_ingenuity import pin, sample_raster


def local(element, name):
    return next(x for x in element.iter() if x.tag.split('}')[-1] == name)


def geometry(label):
    root=ET.parse(label).getroot();definitions={}
    for e in root.iter():
        if e.tag.split('}')[-1]!='Coordinate_Space_Definition':continue
        names=[x.text for x in e if x.tag.split('}')[-1]=='local_identifier']
        for name in names:definitions[name]=e
    heli=definitions['HELI_M_FRAME_12_1649'];ground=definitions['HELI_G_FRAME_12']
    def offset(e):
        vector=local(e,'Vector_Origin_Offset')
        return np.array([float(local(vector,k).text) for k in ['x_position','y_position','z_position']])
    q=local(ground,'Quaternion_Plus_Direction')
    assert local(q,'rotation_direction').text=='Forward'
    q=np.array([float(local(q,k).text) for k in ['qcos','qsin1','qsin2','qsin3']])
    assert abs(np.linalg.norm(q)-1)<1e-10
    v=offset(heli)
    site=v+2*np.cross(q[1:],np.cross(q[1:],v)+q[0]*v)+offset(ground)
    utc=local(root,'start_date_time').text
    sclk=float(local(root,'spacecraft_clock_start').text)
    return site,utc,sclk


def audit(label,places,terrain):
    site,utc,sclk=geometry(label)
    anchor=next(r for r in csv.DictReader(Path(places).open()) if r['frame']=='SITE' and r['site']=='3')
    k=3396190*math.pi/180
    lat=(float(anchor['northing'])+site[0])/k
    lon=(float(anchor['easting'])+site[1])/(k*math.cos(math.radians(18.4663)))
    elevation=float(anchor['elevation'])-site[2]
    ground=sample_raster(terrain,np.array([lon]),np.array([lat]),cubic=True)[0]
    # Document the nominal clock difference. It is not a derived whole-mission
    # calibration; clock kernels and updated geometry may use other solutions.
    nominal=datetime(2000,1,1,11,58,55,816000,tzinfo=timezone.utc).timestamp()+sclk
    actual=datetime.fromisoformat(utc.replace('Z','+00:00')).timestamp()
    return dict(kind='sparse-pds-helicopter-geometry-check',flight=12,
                inputs={k:pin(p) for k,p in [('imageLabel',label),('places',places),('terrain',terrain)]},
                site3PositionM=site.tolist(),planetocentricLatDeg=lat,longitudeEastDeg=lon,
                observedImageElevationAreoidM=elevation,unchangedTerrainAreoidM=float(ground),
                observedImageAglM=float(elevation-ground),imageStartUtc=utc,sourceSclk=sclk,
                utcMinusNominalSclkSeconds=actual-nominal,
                clockCaveat='Nominal J2000-epoch comparison only; no whole-mission clock calibration inferred. Original mission epochs remain approximate and unchanged.',
                geometryCaveat='Position at one archived camera event; not continuous helicopter telemetry. The per-flight G-to-SITE transform is explicitly supplied by this label.',
                sourceUrl='https://planetarydata.jpl.nasa.gov/img/data/mars2020/mars2020_helicam/data/sol/00174/ids/fdr/heli/HNM_0174_0682390538_578FDR_N0120001HELI01649_0000LUJ04.xml')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['label','places','terrain','out']:p.add_argument('--'+name,required=True,type=Path)
    a=p.parse_args();a.out.write_text(json.dumps(audit(a.label,a.places,a.terrain),indent=2)+'\n')
