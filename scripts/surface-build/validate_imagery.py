#!/usr/bin/env python3
"""Independent native raster -> emitted cube pixel registration/fidelity checks."""
import argparse
import json
import math
from pathlib import Path
import sys
import numpy as np
from osgeo import gdal, ogr
sys.dont_write_bytecode = True
gdal.UseExceptions()


def continuous_coverage(bounds, level, available, bases):
    """Conservative interval enclosure of an entire bounded lon/lat rectangle.

    This pilot accepts one-face ROIs. Enclosing the whole rectangle also covers
    nonrectangular polygons/holes without relying on pixel-count sampling.
    """
    w,e,s,n=(math.radians(v) for v in bounds)
    assert e-w < math.pi and -math.pi/2 <= s <= n <= math.pi/2
    def trig(a,b,cosine=False):
        f=math.cos if cosine else math.sin
        phase=0 if cosine else math.pi/2
        points=[a,b]+[phase+k*math.pi for k in range(-4,5) if a<=phase+k*math.pi<=b]
        values=[f(v) for v in points];return min(values),max(values)
    def mul(a,b):
        v=[x*y for x in a for y in b];return min(v),max(v)
    c=trig(s,n,True)
    xyz=[mul(c,trig(w,e,True)),mul(c,trig(w,e)),trig(s,n)]
    mid=np.array([math.cos((s+n)/2)*math.cos((w+e)/2),math.cos((s+n)/2)*math.sin((w+e)/2),math.sin((s+n)/2)])
    axis=int(np.argmax(np.abs(mid)));face=('px','py','pz')[axis] if mid[axis]>=0 else ('nx','ny','nz')[axis]
    def component(basis):
        i=next(i for i,x in enumerate(basis) if x)
        return xyz[i] if basis[i]>0 else (-xyz[i][1],-xyz[i][0])
    normal,uaxis,vaxis=bases[face];den=component(normal)
    assert den[0]>0 and all(max(abs(v) for v in xyz[i])<den[0] for i in range(3) if i!=axis), 'bounded pilot ROI must remain on one cube face'
    def divide(a):
        v=[x/y for x in a for y in den];return min(v),max(v)
    u,v=divide(component(uaxis)),divide(component(vaxis));N=2**level
    x0=max(0,math.floor((u[0]+1)*N/2));x1=min(N-1,math.floor((u[1]+1)*N/2))
    y0=max(0,math.floor((v[0]+1)*N/2));y1=min(N-1,math.floor((v[1]+1)*N/2))
    assert (x1-x0+1)*(y1-y0+1)<=2048, 'continuous coverage proof exceeds tile budget'
    tiles=[f'{face}/{level}/{x}/{y}' for y in range(y0,y1+1) for x in range(x0,x1+1)]
    assert all(tile in available for tile in tiles), 'requested continuous footprint lacks finest output coverage'
    return {'method':'conservative trigonometric interval enclosure of complete requested lon/lat bounds on one face',
            'face':face,'uBounds':u,'vBounds':v,'finestTiles':tiles}


