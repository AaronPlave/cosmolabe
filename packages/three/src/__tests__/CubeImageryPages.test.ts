import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CubeImageryPages } from '../CubeImageryPages.js';
import { directionToTexel, type ImageryAddress } from '../surface/CubeImagery.js';
import { cubeFaceToDirection } from '../surface/CubeSphere.js';
const a:ImageryAddress={face:'py',level:0,x:0,y:0};
function lookup(p:CubeImageryPages,source:number,point:ImageryAddress){
  const data=p.tableUniform.value.image.data as Int32Array;
  let node=p.root(source,point.face),found:number[]|null=null;
  for(let depth=0;node>=0&&depth<=point.level;depth++){
    const row=node*8;if(data[row+4]!==-1)found=[...data.slice(row+4,row+8)];
    if(depth===point.level)break;
    const shift=point.level-depth-1,quadrant=((point.x>>shift)&1)+2*((point.y>>shift)&1);
    node=data[row+quadrant];
  }
  return found;
}
describe('GPU imagery page publication',()=>{
  it('retires old-context callbacks during loss and clears even an empty restored cover',()=>{
    const p=new CubeImageryPages(264,2),canvas=new EventTarget(),renderer={domElement:canvas,properties:{get:()=>({__version:1})}} as unknown as THREE.WebGLRenderer;
    p.contextGeneration(renderer);p.upload('old',new THREE.Texture(),null);p.publish([{source:0,patch:a,image:a,slot:0}]);
    let retired=0;p.array.addEventListener('dispose',()=>retired++);p.tableUniform.value.addEventListener('dispose',()=>retired++);
    canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(retired).toBe(2);expect(p.has('old')).toBe(false);
    expect(p.contextGeneration(renderer)).toBe(true);p.publish([]);
    expect(p.root(0,'py')).toBe(-1);expect([...p.binding(0,a).image]).toEqual([-1,0,0,0]);p.dispose();
  });
  it('separates inherited renderer GL errors from actual allocation failures',()=>{
    const p=new CubeImageryPages(264,2),errors=[1282,0,0];
    const renderer={properties:{get:()=>({__version:1})},getContext:()=>({isContextLost:()=>false,getError:()=>errors.shift()??0,NO_ERROR:0}),initTexture:()=>{}} as unknown as THREE.WebGLRenderer;
    expect(p.initialize(renderer)).toBe(true);expect(p.inheritedGlErrors).toEqual([1282]);
    errors.push(0,1285);
    expect(p.initialize(renderer)).toBe(false);expect(p.lastError).toContain('1285');p.dispose();
  });
  it('invalidates pages after context restoration even if Three already reinitialized the array',()=>{
    const p=new CubeImageryPages(264,2);
    const renderer={properties:{get:()=>({__version:1})}} as unknown as THREE.WebGLRenderer;
    expect(p.contextGeneration(renderer)).toBe(true);
    p.upload('old-context',new THREE.Texture(),null);
    expect(p.contextGeneration(renderer)).toBe(false);
    expect(p.has('old-context')).toBe(true);
    renderer.properties={get:()=>({__version:1})} as unknown as THREE.WebGLRenderer['properties'];
    expect(p.contextGeneration(renderer)).toBe(true);
    expect(p.has('old-context')).toBe(false);
    p.dispose();
  });
  it('isolates sources, preserves root fallback, and addresses fine children without repeated tiles',()=>{
    const p=new CubeImageryPages(264,8);
    p.upload('base',new THREE.Texture(),null);p.upload('child',new THREE.Texture(),null);p.upload('other',new THREE.Texture(),null);
    const child={...a,level:2,x:2,y:1};
    p.publish([{source:0,patch:a,image:a,slot:p.slot('base')},{source:0,patch:child,image:child,slot:p.slot('child')},{source:1,patch:a,image:a,slot:p.slot('other')}]);
    expect(lookup(p,0,child)).toEqual([1,2,2,1]);
    expect(lookup(p,0,{...child,x:3})).toEqual([0,0,0,0]);
    expect(lookup(p,1,child)).toEqual([2,0,0,0]);
    expect(p.binding(0,child).root).toBe(-1);
    expect([...p.binding(0,child).image]).toEqual([1,2,2,1]);
    expect(p.binding(0,a).root).toBeGreaterThanOrEqual(0);
    expect([...p.binding(0,a).image]).toEqual([0,0,0,0]);
    expect([...p.binding(0,{...child,level:3,x:5,y:2}).image]).toEqual([1,2,2,1]);
    expect(lookup(p,0,{...child,face:'px'})).toBeNull();p.dispose();
  });
  it('keeps exact integer addresses beyond float32 coordinate precision',()=>{
    const p=new CubeImageryPages(264,2),deep={...a,level:30,x:2**29+7,y:2**28+19};
    p.upload('deep',new THREE.Texture(),null);p.publish([{source:0,patch:deep,image:deep,slot:0}]);
    expect(lookup(p,0,deep)).toEqual([0,30,deep.x,deep.y]);
    expect(lookup(p,0,{...deep,x:deep.x+1})).toBeNull();p.dispose();
  });
  it('recycles a slot only after explicit retirement and replaces the whole page table',()=>{
    const p=new CubeImageryPages(264,1);p.upload('a',new THREE.Texture(),null);
    expect(p.upload('b',new THREE.Texture(),null)).toBe(false);
    p.publish([{source:0,patch:a,image:a,slot:0}]);const previous=p.tableUniform.value;
    p.forget('a');expect(p.upload('b',new THREE.Texture(),null)).toBe(true);
    p.publish([{source:1,patch:a,image:a,slot:0}]);expect(p.tableUniform.value).not.toBe(previous);
    expect(p.root(0,'py')).toBe(-1);expect(lookup(p,1,a)).toEqual([0,0,0,0]);p.dispose();
  });
  it('publishes exact nodata without consuming a page or falling through to an opaque parent',()=>{
    const p=new CubeImageryPages(264,1);p.upload('root',new THREE.Texture(),null);p.transparent('hole');
    const child={...a,level:1,x:0,y:1};
    p.publish([{source:0,patch:a,image:a,slot:0},{source:0,patch:child,image:child,slot:p.slot('hole')}]);
    expect(lookup(p,0,child)).toEqual([-2,1,0,1]);expect(lookup(p,0,{...child,x:1})).toEqual([0,0,0,0]);
    expect(p.upload('more',new THREE.Texture(),null)).toBe(false);p.dispose();
  });
  it('does not publish readiness when GPU allocation fails',()=>{
    const p=new CubeImageryPages(264,2);
    const renderer={properties:{get:()=>({})},getContext:()=>({isContextLost:()=>false,getError:()=>0,NO_ERROR:0}),initTexture:()=>{throw Error('GPU allocation failed');}} as unknown as THREE.WebGLRenderer;
    expect(p.initialize(renderer)).toBe(false);
    expect(p.upload('unusable',new THREE.Texture(),renderer)).toBe(false);
    expect(p.has('unusable')).toBe(false);p.dispose();
  });
  it('keeps gutter coordinates consistent at face edges and polar corners',()=>{
    for(const face of ['px','nx','py','ny','pz','nz'] as const)for(const [u,v] of [[-.999999,0],[.999999,0],[0,-.999999],[.999999,.999999]]){
      const point=directionToTexel(cubeFaceToDirection(face,u,v) as [number,number,number],14,1024,2);
      expect(point.address.face).toBe(face);expect(point.column).toBeGreaterThanOrEqual(2);expect(point.column).toBeLessThanOrEqual(1026);
      expect(point.row).toBeGreaterThanOrEqual(2);expect(point.row).toBeLessThanOrEqual(1026);
    }
  });
});
