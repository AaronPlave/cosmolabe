/** Reuse the viewer's existing Earth texture as two deterministic EPSG:4326 root tiles. */
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
const source='apps/viewer/test-catalogs/textures/earth-5k.jpg';
const {width,height}=await sharp(source).metadata();
for(let x=0;x<2;x++){
 const target=`apps/viewer/test-catalogs/geographic/earth-base/0/${x}`;
 await mkdir(target,{recursive:true});
 await sharp(source).extract({left:Math.floor(width*x/2),top:0,width:Math.floor(width/2),height}).resize(512,512).jpeg({quality:90}).toFile(`${target}/0.jpg`);
}
