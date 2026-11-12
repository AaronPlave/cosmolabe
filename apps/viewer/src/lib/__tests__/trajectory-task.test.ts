import { afterEach, describe, expect, it, vi } from 'vitest';
import { Body, FixedPointTrajectory, FixedRotation, InterpolatedStatesTrajectory, Universe, parseXyzv, type MissionActivity } from '@cosmolabe/core';
import type { ScriptExtremaRequest } from '@cosmolabe/control';
const runtime = vi.hoisted(() => ({ universe: null as Universe | null, renderer: null as unknown }));
vi.mock('../viewer-state.svelte', async original => ({ ...await original<typeof import('../viewer-state.svelte')>(), getSceneUniverse:()=>runtime.universe, getRenderer:()=>runtime.renderer }));
vi.mock('../loader', async original => ({ ...await original<typeof import('../loader')>(), getUniverse:()=>runtime.universe }));
import { analyzeTrajectoryExtrema, findViewerTrajectoryExtrema, getTrajectoryAnalysisOptions, runTrajectoryEventQuery } from '../trajectory-analysis.svelte';
import { resolveExtremaTask } from '../trajectory-task';
import { ef, openConfiguredQuery, resetForScene, runSearch } from '../event-finder.svelte';
import { analysis } from '../analysis.svelte';

