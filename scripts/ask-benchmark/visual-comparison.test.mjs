import {it,expect} from 'vitest';
import {comparisonEvidence} from './visual-comparison.mjs';
it('requires real orbit change, preserved time/range and resolved separated objects, not just in-frame receipts',()=>{
  const turn = position=>({state:{camera:{position,target:[0,0,0],up:[0,1,0]},et:1,playing:false,tracked:'A'},projection:{objects:[
    {object:'A',inView:true,drawEnabled:true,rangeKm:10,angularRadiusDeg:10,ndc:[0,0]},
    {object:'B',inView:true,drawEnabled:true,rangeKm:100,angularRadiusDeg:1,ndc:[0.7,0.4]},
  ]}});
  const before=turn([10,0,0]),after=turn([0,0,10]);
  expect(comparisonEvidence(before,before,'A','B').geometricGoalSupported).toBe(false);
  expect(comparisonEvidence(before,after,'A','B')).toMatchObject({geometricGoalSupported:true,orbitAngleDeg:90});
  after.projection.objects[1].angularRadiusDeg=0.001;
  expect(comparisonEvidence(before,after,'A','B').geometricGoalSupported).toBe(false);
});
