#!/usr/bin/env python3
"""Audit runtime-exported estimated Hermite/Float32 plot samples against
unchanged fused/areoid terrain and native CPU/emitted GLB radial triangles.
Dense sampling is evidence, not a formal continuous clearance bound.
"""
import argparse
import json
from pathlib import Path
import numpy as np
import dem
from audit_ingenuity import areoid_radius, pin, sample_raster


def summary(values):
    return dict(samples=len(values), minimumM=float(values.min()), p05M=float(np.quantile(values,.05)),
                maximumM=float(values.max()), negativeSamples=int((values<0).sum()),
                belowMinus5cm=int((values<-.05).sum()))


class NativeSurface:
    def __init__(self, root):
        self.root=root
        self.manifest=json.loads((root/'cpu-grids.json').read_text())
        assert self.manifest['geometry']['kind']=='radial-lattice'
        self.radius=self.manifest['geometry']['referenceRadiusKm']*1000
        self.width=self.manifest['grid']['width']
        assert self.width==dem.GRID
        self.tiles={tuple(t[:4]) for t in self.manifest['tiles']}
        self.cache={}

    def vertices(self,key):
        if key in self.cache:return self.cache[key]
        f,L,x,y=key; n=self.width
        heights=np.fromfile(self.root/'heights'/f/str(L)/str(x)/f'{y}.f32','<f4').reshape(n,n)
        ij=np.stack(np.meshgrid(np.arange(n),np.arange(n)),axis=-1)
        d=dem.cube_lattice_rays(f,L,x,y,ij);d/=np.linalg.norm(d,axis=-1)[...,None]
        cpu=d*(self.radius+heights.astype(float))[...,None]
        P,tri,extras=dem.read_glb_mesh(self.root/f/str(L)/str(x)/f'{y}.glb')
        tri=tri[:extras.get('surfaceTriangles',len(tri))]
        used=np.unique(tri); coords=dem.cube_lattice_coords(P[used],f,L,x,y).astype(int)
        glb=np.full((n,n,3),np.nan);glb[coords[:,1],coords[:,0]]=P[used]
        # These mission products declare no simplification. Check, don't assume,
        # that every emitted triangle is one canonical v00-v11 lattice half.
        by_vertex=np.zeros((len(P),2),int);by_vertex[used]=coords
        T=by_vertex[tri];assert (np.ptp(T,axis=1)<=1).all()
        assert len(tri)==2*(n-1)**2 and np.isfinite(glb).all()
        mins=T.min(axis=1)
        assert np.all((T==mins[:,None,:]).all(axis=-1).any(axis=-1))
        assert np.all((T==(mins+1)[:,None,:]).all(axis=-1).any(axis=-1))
        self.cache[key]=(cpu,glb)
        return cpu,glb

    def radii(self, positions):
        d=positions/np.linalg.norm(positions,axis=1)[:,None];count=len(d)
        cpu=np.full(count,np.nan);glb=cpu.copy();levels=np.full(count,-1)
        axis=np.argmax(np.abs(d),axis=1)
        for f,basis in dem.CUBE_BASES.items():
            n,u,v=np.asarray(basis,float);which=np.flatnonzero((axis==np.argmax(np.abs(n)))&((d@n)>0))
            if not len(which):continue
            w=d[which]@n;U=(d[which]@u)/w;V=(d[which]@v)/w
            pending=np.ones(len(which),bool)
            for L in range(self.manifest['maxLevel'],-1,-1):
                size=2**L;X=np.clip(np.floor((U+1)*.5*size).astype(int),0,size-1);Y=np.clip(np.floor((V+1)*.5*size).astype(int),0,size-1)
                for x,y in np.unique(np.stack([X[pending],Y[pending]],axis=1),axis=0):
                    key=(f,L,int(x),int(y))
                    if key not in self.tiles:continue
                    local=np.flatnonzero(pending&(X==x)&(Y==y));selected=which[local]
                    a=((U[local]+1)*.5*size-x)*(self.width-1);b=((V[local]+1)*.5*size-y)*(self.width-1)
                    ix=np.minimum(self.width-2,np.floor(a).astype(int));iy=np.minimum(self.width-2,np.floor(b).astype(int))
                    lower=(b-iy)<=(a-ix)
                    for target,vertices in zip([cpu,glb],self.vertices(key)):
                        A=vertices[iy,ix];B=np.where(lower[:,None],vertices[iy,ix+1],vertices[iy+1,ix+1]);C=np.where(lower[:,None],vertices[iy+1,ix+1],vertices[iy+1,ix])
                        normal=np.cross(B-A,C-A);target[selected]=(normal*A).sum(axis=1)/(normal*d[selected]).sum(axis=1)
                    levels[selected]=L;pending[local]=False
                if not pending.any():break
            assert not pending.any(),'Missing native terrain support'
        assert np.isfinite(cpu).all() and np.isfinite(glb).all()
        return cpu,glb,levels


