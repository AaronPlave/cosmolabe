#!/usr/bin/env python3
"""Explicit bounded acquisition; never called by offline build execution.

Read an exact native window of the official Mars 2020 TRN ortho. Preserve the
original map grid, both source labels, HTTP identity evidence and crop checksum.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import urllib.request
from osgeo import gdal

gdal.UseExceptions()
ROOT='https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/'
ORTHO='JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first'
DTM='JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40'


def acquire(out, lon, lat, pixels):
    assert 64<=pixels<=4096 and pixels%2==0 and -180<=lon<=180 and -90<=lat<=90
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    target=out/'hirise-ortho-native-crop.tif'
    assert not target.exists(), 'choose a fresh directory; existing native crop will not be overwritten'
    labels={}
    for role,stem in [('dtm',DTM),('ortho',ORTHO)]:
        with urllib.request.urlopen(ROOT+stem+'.lbl',timeout=60) as response: labels[role]=response.read()
        text=labels[role].decode()
        for expected in ['LatitudeType         = Planetocentric','LongitudeDirection   = PositiveEast','EquatorialRadius     = 3396190.0','UpperLeftCornerX     = 4577366.0','UpperLeftCornerY     = 1106618.0']:
            assert expected in text, 'official source label mapping differs from supported product'
        (out/(role+'.lbl')).write_bytes(labels[role])
    url=ROOT+ORTHO+'.tif'
    with urllib.request.urlopen(urllib.request.Request(url,method='HEAD'),timeout=60) as response:
        size=int(response.headers['Content-Length']);etag=response.headers.get('ETag','').strip('"')
        assert response.headers.get('Accept-Ranges')=='bytes', 'native window acquisition requires byte ranges'
    gdal.SetConfigOption('GDAL_DISABLE_READDIR_ON_OPEN','EMPTY_DIR')
    ds=gdal.Open('/vsicurl/'+url);gt=ds.GetGeoTransform()
    assert (ds.RasterXSize,ds.RasterYSize,ds.RasterCount)==(85600,85952,1)
    assert gt==(4577366.0,.25,0,1106618.0,0,-.25), 'native raster mapping differs from label'
    k=3396190*math.pi/180
    col=int((lon*k-gt[0])/gt[1]);row=int((lat*k-gt[3])/gt[5])
    window=[col-pixels//2,row-pixels//2,pixels,pixels]
    assert window[0]>=0 and window[1]>=0 and window[0]+pixels<=ds.RasterXSize and window[1]+pixels<=ds.RasterYSize
    gdal.Translate(str(target),ds,srcWin=window,creationOptions=['TILED=YES','COMPRESS=DEFLATE'])
    receipt={'kind':'native-grid-window','sourceUrl':url,'sourceBytes':size,'sourceEtag':etag,
      'sourceSize':[ds.RasterXSize,ds.RasterYSize],'sourceGeoTransform':list(gt),'sourceWindow':window,
      'resampling':'none; exact native pixel window','cropSha256':hashlib.sha256(target.read_bytes()).hexdigest(),
      'sourceLabelSha256':hashlib.sha256(labels['ortho']).hexdigest(),'dtmLabelSha256':hashlib.sha256(labels['dtm']).hexdigest()}
    (out/'ortho-crop-provenance.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--out',required=True);p.add_argument('--lon',type=float,default=77.4508);p.add_argument('--lat',type=float,default=18.4447);p.add_argument('--pixels',type=int,default=2048)
    a=p.parse_args();acquire(a.out,a.lon,a.lat,a.pixels)
