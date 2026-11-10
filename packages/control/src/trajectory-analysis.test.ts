import { describe,it,expect,vi } from 'vitest';
import { createAgentTools } from './agent.js';
import { createCapabilityTools } from './capabilities.js';
import { FakeViewer } from './__tests__/fake-host.js';
import type { TrajectoryExtremaQuery,TrajectoryExtremaResponse } from '@cosmolabe/interop';
import { runAgent, compactHistory } from './agent-loop.js';
import { checkAnswer } from './answer-check.js';

const query: TrajectoryExtremaQuery={objects:['Titan'],body:'Saturn',frame:'IAU_SATURN',metric:'radialHeightAboveReferenceSphere',extremum:'maximum',reference:{kind:'sphere',radiusKm:10},scope:{kind:'windows',windows:[{start:0,end:10}]},stepSeconds:1,timeToleranceSeconds:.01};
const response=(): TrajectoryExtremaResponse=>({status:'complete',faults:[],results:[{
  id:'peak',object:'Titan',activityId:null,activityName:null,body:'Saturn',frame:'IAU_SATURN',metric:query.metric,extremum:'maximum',value:2,units:'km',et:5,utc:'2000-01-01T12:00:05Z',
  location:{positionKm:[12,0,0],latitudeDeg:0,longitudeDeg:0,convention:'planetocentric'},datum:query.reference,heightConvention:'radial',window:{start:0,end:10},source:{id:'/private/secret/source',revision:'https://private/revision?token=secret',classification:'synthetic'},
  terrain:null,coverage:'sampled-complete',method:{guarantee:'sampled-and-locally-refined',stepSeconds:1,timeToleranceSeconds:.01,evaluations:20,heightErrorBoundKm:null,limits:'/private/secret/report'},
}]});
function host() {
  return Object.assign(new FakeViewer(),{
    findTrajectoryExtrema:vi.fn(async (_q: TrajectoryExtremaQuery)=>response()),
    navigateToAnalysisResult:vi.fn((_id:string)=>true),
  });
}
describe('shared height analysis agent boundary',()=>{
  it('invokes the typed service, projects only reviewed metadata and keeps numerical limits',async()=>{
    const h=host(),r=response();
    Object.assign(r.results[0],{secret:'/private/secret/path'});
    Object.assign(r.results[0].method,{endpoint:'https://private/?token=secret'});
    h.findTrajectoryExtrema.mockResolvedValue(r);
    const result=await createAgentTools(h).call('findTrajectoryExtrema',query);
    expect(result.ok).toBe(true);
    expect(h.findTrajectoryExtrema).toHaveBeenCalledWith(query,expect.objectContaining({signal:expect.anything()}));
    const json=JSON.stringify(result);
    expect(json).not.toContain('/private'); expect(json).not.toContain('token='); expect(json).not.toContain('endpoint');
    expect(result).toMatchObject({data:{status:'complete',results:[{source:{id:null,revision:null,classification:'synthetic'},method:{heightErrorBoundKm:null}}]}});
  });
  it('verifies measured epoch and vehicle after navigation rather than accepting a boolean alone',async()=>{
    const h=host(),tools=createAgentTools(h);
    await tools.call('findTrajectoryExtrema',query);
    expect(await tools.call('navigateToAnalysisResult',{resultId:'peak'})).toMatchObject({ok:false,code:'failed'});
    h.navigateToAnalysisResult.mockImplementation(()=>{h.time=5;h.emit('time',{et:5,cause:'host'});h.emit('playback',{playing:false,rate:1});h.select('Titan');h.track('Titan');return true;});
    expect(await tools.call('navigateToAnalysisResult',{resultId:'peak'})).toMatchObject({ok:true,data:{verified:true,observed:{et:5,object:'Titan',tracked:'Titan'}}});
    tools.dispose();
  });
  it('rejects malformed requests before invoking the engine',async()=>{
    const h=host(),tools=createAgentTools(h);
    expect(await tools.call('findTrajectoryExtrema',{...query,metric:'altitude'})).toMatchObject({ok:false,code:'invalid-input'});
    expect(await tools.call('findTrajectoryExtrema',{...query,objects:[]})).toMatchObject({ok:false,code:'invalid-input'});
    expect(h.findTrajectoryExtrema).not.toHaveBeenCalled();
  });
  it('preserves manual takeover and host time ownership for Show me',async()=>{
    const h=host(),tools=createAgentTools(h),task=tools.begin();
    h.emit('cameraInput',{});
    expect(await task.call('navigateToAnalysisResult',{resultId:'peak'})).toMatchObject({ok:false,code:'interrupted'});
    expect(h.navigateToAnalysisResult).not.toHaveBeenCalled(); tools.dispose();
    const cameraOwned=createAgentTools(h,{omittedTools:{frameObject:'Host owns the camera'}});
    expect(await cameraOwned.call('navigateToAnalysisResult',{resultId:'peak'})).toMatchObject({ok:false,code:'refused'});cameraOwned.dispose();
    const restricted=createAgentTools(h,{omittedTools:{setTime:'Host owns the clock'}});
    expect(await restricted.call('navigateToAnalysisResult',{resultId:'peak'})).toMatchObject({ok:false,code:'refused'});
    const capabilities=createCapabilityTools(h,{omitted:{'time.setTime':'Host owns the clock'}});
    expect(capabilities.listCapabilities({domain:'analysis'}).items.find(c=>c.id==='analysis.navigateToAnalysisResult')).toMatchObject({available:false,reason:expect.stringContaining('Host owns the clock')});
    capabilities.dispose(); restricted.dispose();
  });
  it('does not return a late numerical result after scene replacement or cancellation',async()=>{
    const h=host(); let finish!:(value:TrajectoryExtremaResponse)=>void;
    h.findTrajectoryExtrema.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const tools=createAgentTools(h),task=tools.begin();
    const pending=task.call('findTrajectoryExtrema',query);
    h.scene={id:2,catalog:'Other',ready:true};h.emit('load',{objects:[]});finish(response());
    expect(await pending).toMatchObject({ok:false,code:'stale'});
    const next=tools.begin(),cancelled=next.call('findTrajectoryExtrema',query);next.cancel();finish(response());
    expect(await cancelled).toMatchObject({ok:false,code:'cancelled'});
    tools.dispose();
  });
});


