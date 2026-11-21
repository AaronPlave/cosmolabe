import { describe, expect, it } from 'vitest';
import { checkZoom } from './place-label-motion.mjs';
const sample=(rangeKm,accepted,opacity)=>({rangeKm,handoffs:0,labels:opacity===null?[]:[{id:'name',accepted,opacity,x:10,y:10,width:40,height:12}]});
const result=samples=>({phase:'zoom with pan',samples});
describe('on-screen label motion acceptance',()=>{
 it('measures the unchanged 1.25 scale threshold from ownership loss, independently of fade duration',()=>{
  expect(()=>checkZoom(result([sample(250,true,.85),sample(290,false,.8),sample(397,false,.17),sample(408,false,.11),sample(420,false,.05),sample(433,false,null),sample(471,true,.05),sample(485,true,.12)]))).not.toThrow();
 });
 it('still rejects a short collision loss and return',()=>{
  expect(()=>checkZoom(result([sample(2076,true,.8),sample(1987,false,.6),sample(1742,false,.04),sample(1667,true,.2)]))).toThrow(/without meaningful zoom change/);
 });
 it('still rejects an unexplained opacity blink while accepted',()=>{
  expect(()=>checkZoom(result([sample(500,true,.8),sample(510,true,.05),sample(520,true,.8)]))).toThrow(/without meaningful zoom change/);
 });
 it('does not reuse an old ownership loss to excuse a later opacity blink',()=>{
  expect(()=>checkZoom(result([sample(100,true,.8),sample(110,false,.7),sample(160,true,.8),sample(170,true,.8),sample(180,true,.05),sample(190,true,.8)]))).toThrow(/without meaningful zoom change/);
 });
});
