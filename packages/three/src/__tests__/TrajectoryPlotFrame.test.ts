import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Universe, WORLD_FRAME, type Vec3 } from '@cosmolabe/core';
import { TrajectoryPlotFrame } from '../TrajectoryPlotFrame.js';
import { TrajectoryCache } from '../TrajectoryCache.js';
import { TrajectoryLine } from '../TrajectoryLine.js';

function universe() {
  const u = new Universe();
  u.frames.register({ name: 'IAU_TEST', kind: 'body-fixed', isStatic: false, toICRF: t => {
    const c = Math.cos(t), s = Math.sin(t);
    return [c, -s, 0, s, c, 0, 0, 0, 1];
  } });
  return u;
}
describe('explicit trajectory plot reference frames', () => {
  it('advances a short-flight cache window instead of bridging seconds of curvature with one chord', () => {
    const u=universe();u.loadCatalog({items:[{name:'Probe',trajectory:{type:'FixedPoint',position:[0,0,0]}}]});
    const resolver=(_name:string,t:number):Vec3=>[t,t*t,0];
    const cache=TrajectoryCache.build(t=>resolver('Probe',t),0,10,{coarseInterval:.05,minInterval:.0125,coverageWindows:[{start:0,end:10}]});
    const line=new TrajectoryLine(u.getBody('Probe')!,{cache,fixedResolver:resolver,minTime:0,maxTime:10,trailDuration:300,cacheResampleInterval:.05});
    line.update(1,1);const first=line.drawnTrail().count;line.update(2,1);
    const path=line.drawnTrail();expect(path.count).toBeGreaterThan(first+2);
    expect(Array.from(path.times.slice(0,path.count)).some(t=>t>1.4&&t<1.6)).toBe(true);line.dispose();
  });

  it('places native XYZ path vertices at the current centre without a globe axis permutation', () => {
    const u=universe(),p=new TrajectoryPlotFrame(u,'IAU_TEST','BodyFixed','Test',t=>[3396,t*.01,t*.02],0);
    const object=new THREE.Object3D(),scale=1e-6,center:Vec3=[100,200,300];
    p.place(object,center,scale,5);
    const drawn=new THREE.Vector3(...p.resolve('p',1)).multiplyScalar(scale).applyMatrix4(object.matrixWorld);
    const expected=p.toWorld([3396,.01,.02],5).map((v,k)=>(v+center[k])*scale);
    expect(drawn.distanceTo(new THREE.Vector3(...expected))).toBeLessThan(1e-15);
  });

  it('keeps parked samples coincident and rotates the anchored path at current time', () => {
    const u = universe(), anchor: Vec3 = [3396, 0, 0];
    const plot = new TrajectoryPlotFrame(u, 'IAU_TEST', 'BodyFixed', 'Test', t => [3396, Math.min(t, 1) * .01, 0], 0);
    expect(plot.resolve('probe', 1)).toEqual([0, .01, 0]);
    expect(plot.resolve('probe', 100)).toEqual(plot.resolve('probe', 1));
    const local = plot.resolve('probe', 1);
    const current = plot.toWorld([anchor[0] + local[0], local[1], local[2]], 5);
    expect(current).toEqual(u.toWorldFrame([3396, .01, 0], 'IAU_TEST', 'Test', 5));
    expect(current).not.toEqual(u.toWorldFrame([3396, .01, 0], 'IAU_TEST', 'Test', 1));
  });
  it('transforms source epochs into the requested plot frame without mutating states', () => {
    const u = universe();
    const state = (t: number): Vec3 => u.toWorldFrame([3396, .01 * t, 0], 'IAU_TEST', 'Test', t);
    const p = new TrajectoryPlotFrame(u, WORLD_FRAME, 'BodyFixed', 'Test', state, 0);
    expect(p.resolve('probe', 1)[1]).toBeCloseTo(.01, 10);
    expect(p.resolve('probe', 2)[1]).toBeCloseTo(.02, 10);
  });
  it('samples short-flight curvature instead of replacing a flight with an endpoint chord', () => {
    const u = universe();
    const plot = new TrajectoryPlotFrame(u, 'IAU_TEST', 'BodyFixed', 'Test', t => [3396 + .01 * Math.sin(Math.PI * t), t * .001, 0], 0);
    const coarse = TrajectoryCache.build(t => plot.resolve('p', t), 0, 1, { coverageWindows: [{ start: 0, end: 1 }] });
    const fine = TrajectoryCache.build(t => plot.resolve('p', t), 0, 1, { coarseInterval: .05, minInterval: .0125, coverageWindows: [{ start: 0, end: 1 }] });
    expect(coarse.count).toBe(2);
    expect(fine.count).toBeGreaterThan(10);
    expect(Math.max(...Array.from({length: fine.count}, (_, i) => fine.positions[3*i]))).toBeCloseTo(.01, 9);
  });
});
