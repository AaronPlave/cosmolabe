import { describe, expect, it } from 'vitest';
import { cubeTileId } from '../surface/CubeSphere.js';
import { ImageryRefinement, imageryChildren } from '../surface/ImageryRefinement.js';
import type { ImageryAddress } from '../surface/CubeImagery.js';
const root: ImageryAddress = { face: 'py', level: 0, x: 0, y: 0 };
const children = imageryChildren(root), grandchildren = children.flatMap(imageryChildren);
const ids = [root, ...children, ...grandchildren].map(cubeTileId);
const levels = (frame: ReturnType<ImageryRefinement['update']>) => [...new Set(frame.cover.map(c => c.image.level))];

describe('persistent imagery replacement hierarchy', () => {
  it('holds the visible refinement frontier until neighboring groups complete',()=>{
    const deep=grandchildren.flatMap(imageryChildren), tree=new ImageryRefinement([...ids,...deep.map(cubeTileId)]);
    const ready=new Set([root,...children].map(cubeTileId));
    tree.update(deep,a=>ready.has(cubeTileId(a)),0);
    // One spatial group gets two whole levels ahead of a delayed neighbor.
    const fast=[...imageryChildren(children[0]),...imageryChildren(children[0]).flatMap(imageryChildren)];
    fast.forEach(a=>ready.add(cubeTileId(a)));
    for(let frame=1;frame<5;frame++){
      const cut=tree.update(deep,a=>ready.has(cubeTileId(a)),frame);
      expect(levels(cut)).toEqual([1]);
      expect(cut.loading).toHaveLength(1);
      expect(new Set(cut.loading[0].map(cubeTileId))).toEqual(new Set(grandchildren.map(cubeTileId)));
    }
    grandchildren.forEach(a=>ready.add(cubeTileId(a)));
    expect(levels(tree.update(deep,a=>ready.has(cubeTileId(a)),5))).toEqual([2]);
    // Fast grandchildren cannot run ahead while other level-three pages load.
    expect(levels(tree.update(deep,a=>ready.has(cubeTileId(a)),6))).toEqual([2]);
    deep.forEach(a=>ready.add(cubeTileId(a)));
    expect(levels(tree.update(deep,a=>ready.has(cubeTileId(a)),7))).toEqual([3]);
  });
  it('publishes no partial sibling group under every out-of-order completion', () => {
    const permutations = <T>(a: T[]): T[][] => a.length ? a.flatMap((x,i) => permutations(a.filter((_,j) => i!==j)).map(p => [x,...p])) : [[]];
    for (const order of permutations(children)) {
      const tree = new ImageryRefinement(ids), ready = new Set([cubeTileId(root)]);
      const tick = (n: number) => tree.update(children, a => ready.has(cubeTileId(a)), n);
      expect(levels(tick(0))).toEqual([0]);
      for (let n=0;n<order.length;n++) {
        ready.add(cubeTileId(order[n]));
        const frame = tick(n+1);
        expect(levels(frame)).toEqual(n===3 ? [1] : [0]);
        expect(frame.cover).toHaveLength(n===3 ? 4 : 1);
      }
    }
  });
  it('stages intermediate levels before requesting desired deep leaves', () => {
    const tree = new ImageryRefinement(ids), ready = new Set([cubeTileId(root)]);
    const a = tree.update(grandchildren, p => ready.has(cubeTileId(p)), 1);
    expect(a.loading.flat().map(p=>p.level)).toEqual([1,1,1,1]);
    children.forEach(p=>ready.add(cubeTileId(p)));
    const b = tree.update(grandchildren, p=>ready.has(cubeTileId(p)), 2);
    expect(levels(b)).toEqual([1]);
    expect(b.loading).toHaveLength(1);
    expect(b.loading[0]).toHaveLength(16);
    expect(b.loading.flat().every(p=>p.level===2)).toBe(true);
  });
  it('does not depend on terrain tile identities or their replacement', () => {
    const tree = new ImageryRefinement(ids), ready = () => true;
    const before = tree.update(children,ready,1);
    const after = tree.update(children.map(a=>({...a})),ready,2);
    expect(after.cover).toEqual(before.cover);
    expect(after.loading).toEqual([]);
  });
  it('holds the same committed detail during rapid reversals and coarsens only to ready coverage', () => {
    const tree = new ImageryRefinement(ids, 10);
    tree.update(children,()=>true,0);
    for(let frame=1;frame<40;frame++) {
      expect(levels(tree.update(frame%2 ? [root] : children,()=>true,frame))).toEqual([1]);
    }
    expect(levels(tree.update([root],()=>true,60))).toEqual([0]);
  });
  it('bridges absent parents without requesting invented tiles', () => {
    const sparse = [cubeTileId(root),...grandchildren.map(cubeTileId)];
    const tree = new ImageryRefinement(sparse);
    const result = tree.update(grandchildren,a=>a.level===0,1);
    expect(levels(result)).toEqual([0]);
    expect(result.loading.flat().every(a=>a.level===2)).toBe(true);
    expect(levels(tree.update(grandchildren,()=>true,2))).toEqual([2]);
  });
  it('can traverse a missing root but establishes no false coverage', () => {
    const tree = new ImageryRefinement(grandchildren.map(cubeTileId));
    const first=tree.update(grandchildren,()=>false,0);
    expect(first.cover).toEqual([]);
    expect(first.loading.flat().every(a=>a.level===2)).toBe(true);
    expect(levels(tree.update(grandchildren,()=>true,1))).toEqual([2]);
  });
  it('keeps real fallback through failed intermediate tiles while descendants recover', () => {
    const tree = new ImageryRefinement(ids);
    const result = tree.update(grandchildren,a=>a.level===0,1,()=>true,a=>a.level===1);
    expect(levels(result)).toEqual([0]);
    expect(result.loading.flat().every(a=>a.level===2)).toBe(true);
    const recovered = tree.update(grandchildren,a=>a.level!==1,2,()=>true,a=>a.level===1);
    expect(levels(recovered)).toEqual([2]);
  });
  it('never uses a ready page on the wrong cube face at a seam', () => {
    const other = {...root,face:'px' as const}, otherChildren=imageryChildren(other);
    const tree = new ImageryRefinement([...ids,...[other,...otherChildren].map(cubeTileId)]);
    const frame = tree.update([...children,...otherChildren],a=>a.face==='py'||a.level===0,1);
    expect(frame.cover.filter(c=>c.patch.face==='py').every(c=>c.image.face==='py'&&c.image.level===0)).toBe(true);
    expect(frame.cover.filter(c=>c.patch.face==='px').every(c=>c.image.face==='px'&&c.image.level===0)).toBe(true);
    const recovered=tree.update([...children,...otherChildren],()=>true,2);
    expect(recovered.cover.every(c=>c.patch.face===c.image.face&&c.image.level===1)).toBe(true);
  });
  it('requests only visible replacement siblings while preserving their complete cover', () => {
    const tree = new ImageryRefinement(ids);
    const visible = (a: ImageryAddress) => a.level===0 || a.x===0;
    const result=tree.update(children,a=>a.level===0,1,visible);
    expect(result.loading.flat()).toHaveLength(2);
    expect(result.loading.flat().every(a=>a.x===0)).toBe(true);
    const complete=tree.update(children,a=>a.level===0||a.x===0,2,visible);
    expect(complete.cover).toHaveLength(2);
    expect(levels(complete)).toEqual([1]);
  });
  it('uses a geometric hysteresis band across slow threshold crossings',()=>{
    const tree=new ImageryRefinement(ids,10);tree.update(children,()=>true,1);
    expect(levels(tree.update([root],()=>true,100,()=>true,()=>false,()=>true))).toEqual([1]);
    expect(levels(tree.update([root],()=>true,105))).toEqual([1]);
    expect(levels(tree.update([root],()=>true,120))).toEqual([0]);
  });
});