it('refuses unknown, superseded and scene-stale analysis IDs before host navigation',async()=>{
  const h=host(),tools=createAgentTools(h);
  expect(await tools.call('navigateToAnalysisResult',{resultId:'foreign'})).toMatchObject({ok:false,code:'refused'});
  expect(h.navigateToAnalysisResult).not.toHaveBeenCalled();
  await tools.call('findTrajectoryExtrema',query);
  const next=response();next.results[0].id='next';h.findTrajectoryExtrema.mockResolvedValue(next);
  await tools.call('findTrajectoryExtrema',query);
  expect(await tools.call('navigateToAnalysisResult',{resultId:'peak'})).toMatchObject({ok:false,code:'refused'});
  h.emit('load',{objects:[]});
  expect(await tools.call('navigateToAnalysisResult',{resultId:'next'})).toMatchObject({ok:false});
  expect(h.navigateToAnalysisResult).not.toHaveBeenCalled();tools.dispose();
});


it('keeps scientific height results in the modern Event Finder transport without leaking source metadata',async()=>{
  const {eventPageMetadata}=await import('./event-agent-metadata.js');
  const r=response().results[0];
  const page={status:'ready' as const,total:1,offset:0,nextOffset:null,query:{status:'available' as const,definition:null,coverage:null,error:null,provenance:{source:'authoritative-trajectories' as const,kernelRevision:0,kernelCount:0,contextFrame:'IAU_SATURN',calculationFrames:['IAU_SATURN'],timeUnit:'ET seconds past J2000' as const,stepUnit:'s' as const,abcorr:'NONE',limitations:[]}},items:[{reference:{scene:1,query:'q',id:r.id,revision:1},event:{id:r.id,queryId:'q',kind:'trajectory-extremum',label:r.object,bodies:{observer:r.object,center:r.body},temporality:'instant' as const,et:r.et,metrics:[{key:r.metric,label:'Radial sphere height',value:r.value,unit:'km'}],trajectoryAnalysis:r}}]};
  const transport=eventPageMetadata(page,()=>null);
  expect(transport).toMatchObject({query:{provenance:{source:'authoritative-trajectories'}},items:[{metrics:[{key:r.metric,value:2,unit:'km'}],trajectoryAnalysis:{object:'Titan',source:{id:null,revision:null}}}]});
  expect(JSON.stringify(transport)).not.toContain('/private');expect(JSON.stringify(transport)).not.toContain('token=');
});

