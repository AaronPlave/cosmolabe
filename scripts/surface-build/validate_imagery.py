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
    # Independent reference: native mask + DN are averaged via RasterIO,
    # rather than reading the builder's staged pyramid or sampling functions.
    assert ds.RasterXSize*ds.RasterYSize <= 16000000, 'imagery reference exceeds bounded native inspection limit'
    native=band.ReadAsArray().astype(np.float32)
    valid=np.isfinite(native) & (band.GetMaskBand().ReadAsArray()>0)
    if band.GetNoDataValue() is not None: valid &= native != band.GetNoDataValue()
    reference=gdal.GetDriverByName('MEM').Create('',ds.RasterXSize,ds.RasterYSize,2,gdal.GDT_Float32)
    reference.GetRasterBand(1).WriteArray(np.where(valid,native,0))
    reference.GetRasterBand(2).WriteArray(valid.astype(np.float32))
    ss=meta.get('generator',{}).get('supersample',1)
    assert ss in (1,4), 'unsupported imagery reference quadrature'
    levels={}; alpha_errors=[]
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
                factor=1
                if meta.get('filtering'):
                    spacing=size/T*radius*.4
                    while factor*2<=max(ds.RasterXSize,ds.RasterYSize) and gt[1]*factor*2<=max(spacing,gt[1]):factor*=2
                if factor not in levels:
                    width=math.ceil(ds.RasterXSize/factor);height=math.ceil(ds.RasterYSize/factor)
                    levels[factor]=[reference.GetRasterBand(i).ReadAsArray(buf_xsize=width,buf_ysize=height,
                        resample_alg=gdal.GRIORA_Average).astype(float) for i in (1,2)]
                premul,coverage=levels[factor];res=gt[1]*ds.RasterXSize/premul.shape[1]
                total=weight=0.
                for syi in range(ss):
                    for sxi in range(ss):
                        du=((sxi+.5)/ss-.5)*size/T;dv=((syi+.5)/ss-.5)*size/T
                        q=N+(u+du)*U+(v+dv)*V
                        qlon=math.atan2(q[1],q[0]);qlat=math.atan2(q[2],math.hypot(q[0],q[1]))
                        px=(qlon*radius-gt[0])/res-.5;py=(gt[3]-qlat*radius)/(abs(gt[5])*ds.RasterYSize/premul.shape[0])-.5
                        if not (-1<px<premul.shape[1] and -1<py<premul.shape[0]):continue
                        px=min(max(px,0),premul.shape[1]-1.000001);py=min(max(py,0),premul.shape[0]-1.000001)
                        c,r=math.floor(px),math.floor(py);fx,fy=px-c,py-r
                        for xx,yy,w in ((c,r,(1-fx)*(1-fy)),(min(c+1,premul.shape[1]-1),r,fx*(1-fy)),
                                        (c,min(r+1,premul.shape[0]-1),(1-fx)*fy),(min(c+1,premul.shape[1]-1),min(r+1,premul.shape[0]-1),fx*fy)):
                            total+=w*premul[yy,xx];weight+=w*coverage[yy,xx]
                expected=total/max(weight,1e-12)
                error=float(grey[row,col])-expected
                alpha_errors.append(abs(float(alpha[row,col])-255*weight/(ss*ss)))
                errors.append(error);values.append(expected);checked+=1
                if row<g or col<g or row>=g+T or col>=g+T:gutter_errors.append(error)
        if checked:rows.append({'tile':tile,'checkedPixels':checked})
    assert len(errors)>=64, 'insufficient native registration samples'
    assert max(alpha_errors)<=.501, 'filtered mask coverage exceeds byte quantization'
    assert max(abs(e) for e in errors)<=.501, 'source-to-output registration exceeds byte quantization'
    assert np.std(values)>1, 'native detail check requires real image variation'
    return {'method':'independent affine inversion, area-averaged native DN/validity reference and footprint quadrature', 'maximumAlphaErrorDn':max(alpha_errors),
            'continuousRequestedCoverage':continuous, 'requestedNativeCellsWithFinestCoverage':coverage_checks, 'maximumOutputSpacingM':max_spacing_m,
            'checkedPixels':len(errors),'maximumErrorDn':max(abs(e) for e in errors),'rmsErrorDn':float(np.sqrt(np.mean(np.square(errors)))),
            'checkedGutterPixels':len(gutter_errors),'maximumGutterErrorDn':max((abs(e) for e in gutter_errors),default=None),
            'nativeValueStdDevDn':float(np.std(values)),'sourcePixelSizeM':gt[1], 'tiles':rows,
            'absoluteGeolocationErrorM':None,'note':'Verifies preservation of source registration and native texture; does not certify absolute image/DTM geolocation.'}


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--descriptor',required=True);p.add_argument('--manifest',required=True);p.add_argument('--out',required=True);p.add_argument('--requests')
    a=p.parse_args();result=validate(a.source,json.loads(Path(a.descriptor).read_text()),a.manifest,json.loads(Path(a.requests).read_text()) if a.requests else None);Path(a.out).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