def validate(source_path, source, manifest_path, requested=None):
    ds = gdal.Open(str(source_path)); band = ds.GetRasterBand(1)
    gt = ds.GetGeoTransform(); radius = ds.GetSpatialRef().GetSemiMajor()
    assert abs(gt[1]+gt[5]) < 1e-12 and gt[2] == gt[4] == 0
    meta = json.loads(Path(manifest_path).read_text()); T,g = meta['tileSize'],meta['gutter']
    # Independently specified face bases and explicit affine source inversion.
    # Do not call the builder's coordinate or sampling functions here.
    bases={'px':((1,0,0),(0,0,-1),(0,1,0)),'nx':((-1,0,0),(0,0,1),(0,1,0)),
           'py':((0,1,0),(1,0,0),(0,0,-1)),'ny':((0,-1,0),(1,0,0),(0,0,1)),
           'pz':((0,0,1),(1,0,0),(0,1,0)),'nz':((0,0,-1),(-1,0,0),(0,1,0))}
    subset=[ogr.CreateGeometryFromJson(json.dumps(f['geometry'])) for f in source['metadata']['validData']['geometry']['features']]
    available=set(meta['tiles'])
    coverage_checks=0; continuous=[]
    max_spacing_m=2*radius/(T*2**meta['maxLevel'])
    if requested:
        from osgeo import osr
        # Rasterize requested polygons on the native grid, then prove a finest
        # output tile exists for every touched native cell plus polygon vertices.
        for request in requested:
            assert max_spacing_m <= request['outputGsdM'], 'emitted image spacing exceeds locked request'
            for feature in request['geometry']['features']:
                poly=ogr.CreateGeometryFromJson(json.dumps(feature['geometry']))
                w,e,s,n=poly.GetEnvelope()
                continuous.append(continuous_coverage((w,e,s,n),meta['maxLevel'],available,bases))
                c0=math.floor((math.radians(w)*radius-gt[0])/gt[1]);c1=math.ceil((math.radians(e)*radius-gt[0])/gt[1])
                r0=math.floor((math.radians(n)*radius-gt[3])/gt[5]);r1=math.ceil((math.radians(s)*radius-gt[3])/gt[5])
                assert 0<=c0<c1<=ds.RasterXSize and 0<=r0<r1<=ds.RasterYSize
                assert (c1-c0)*(r1-r0)<=16000000, 'requested native coverage exceeds pilot inspection bound'
                for r in range(r0,r1):
                    for c in range(c0,c1):
                        lon=math.degrees((gt[0]+(c+.5)*gt[1])/radius);lat=math.degrees((gt[3]+(r+.5)*gt[5])/radius)
                        point=ogr.Geometry(ogr.wkbPoint);point.AddPoint(lon,lat)
                        if not poly.Intersects(point):continue
                        la,lo=math.radians(lat),math.radians(lon);d=np.array([math.cos(la)*math.cos(lo),math.cos(la)*math.sin(lo),math.sin(la)])
                        axis=int(np.argmax(np.abs(d)));face=('px','py','pz')[axis] if d[axis]>=0 else ('nx','ny','nz')[axis]
                        N,U,V=(np.array(v,dtype=float) for v in bases[face]);scale=float(d@N)
                        x=int((float(d@U)/scale+1)*2**meta['maxLevel']/2);y=int((float(d@V)/scale+1)*2**meta['maxLevel']/2)
                        assert f"{face}/{meta['maxLevel']}/{x}/{y}" in available, 'native-valid requested cell lacks finest output coverage'
                        coverage_checks+=1
        assert coverage_checks>=1, 'no requested native cells were checked'
    errors=[]; values=[]; rows=[]; gutter_errors=[]
    for tile in meta['tiles']:
        face,L,x,y=tile.split('/');L,x,y=map(int,(L,x,y))
        if L != meta['maxLevel']: continue
        png=gdal.Open(str(Path(manifest_path).parent/'tiles'/f'{tile}.png'))
        grey=png.GetRasterBand(1).ReadAsArray(); alpha=png.GetRasterBand(png.RasterCount).ReadAsArray()
        N,U,V=(np.array(v,dtype=float) for v in bases[face]); size=2/2**L
        checked=0
        # Dense output samples throughout the declared native-valid subset.
        positions=sorted(set(range(0,T+2*g,3))|{0,1,T+2*g-2,T+2*g-1})
        for row in positions:
            for col in positions:
                u=-1+x*size+(col+.5-g)*size/T;v=-1+(y+1)*size-(row+.5-g)*size/T
                p=N+u*U+v*V; lon=math.degrees(math.atan2(p[1],p[0]));lat=math.degrees(math.atan2(p[2],math.hypot(p[0],p[1])))
                point=ogr.Geometry(ogr.wkbPoint);point.AddPoint(lon,lat)
                if not any(poly.Contains(point) for poly in subset):continue
                sx,sy=math.radians(lon)*radius,math.radians(lat)*radius
                px=(sx-gt[0])/gt[1]-.5;py=(sy-gt[3])/gt[5]-.5
                c,r=math.floor(px),math.floor(py);fx,fy=px-c,py-r
                assert 0<=c<ds.RasterXSize-1 and 0<=r<ds.RasterYSize-1
                a=band.ReadAsArray(c,r,2,2).astype(float)
                assert np.isfinite(a).all() and (band.GetNoDataValue() is None or np.all(a!=band.GetNoDataValue()))
                expected=(1-fy)*((1-fx)*a[0,0]+fx*a[0,1])+fy*((1-fx)*a[1,0]+fx*a[1,1])
                error=float(grey[row,col])-expected
                assert alpha[row,col]==255, 'native-valid pixel became transparent'
                errors.append(error);values.append(expected);checked+=1
                if row<g or col<g or row>=g+T or col>=g+T:gutter_errors.append(error)
        if checked:rows.append({'tile':tile,'checkedPixels':checked})
    assert len(errors)>=64, 'insufficient native registration samples'
    assert max(abs(e) for e in errors)<=.501, 'source-to-output registration exceeds byte quantization'
    assert np.std(values)>1, 'native detail check requires real image variation'
    return {'method':'independent affine inversion and bilinear native-cell interpolation at emitted pixel centres',
            'continuousRequestedCoverage':continuous, 'requestedNativeCellsWithFinestCoverage':coverage_checks, 'maximumOutputSpacingM':max_spacing_m,
            'checkedPixels':len(errors),'maximumErrorDn':max(abs(e) for e in errors),'rmsErrorDn':float(np.sqrt(np.mean(np.square(errors)))),
            'checkedGutterPixels':len(gutter_errors),'maximumGutterErrorDn':max((abs(e) for e in gutter_errors),default=None),
            'nativeValueStdDevDn':float(np.std(values)),'sourcePixelSizeM':gt[1], 'tiles':rows,
            'absoluteGeolocationErrorM':None,'note':'Verifies preservation of source registration and native texture; does not certify absolute image/DTM geolocation.'}


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--descriptor',required=True);p.add_argument('--manifest',required=True);p.add_argument('--out',required=True);p.add_argument('--requests')
    a=p.parse_args();result=validate(a.source,json.loads(Path(a.descriptor).read_text()),a.manifest,json.loads(Path(a.requests).read_text()) if a.requests else None);Path(a.out).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