describe('routine extrema task boundary',()=>{
  const options={available:true,truncated:false,subjects:[{object:'Titan',bodies:['Saturn'],activities:72,activityKinds:['flight']}],bodies:[{body:'Saturn',frame:'IAU_SATURN',metrics:[{metric:'reference-sphere-height' as const,available:true,reason:null}]}]};
  const intent={objects:['Titan'],metric:'reference-sphere-height',extremum:'maximum',scope:{kind:'activities',activityKind:'flight'}};
  function taskHost() {
    return Object.assign(host(),{getTrajectoryAnalysisOptions:()=>options,analyzeTrajectoryExtrema:vi.fn(async()=>({status:'complete' as const,body:'Saturn',reason:null,message:'/private/secret',started:true,query,scope:{requested:1,completed:1,activityIds:['flight:1']},options,response:response(),winnerId:'peak',candidateId:'peak',coverage:{assessed:true,incompleteIntervals:0,maximumGapSeconds:0}}))});
  }
  it('delivers bounded full-scope comparison and winner provenance without source/frame leakage',async()=>{
    const h=taskHost();const r=response();
    r.results=Array.from({length:72},(_,i)=>({...r.results[0],id:i===0?'peak':`p${i}`,activityId:`flight:${i}`}));
    h.analyzeTrajectoryExtrema.mockResolvedValue({...await h.analyzeTrajectoryExtrema(),response:r,scope:{requested:72,completed:72,activityIds:r.results.map(r=>r.activityId!)}});
    const tools=createAgentTools(h),result=await tools.call('analyzeTrajectoryExtrema',intent);
    expect(result).toMatchObject({ok:true,data:{status:'complete',scope:{requested:72,completed:72},comparedCount:72,winnerId:'peak',winner:{method:{heightErrorBoundKm:null},source:{id:null}}}});
    expect(JSON.stringify(result)).not.toContain('/private');expect(JSON.stringify(result)).not.toContain('token=');
    expect(JSON.stringify(result).length).toBeLessThan(6000);
    expect((result as {data:{compared:unknown[]}}).data.compared.length).toBeLessThanOrEqual(3);
    tools.dispose();
  });
  it('blocks equivalent expert/task retries within one request, retaining the actual reason',async()=>{
    const h=taskHost();h.analyzeTrajectoryExtrema.mockResolvedValue({...await h.analyzeTrajectoryExtrema(),status:'unavailable',reason:'data-unavailable',response:null,winnerId:null} as never);
    const tools=createAgentTools(h),task=tools.begin();
    expect(await task.call('analyzeTrajectoryExtrema',intent)).toMatchObject({ok:true,data:{reason:'data-unavailable'}});
    expect(await task.call('findTrajectoryExtrema',{...query,frame:'IAU_MOON'})).toMatchObject({ok:false,facts:[{kind:'height-analysis',message:expect.stringContaining('data did not cover')}]});
    expect(h.findTrajectoryExtrema).not.toHaveBeenCalled();expect(h.analyzeTrajectoryExtrema).toHaveBeenCalledTimes(2); // one fixture read, one execution
    tools.dispose();
  });
  it('makes capability families scene-specific and respects underlying host omissions',async()=>{
    const h=taskHost(),tools=createAgentTools(h);
    expect(await tools.call('describeScene',{})).toMatchObject({data:{analysis:{subjects:[{activities:72}]}}});
    tools.dispose();
    const restricted=createCapabilityTools(h,{omitted:{'analysis.findTrajectoryExtrema':'Host disables numerical work'}});
    expect(restricted.listCapabilities({domain:'analysis'}).items.find(c=>c.id==='analysis.analyzeTrajectoryExtrema')).toMatchObject({available:false});
    restricted.dispose();
  });
  it('retains measured IDs across user turns but refuses late scene replacement and manual navigation takeover',async()=>{
    const h=taskHost(),tools=createAgentTools(h);
    await tools.call('analyzeTrajectoryExtrema',intent);
    h.navigateToAnalysisResult.mockImplementation(()=>{h.time=5;h.select('Titan');h.track('Titan');return true;});
    expect(await tools.call('navigateToAnalysisResult',{resultId:'peak'})).toMatchObject({ok:true});
    const task=tools.begin();h.emit('cameraInput',{});
    expect(await task.call('navigateToAnalysisResult',{resultId:'peak'})).toMatchObject({code:'interrupted'});
    tools.dispose();
  });
  it('ends an equivalent retry after two model rounds with the actual scientific limitation',async()=>{
    const h=taskHost(),data={...await h.analyzeTrajectoryExtrema(),status:'unavailable',reason:'data-unavailable',response:null,winnerId:null};
    h.analyzeTrajectoryExtrema.mockResolvedValue(data as never);h.analyzeTrajectoryExtrema.mockClear();
    const tools=createCapabilityTools(h,{surface:'fixed'});let rounds=0;
    const run=await runAgent({tools,prompt:'show the highest flight',transport:{send:async()=>({stop:'tool_use',content:[{type:'tool_use',id:`call-${++rounds}`,name:'analyzeTrajectoryExtrema',input:intent}]})}});
    expect(rounds).toBe(2);expect(h.analyzeTrajectoryExtrema).toHaveBeenCalledTimes(1);
    expect(run.outcome.kind).toBe('done');expect(run.answer).toContain('relative-state or physical-terrain data did not cover');
    expect(run.answer).toContain('no collection winner');expect(h.navigateToAnalysisResult).not.toHaveBeenCalled();tools.dispose();
  });
  it('keeps exact native result ID and scientific context through follow-up compaction',async()=>{
    const h=taskHost(),tools=createAgentTools(h),result=await tools.call('analyzeTrajectoryExtrema',intent);
    const history=compactHistory([{role:'user',content:[{type:'text',text:'highest flight'}]},{role:'assistant',content:[{type:'tool_use',id:'h',name:'analyzeTrajectoryExtrema',input:intent}]},{role:'user',content:[{type:'tool_result',toolUseId:'h',content:JSON.stringify(result),isError:false}]},{role:'assistant',content:[{type:'text',text:'A sampled result is available.'}]}]);
    expect(history[1].content).toEqual(expect.arrayContaining([expect.objectContaining({text:expect.stringContaining('"winnerId"')})]));expect(JSON.stringify(history)).toContain('peak');
    expect(checkAnswer('This is the certified global maximum.',result.facts!)).not.toEqual([]);
    tools.dispose();
  });
});