def audit(args):
    exported=json.loads((args.samples/'samples.json').read_text());assert exported['passed'] and len(exported['rows'])==72
    surface=NativeSurface(args.terrain);rows=[]
    for entry in exported['rows']:
        number=entry['flight'];raw=np.fromfile(args.samples/f'flight-{number}.f64','<f8').reshape(-1,5)
        kind=raw[:,0].astype(int);p=raw[:,2:5]*1000;r=np.linalg.norm(p,axis=1)
        lon=np.degrees(np.arctan2(p[:,1],p[:,0]));lat=np.degrees(np.arctan2(p[:,2],np.hypot(p[:,0],p[:,1])))
        reference=sample_raster(args.fusion/'fused.tif',lon,lat,cubic=True)+areoid_radius(args.areoid,lon,lat)
        cpu,glb,levels=surface.radii(p)
        row=dict(**entry, sampleKinds={})
        for k,name in [(0,'actualHermite'),(1,'drawnFloat32Vertices'),(2,'drawnSegmentInteriors')]:
            use=kind==k
            row['sampleKinds'][name]=dict(fusedAgl=summary(r[use]-reference[use]),cpuAgl=summary(r[use]-cpu[use]),glbAgl=summary(r[use]-glb[use]),
                cpuGlbDifferenceMaxM=float(np.abs(cpu[use]-glb[use]).max()),levels=sorted(set(levels[use].tolist())))
        row['worstNativeSample']=dict(kind=int(kind[int(np.argmin(r-cpu))]),et=float(raw[int(np.argmin(r-cpu)),1]),latDeg=float(lat[int(np.argmin(r-cpu))]),lonDeg=float(lon[int(np.argmin(r-cpu))]),fusedAglM=float((r-reference)[int(np.argmin(r-cpu))]),nativeAglM=float((r-cpu).min()))
        row['maximumNativeMinusFusedM']=float(np.abs(cpu-reference).max())
        row['previousLandingGapM']=None if number==1 else float(np.linalg.norm(np.asarray(entry['first'])-np.asarray(exported['rows'][number-2]['last']))*1000)
        rows.append(row)
        print(number,[(k,round(v['fusedAgl']['minimumM'],6),round(v['cpuAgl']['minimumM'],6))for k,v in row['sampleKinds'].items()],flush=True)
    result=dict(kind='actual-runtime-estimated-flight-and-plot-clearance',estimated=True,flights=72,landingControls=73,
                sampling='All actual InterpolatedStates knots plus 15 interior points per Hermite interval; every actual drawn Float32 vertex and three interior points per drawn segment. Not a formal continuous bound.',
                inputs=dict(fused=pin(args.fusion/'fused.tif'),areoidLabel=pin(args.areoid),cpuManifest=pin(args.terrain/'cpu-grids.json'),export=pin(args.samples/'samples.json')),
                rows=rows,sourceAbsoluteAccuracyM=None,
                gates=dict(fusedNegativeToleranceM=.0001,nativeTriangleNegativeToleranceM=.1,plotDeviationM=.05,landingContinuityM=.001),
                toleranceMeaning='Numerical representation gates only, not source absolute accuracy or measured flight accuracy. Native-vs-fused ground contact may differ; no terrain or trajectory shift is applied.')
    result['passed']=all(all(v['fusedAgl']['minimumM']>=-.0001 and v['cpuAgl']['minimumM']>=-.1 and v['glbAgl']['minimumM']>=-.1 for v in r['sampleKinds'].values()) and r['maxDeviationM']<=.05 and (r['previousLandingGapM'] or 0)<=.001 for r in rows)
    args.out.write_text(json.dumps(result,indent=2)+'\n')
    assert result['passed'],'Estimated curve/plot exceeded the declared numerical gates'

if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__)
    for name in ['samples','terrain','fusion','areoid','out']:a.add_argument('--'+name,type=Path,required=True)
    audit(a.parse_args())
