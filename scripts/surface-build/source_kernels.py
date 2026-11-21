"""Verify the actual pinned baseline kernels used by emitted vertices/normals.

Native nodata remains native nodata. This does not fill pixels or change the
builder's source-level selection; a used invalid kernel rejects completion.
"""
import json
import math
import numpy as np
from osgeo import gdal


def verify(base_path, manifest_path):
    from dem import geographic_grid, cube_lattice_uv, cube_directions, direction_lonlat, pick_level
    manifest=json.loads(open(manifest_path).read()); ds=gdal.Open(str(base_path));native=ds.GetRasterBand(1)
    gt=geographic_grid(ds);W,H=ds.RasterXSize,ds.RasterYSize
    bands=[native]+[native.GetOverview(i) for i in range(native.GetOverviewCount())]
    levels=[(None,(gt[0],gt[1]*W/b.XSize,0,gt[3],0,gt[5]*H/b.YSize)) for b in bands]
    checks={}
    def read_support(band, rows, cols):
        if not rows.size:return
        x0,x1,y0,y1=int(cols.min()),int(cols.max()),int(rows.min()),int(rows.max())
        if (x1-x0+1)*(y1-y0+1)>16000000:
            half=rows.size//2
            assert half>0, 'source kernel inspection exceeds bounded window'
            read_support(band,rows[:half],cols[:half]);read_support(band,rows[half:],cols[half:]);return
        a=band.ReadAsArray(x0,y0,x1-x0+1,y1-y0+1);values=a[rows-y0,cols-x0]
        valid=np.isfinite(values)
        if band.GetNoDataValue() is not None:valid &= values!=band.GetNoDataValue()
        mask=band.GetMaskBand().ReadAsArray(x0,y0,x1-x0+1,y1-y0+1)
        assert valid.all() and np.all(mask[rows-y0,cols-x0]>0), 'emitted baseline sample kernel contains nodata'
    for face,L,x,y,*_ in manifest['tiles']:
        spacing=2/((manifest['grid']['width']-1)*2**L); index=pick_level(levels,math.degrees(spacing));band=bands[index];g=levels[index][1]
        u,v=cube_lattice_uv(L,x,y,manifest['grid']['width']); d=cube_directions(face,u,v).reshape(-1,3)
        axis=np.eye(3)[np.argmin(np.abs(d),axis=1)];t1=np.cross(axis,d);t1/=np.linalg.norm(t1,axis=1,keepdims=True);t2=np.cross(d,t1)
        directions=[d]+[d*math.cos(spacing)+sign*math.sin(spacing)*t for t in [t1,t2] for sign in [-1,1]]
        for vectors in directions:
            lon,lat=direction_lonlat(vectors);c=np.floor((lon-g[0])/g[1]-.5).astype(np.int64);r=np.floor((lat-g[3])/g[5]-.5).astype(np.int64)
            cols=np.concatenate([(c+dx)%band.XSize for dy in [-1,0,1,2] for dx in [-1,0,1,2]])
            rows=np.concatenate([np.clip(r+dy,0,band.YSize-1) for dy in [-1,0,1,2] for dx in [-1,0,1,2]])
            read_support(band,rows,cols)
        row=checks.setdefault(index,{'sourcePyramidLevel':index,'sourceSize':[band.XSize,band.YSize],'tiles':0,'vertexAndNormalSamples':0})
        row['tiles']+=1;row['vertexAndNormalSamples']+=len(d)*5
    return {'method':'all Catmull-Rom support cells at the exact pinned pyramid level for every emitted lattice vertex and four normal probes',
            'invalidUsedKernels':0,'levels':list(checks.values()),
            'nativeCoverageNote':'Native voids are retained in the source audit; valid coarse overview samples do not establish native-resolution coverage.'}