it('bounds invalid numerical inputs through the public capability bridge and skips later batch work',async()=>{
  const h=Object.assign(host(),{analyzeTrajectoryExtrema:vi.fn()});
  const tools=createCapabilityTools(h,{surface:'fixed'});let rounds=0;
  const run=await runAgent({tools,prompt:'highest height',transport:{send:async()=>{rounds++;return {stop:'tool_use',content:[
    {type:'tool_use',id:'bad-1',name:'analyzeTrajectoryExtrema',input:{objects:[]}},
    {type:'tool_use',id:'bad-2',name:'analyzeTrajectoryExtrema',input:{metric:'bad'}},
    {type:'tool_use',id:'late',name:'findTrajectoryExtrema',input:query},
  ]};}}});
  expect(rounds).toBe(1);expect(h.analyzeTrajectoryExtrema).not.toHaveBeenCalled();expect(h.findTrajectoryExtrema).not.toHaveBeenCalled();
  expect(run.outcome.kind).toBe('done');expect(run.answer).toContain('failed validation twice');tools.dispose();
});

it('distinguishes all available interval candidates from only the gap-free subset in answers',()=>{
  const fact={kind:'height-analysis' as const,status:'partial',message:'partial',requested:72,completed:17,evaluated:72,metric:'heightAboveReferenceEllipsoid',winner:null};
  expect(checkAnswer('This is the highest of the 17 flights analyzed without gaps, not a verified winner across all 72.',[fact])).toContainEqual(expect.stringContaining('all 72 returned interval candidates'));
  expect(checkAnswer('This is the highest available sampled candidate across 72 flights; 17 have no gaps, and 55 have endpoint gaps. No full-scope winner is established.',[fact])).toEqual([]);
  expect(checkAnswer('The authored view is at 2014-11-08, more precisely 2014-11-12.',[{kind:'authored-viewpoint',name:'fixture',utc:'2014-11-12T08:35:40Z'}])).toContainEqual(expect.stringContaining('no authored viewpoint date'));
});

it('does not treat a preflight datum question as a claim to a computed collection maximum',()=>{
  const fact={kind:'height-analysis' as const,status:'clarification',message:'Which height basis?',requested:72,completed:0,evaluated:0,metric:'elevation',winner:null};
  expect(checkAnswer('Should I measure the maximum across all 72 flights above the reference ellipsoid or above physical terrain?',[fact])).toEqual([]);
});

it('requires declared estimated or synthetic source provenance with a numerical height answer',()=>{
  const fact={kind:'height-analysis' as const,status:'partial',message:'partial',requested:72,completed:17,evaluated:72,metric:'heightAboveReferenceEllipsoid',winner:null,sourceKind:'estimated-reconstruction' as const};
  expect(checkAnswer('The sampled candidate is -2.04 km; no full-scope winner is established.',[fact])).toContainEqual(expect.stringContaining('estimated reconstruction'));
  expect(checkAnswer('The sampled candidate is -2.04 km from an estimated reconstruction; no full-scope winner is established.',[fact])).toEqual([]);
});

it('does not turn a bounded entity-resolution activity sample into the full collection count',async()=>{
  const h=host();Object.assign(h,{listActivities:()=>Array.from({length:72},(_,i)=>({id:`titan:flight:${i}`,name:`Flight ${i}`,kind:'flight',vehicle:'Titan',enabled:true}))});
  const tools=createAgentTools(h),r=await tools.call('resolve',{query:'Titan'});
  expect(r).toMatchObject({data:{activityMatches:{total:72,returned:8,complete:false}}});
  expect(checkAnswer('I will compare all 8 Titan flights.',r.facts!)).toContainEqual(expect.stringContaining('72 requested intervals'));
  expect(checkAnswer('I will compare all 72 Titan flights.',r.facts!)).toEqual([]);tools.dispose();
});