afterEach(()=>{ runtime.renderer=null; resetForScene(); runtime.universe=null; });
function scene(count=3) {
  const u=new Universe();
  u.addBody(new Body({name:'Moon',radii:[10,10,10],trajectory:new FixedPointTrajectory([0,0,0]),rotation:new FixedRotation([1,0,0,0],'ECLIPJ2000','IAU_MOON')}));
  u.addBody(new Body({name:'hopper',parentName:'Moon',description:'Estimated reconstruction, not telemetry',trajectory:new InterpolatedStatesTrajectory([
    {et:0,position:[11,0,0],velocity:[0,0,0]},{et:10,position:[13,0,0],velocity:[0,0,0]},
    {et:20,position:[12,0,0],velocity:[0,0,0]},{et:30,position:[12,0,0],velocity:[0,0,0]},
  ],{frame:'IAU_MOON'})}));
  const activities:MissionActivity[]=Array.from({length:count},(_,i)=>({version:1,id:`flight:${i}`,name:`Flight ${i}`,kind:'flight',vehicle:'hopper',body:'Moon',temporality:'interval',start:i*10,end:(i+1)*10,provenance:{source:'fixture',version:'v1',authority:'estimated',timing:'estimated',limitations:'test'}}));
  u.activities.replace('fixture',activities);runtime.universe=u;
  runtime.renderer={getBodyMesh:()=>undefined,setEventResults:()=>{},setEventPreview:()=>{}};
  return u;
}
const request:ScriptExtremaRequest={objects:['hopper'],metric:'reference-sphere-height',extremum:'maximum',scope:{kind:'activities',activityKind:'flight'}};
describe('native routine extrema resolution',()=>{
  it('asks one datum question without running or choosing an AGL substitute',async()=>{
    scene();
    const result=await analyzeTrajectoryExtrema({...request,metric:'elevation'});
    expect(result).toMatchObject({status:'clarification',reason:'ambiguous-metric',started:false,query:null,scope:{requested:3},winnerId:null});
    expect(result.options.bodies[0].metrics).toContainEqual(expect.objectContaining({metric:'terrain-clearance',available:false}));
  });
  it('resolves the full unpaged collection and uses existing sampled/refined results',async()=>{
    scene();
    const r=await analyzeTrajectoryExtrema(request);
    expect(r).toMatchObject({status:'complete',started:true,query:{frame:'IAU_MOON',reference:{kind:'sphere',radiusKm:10},sampling:'adaptive',maxEvaluations:200000},scope:{requested:3,completed:3,activityIds:['flight:0','flight:1','flight:2']}});
    expect(r.response?.results).toHaveLength(3);
    const winner=r.response!.results.find(v=>v.id===r.winnerId)!;
    expect(winner.value).toBeCloseTo(3);expect(winner.et).toBeCloseTo(10);
    expect(winner.source.description).toContain('Estimated');
    expect(winner.method.heightErrorBoundKm).toBeNull();
  });
  it('reports real collection work without equating finished intervals with completeness',async()=>{
    scene(4);
    const progress: {completedIntervals:number;totalIntervals:number;evaluations:number}[]=[];
    const r=await analyzeTrajectoryExtrema(request,{onProgress:(_f,work)=>{if(work)progress.push(work);}});
    expect(progress[0]).toEqual({completedIntervals:0,totalIntervals:4,evaluations:0});
    expect(progress.at(-1)?.completedIntervals).toBe(4);
    expect(progress.at(-1)?.evaluations).toBe(r.response!.results.reduce((n,r)=>n+r.method.evaluations,0));
    expect(progress.every((p,i)=>!i || p.evaluations>=progress[i-1].evaluations && p.completedIntervals>=progress[i-1].completedIntervals)).toBe(true);
    expect(r.winnerId).toBeNull();
  });
  it('keeps missing intervals partial and refuses a collection winner',async()=>{
    scene(4); // Fourth interval extends beyond trajectory coverage.
    const r=await analyzeTrajectoryExtrema(request);
    expect(r.status).toBe('partial');expect(r.scope.requested).toBe(4);
    expect(r.scope.completed).toBeLessThan(4);expect(r.winnerId).toBeNull();
  });
  it('does not silently truncate more than 128 activities or ignore an unmatched explicit ID',async()=>{
    scene(129);
    expect(await analyzeTrajectoryExtrema(request)).toMatchObject({reason:'work-budget',started:false,scope:{requested:129}});
    expect(await analyzeTrajectoryExtrema({...request,scope:{kind:'activities',ids:['flight:0','missing']}})).toMatchObject({reason:'invalid-scope',started:false});
  });
  it('separates compatible operation with absent states from unsupported physical data',async()=>{
    const u=scene();
    u.activities.replace('fixture',u.activities.list().map(a=>({...a,start:100,end:110})));
    expect(await analyzeTrajectoryExtrema(request)).toMatchObject({reason:'data-unavailable',started:false});
    expect(await analyzeTrajectoryExtrema({...request,metric:'terrain-clearance'})).toMatchObject({reason:'data-unavailable',started:false});
  });
  it('excludes parked/disabled activities and never derives scope from current timeline',async()=>{
    const u=scene();
    u.activities.replace('fixture',u.activities.list().map((a,i)=>({...a,...(i===1?{kind:'landing'}:i===2?{enabled:false}:{})})));
    const r=await analyzeTrajectoryExtrema(request);
    expect(r.scope.activityIds).toEqual(['flight:0']);expect(r.scope.requested).toBe(1);
    const explicit=await findViewerTrajectoryExtrema({...r.query!,scope:{kind:'activities',activityKind:'flight',window:{start:0,end:9}}});
    expect(explicit.results.map(r=>[r.activityId,r.window])).toEqual([['flight:0',{start:0,end:9}]]);
  });
  it('rejects malformed windows and honors cancellation before execution',async()=>{
    scene();
    expect(await analyzeTrajectoryExtrema({...request,scope:{kind:'windows',windows:[]}})).toMatchObject({reason:'invalid-scope',started:false});
    expect(await analyzeTrajectoryExtrema(request,{signal:{aborted:true}})).toMatchObject({status:'cancelled',started:false,winnerId:null});
  });
  it('does not guess a central body for mixed-body activity comparisons',()=>{
    const u=scene();
    u.addBody(new Body({name:'Mars',radii:[20,20,20],trajectory:new FixedPointTrajectory([0,0,0])}));
    u.activities.replace('fixture',u.activities.list().map((a,i)=>({...a,body:i===1?'Mars':'Moon'})));
    expect(resolveExtremaTask(u,request,getTrajectoryAnalysisOptions(),()=>({reference:{kind:'sphere',radiusKm:10}}))).toMatchObject({reason:'ambiguous-body',started:false});
  });
  it('evaluates a dense collection beyond a single solver budget without hiding endpoint gaps',async()=>{
    const u=scene(72);
    // More than 200,000 mandatory subdivisions across the collection. Each
    // source segment remains represented; increasing model retries is no help.
    const records=Array.from({length:57601},(_,i)=>({et:i/80,position:[11+i/57600,0,0] as [number,number,number],velocity:[1/720,0,0] as [number,number,number]}));
    u.addBody(new Body({name:'hopper',parentName:'Moon',trajectory:new InterpolatedStatesTrajectory(records,{frame:'IAU_MOON'})}));
    const r=await analyzeTrajectoryExtrema(request);
    expect(r.status).toBe('complete');expect(r.scope.completed).toBe(72);expect(r.response?.results).toHaveLength(72);
    expect(r.response!.results.reduce((n,r)=>n+r.method.evaluations,0)).toBeLessThanOrEqual(1000000);
    expect(r.response!.results.find(v=>v.id===r.winnerId)?.value).toBeCloseTo(2);
    const canonical=(response:NonNullable<typeof r.response>)=>response.results.map(({id:_,...value})=>value).sort((a,b)=>a.activityId!.localeCompare(b.activityId!));
    const expert=await findViewerTrajectoryExtrema(r.query!);
    const native=await runTrajectoryEventQuery({id:'native',kind:'trajectory-extremum',bodies:{center:'Moon',observer:'hopper'},window:{start:0,end:720},step:.1,params:{metric:'radialHeightAboveReferenceSphere',extremum:'maximum',scope:'activities',activityKind:'flight',timeToleranceSeconds:.005,sampling:'adaptive'}},{});
    expect(canonical(expert)).toEqual(canonical(r.response!));
    expect(canonical(native)).toEqual(canonical(r.response!));
  },30000);
  it('reruns the original typed scope from the native form until the user edits it',async()=>{
    scene();
    const r=await analyzeTrajectoryExtrema({...request,scope:{kind:'activities',ids:['flight:1']}});
    const item=analysis.items.find(item=>item.type==='event-query')!;
    openConfiguredQuery(item.id);
    await runSearch();
    expect(item.query.trajectoryAnalysis).toEqual(r.query);
    expect(ef.fault).toBeNull();
    expect(analysis.eventResults[item.id].map(e=>e.trajectoryAnalysis?.activityId)).toEqual(['flight:1']);
    ef.form!.params.scope='window';
    await runSearch();
    expect(item.query.trajectoryAnalysis).toBeUndefined();
    expect(analysis.eventResults[item.id].map(e=>e.trajectoryAnalysis?.activityId)).toEqual([null]);
  });
  it('retains disjoint windows and the explicit numerical cap on configured reruns',async()=>{
    const u=scene();
    const ready=resolveExtremaTask(u,{...request,scope:{kind:'windows',windows:[{start:0,end:2},{start:18,end:20}]}},getTrajectoryAnalysisOptions(),()=>({reference:{kind:'sphere',radiusKm:10}}));
    const query={...ready.query!,maxEvaluations:1000};
    const original=await findViewerTrajectoryExtrema(query);
    const item=analysis.items.find(item=>item.type==='event-query')!;
    openConfiguredQuery(item.id);
    await runSearch();
    expect(ef.fault).toBeNull();
    expect(item.query.trajectoryAnalysis).toEqual(query);
    expect(analysis.eventResults[item.id].map(e=>e.trajectoryAnalysis!.window)).toEqual([{start:0,end:2},{start:18,end:20}]);
    expect(analysis.eventResults[item.id].map(e=>e.trajectoryAnalysis!.method.evaluations)).toEqual(original.results.map(r=>r.method.evaluations));
  });
  it('publishes source-encoding reconciliation separately from numerical and sampled completeness',async()=>{
    const u=scene(1),start=672089519.3,end=672089558.4;
    const records=parseXyzv([start,end].map(t=>`${(t/86400+2451545).toFixed(12)} 12 0 0 0 0 0`).join('\n'));
    u.addBody(new Body({name:'hopper',parentName:'Moon',trajectory:new InterpolatedStatesTrajectory(records,{frame:'IAU_MOON'})}));
    u.activities.replace('fixture',u.activities.list().map(a=>({...a,start,end})));
    const r=await analyzeTrajectoryExtrema(request);
    expect(r).toMatchObject({status:'complete',scope:{evaluated:1,completed:1},coverage:{completeIntervals:1,incompleteIntervals:0,maximumGapSeconds:0,endpointReconciledIntervals:1,unavailableSampleIntervals:0},numerical:{completeIntervals:1,budgetLimitedIntervals:0}});
    expect(r.winnerId).toBeTruthy();
    expect(r.response!.results[0].completeness?.endpointReconciliations.length).toBeGreaterThan(0);
  });
  it('reports actual tiny endpoint gaps and all available candidates separately from a winner',async()=>{
    const u=scene(1);
    u.addBody(new Body({name:'hopper',parentName:'Moon',trajectory:new InterpolatedStatesTrajectory([
      {et:.00002,position:[11,0,0],velocity:[0,0,0]},{et:9.99998,position:[12,0,0],velocity:[0,0,0]},
    ],{frame:'IAU_MOON'})}));
    const r=await analyzeTrajectoryExtrema(request);
    expect(r).toMatchObject({status:'partial',winnerId:null,scope:{requested:1,completed:0},coverage:{assessed:true,incompleteIntervals:1}});
    expect(r.coverage.maximumGapSeconds).toBeCloseTo(.00002,8);expect(r.candidateId).toBeTruthy();
    expect(r.response?.results).toHaveLength(1);expect(r.response!.results[0].window).toEqual({start:0,end:10});
  });
  it('probes known covered pieces inside a broad requested window rather than rejecting their unsampled envelope',async()=>{
    const u=scene(1);
    u.addBody(new Body({name:'hopper',parentName:'Moon',trajectory:new InterpolatedStatesTrajectory([
      {et:20,position:[11,0,0],velocity:[0,0,0]},{et:30,position:[12,0,0],velocity:[0,0,0]},
    ],{frame:'IAU_MOON'})}));
    const r=await analyzeTrajectoryExtrema({...request,scope:{kind:'windows',windows:[{start:0,end:100}]}});
    expect(r).toMatchObject({started:true,status:'partial',winnerId:null,scope:{requested:1,completed:0}});
    expect(r.candidateId).toBeTruthy();expect(r.response?.results[0].et).toBeGreaterThanOrEqual(20);
  });
});
