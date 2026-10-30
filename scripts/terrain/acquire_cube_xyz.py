#!/usr/bin/env python3
"""Acquire a finite original-response bundle, including explicit source holes.

Run separately from the offline executor. Never resamples a parent to fabricate
native detail. Failed original responses remain pinned acquisition evidence and
become transparent pixels so independent runtime imagery can provide fallback.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import time
from urllib.request import urlopen
from urllib.error import HTTPError
import numpy as np
import cube_imagery as cube
from cube_xyz import decode, source_pixel, validate
from dem import parse_cube_region


def replay(bundle_file, output, workers):
    """Retrieve exactly a pinned inventory; changed source bytes fail closed."""
    raw=bundle_file.read_bytes()
    if bundle_file.suffix=='.gz': raw=gzip.decompress(raw)
    bundle=json.loads(raw)
    if bundle.get('kind')!='locked-xyz-bundle' or bundle.get('version') not in (1,2):
        raise ValueError('Expected pinned original-response inventory')
    config=validate(bundle['config'])
    output.mkdir(parents=True,exist_ok=False)
    (output/'responses').mkdir()
    def fetch(entry):
        key,item=entry
        z,x,y=map(int,key.split('/'))
        digest=item['sha256']
        if len(digest)!=64 or any(c not in '0123456789abcdef' for c in digest) or item['path']!='responses/'+digest+'.image':
            raise ValueError('Unsafe pinned response path')
        url=config['url'].replace('{z}',str(z)).replace('{x}',str(x)).replace('{y}',str(y))
        try:
            with urlopen(url,timeout=90) as response: data=response.read()
        except HTTPError as error:
            if error.code not in (204,404) or item.get('unavailable',{}).get('httpStatus')!=error.code: raise
            data=error.read()
        if hashlib.sha256(data).hexdigest()!=digest:
            raise ValueError(f'Original response changed: {url}; do not substitute new bytes into this lock')
        with tempfile.NamedTemporaryFile(dir=output/'responses',delete=False) as temporary:
            path=Path(temporary.name)
            try:
                temporary.write(data);temporary.flush();os.replace(path,output/item['path'])
            finally: path.unlink(missing_ok=True)
    with ThreadPoolExecutor(workers) as pool:
        for i,_ in enumerate(pool.map(fetch,bundle['tiles'].items())):
            if i%100==0: print(i,len(bundle['tiles']),flush=True)
    # Publish the original manifest only after every original object is verified.
    (output/'bundle.json').write_bytes(raw)


def required(config, tiles, tile_size, gutter):
    """Conservative source-tile inventory from dense tile footprints.

    Cube-face longitude/latitude extrema occur on the boundary or at a pole;
    sample all edges plus a 65x65 grid, then pad one whole source tile. This
    over-acquires; the offline adapter still fails on any omitted response.
    """
    result = set()
    for face, level, x, y in tiles:
        z = min(config.get('levels',8)-1, max(0, level+math.ceil(math.log2(math.pi*tile_size/config.get('dimension',256)))))
        if z < config.get('minZoom',0):
            continue
        u0, v0, width = cube.tile_rect(level,x,y)
        grid = np.linspace(-gutter/tile_size, 1+gutter/tile_size,65)
        u,v = np.meshgrid(u0+grid*width,v0+grid*width)
        lon,lat = cube.lonlat(cube.directions(face,u,v))
        ranges = [(lon.min(),lon.max())]
        if lon.max()-lon.min()>180:
            positive,negative = lon[lon>=0],lon[lon<0]
            ranges = [(positive.min(),180),(-180,negative.max())]
        if lat.max()>89.999999 or lat.min() < -89.999999:
            ranges = [(-180,180)]
        # Regional sources must not cause acquisitions across an entire coarse
        # cube face. The adapter samples only inside these same declared bounds.
        south, north = float(lat.min()), float(lat.max())
        if config.get('bounds') is not None:
            w, s, e, n = config['bounds']
            south, north = max(south, s), min(north, n)
            if south > north:
                continue
            source_ranges = [(w, e)] if w <= e else [(w, 180), (-180, e)]
            ranges = [(max(a, c), min(b, d)) for a, b in ranges for c, d in source_ranges
                      if max(a, c) <= min(b, d)]
        dim = config.get('dimension',256)
        _, py = source_pixel(np.zeros(2),np.array([south,north]),z,dim)
        y0,y1 = max(0,int(py.min()//dim)-1),min(2**z-1,int(py.max()//dim)+1)
        for west,east in ranges:
            px,_ = source_pixel(np.array([west,east]),np.zeros(2),z,dim)
            x0,x1 = int(px.min()//dim)-1,int(px.max()//dim)+1
            result.update((z,xx%(2**(z+1)),yy) for yy in range(y0,y1+1) for xx in range(x0,x1+1))
        if len(result)>100000:
            raise ValueError('Original-response inventory exceeds finite 100000-response bound')
    return sorted(result)


def acquire(config, keys, output, workers):
    output.mkdir(parents=True,exist_ok=False)
    directory=output/'responses';directory.mkdir()
    cached=Path(config.get('cache','/nonexistent'))
    def store(data):
        digest=hashlib.sha256(data).hexdigest()
        target=directory/(digest+'.image')
        # Multiple responses may have identical bytes. Decode only complete,
        # atomically installed objects, even when another worker shares a hash.
        with tempfile.NamedTemporaryFile(dir=directory,delete=False) as temporary:
            path=Path(temporary.name)
            try:
                temporary.write(data)
                temporary.flush()
                os.replace(path,target)
            finally:
                path.unlink(missing_ok=True)
        return digest,target
    def fetch(key):
        z,x,y=key
        url=config['url'].replace('{z}',str(z)).replace('{x}',str(x)).replace('{y}',str(y))
        cache_hash=hashlib.sha256(url.encode()).hexdigest()
        old=cached/cache_hash[:2]/(cache_hash+'.image')
        status=200; failure=None; data=None
        for attempt in range(3):
            try:
                if attempt==0 and old.is_file():
                    data=old.read_bytes()
                else:
                    with urlopen(url,timeout=90) as response:
                        data=response.read();status=response.status
                digest,target=store(data)
                if status==204:
                    failure={'reason':'http-missing','httpStatus':status,'url':url};break
                decode(config,target,url)
                failure=None;break
            except HTTPError as error:
                if error.code not in (204,404):
                    raise
                data=error.read();status=error.code
                digest,target=store(data)
                failure={'reason':'http-missing','httpStatus':status,'url':url};break
            except (RuntimeError,ValueError):
                failure={'reason':'decode-failure','httpStatus':status,'url':url}
                if attempt<2: time.sleep(attempt+1)
        # Transport errors fail acquisition; an HTTP success with confirmed
        # corrupt bytes is a separately pinned source hole, never native pixels.
        return '/'.join(map(str,key)),dict(path='responses/'+target.name,sha256=digest,
                                         **({'unavailable':failure} if failure else {}))
    entries={}
    with ThreadPoolExecutor(workers) as pool:
        for i,(key,value) in enumerate(pool.map(fetch,keys)):
            entries[key]=value
            if i%100==0: print(i,len(keys),flush=True)
    fields={'type','projection','latitudeConvention','url','levels','dimension','minZoom','bounds'}
    bundle=dict(version=2,kind='locked-xyz-bundle',config={k:v for k,v in config.items() if k in fields},tiles=entries)
    (output/'bundle.json').write_text(json.dumps(bundle,indent=2)+'\n')
    print(json.dumps(dict(responses=len(entries),unavailable=sum(bool(e.get('unavailable')) for e in entries.values()))))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    mode=p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--source',type=Path)
    mode.add_argument('--replay-bundle',type=Path)
    p.add_argument('--out',type=Path,required=True)
    p.add_argument('--global-level',type=int,default=2);p.add_argument('--region',action='append',default=[])
    p.add_argument('--tile-size',type=int,default=512);p.add_argument('--gutter',type=int,default=2)
    p.add_argument('--workers',type=int,default=8)
    a=p.parse_args()
    if a.replay_bundle:
        replay(a.replay_bundle,a.out,a.workers)
        raise SystemExit(0)
    config=validate(json.loads(a.source.read_text()))
    cube.R_KM=3396.19
    tiles=cube.select_tiles(a.global_level,[parse_cube_region(r) for r in a.region])
    keys=required(config,tiles,a.tile_size,a.gutter)
    print('required original responses',len(keys),flush=True)
    acquire(config,keys,a.out,a.workers)
