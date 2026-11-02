import { describe,it,expect,vi } from 'vitest';
import { createAgentTools } from './agent.js';
import { createCapabilityTools } from './capabilities.js';
import { FakeViewer } from './__tests__/fake-host.js';
import type { TrajectoryExtremaQuery,TrajectoryExtremaResponse } from '@cosmolabe/interop';

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
    h.navigateToAnalysisResult.mockImplementation(()=>{h.time=5;h.select('Titan');h.track('Titan');return true;});
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
