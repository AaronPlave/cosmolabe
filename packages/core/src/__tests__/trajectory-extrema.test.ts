import { describe, expect, it, vi } from 'vitest';
import { findTrajectoryExtrema, trajectoryExtremumEvent, type TrajectoryAnalysisProvider, type TrajectoryExtremaQuery } from '../geometry/trajectory-extrema.js';
import { WaypointTrajectory } from '../trajectories/WaypointTrajectory.js';

const query = (patch: Partial<TrajectoryExtremaQuery> = {}): TrajectoryExtremaQuery => ({ objects: ['drone'], body: 'Moon', frame: 'MOON_ME_DE421', metric: 'radialHeightAboveReferenceSphere', extremum: 'maximum', reference: { kind: 'sphere', radiusKm: 10 }, scope: { kind: 'windows', windows: [{ start: 0, end: 10 }] }, stepSeconds: 1, timeToleranceSeconds: .0001, ...patch });
function provider(position: (et: number) => readonly [number,number,number] | null): TrajectoryAnalysisProvider {
  return { activities: [], revision: () => 1, source: () => ({ id: 'fixture', revision: 'v1', classification: 'synthetic' }), position: (_,et) => position(et) };
}

describe('shared trajectory height extrema', () => {
  it.each([86400, 30 * 86400, 365 * 86400])('adapts a %i-second default window without rejecting long segments', async duration => {
    const p = provider(t => [14 - ((t / duration - .4137) ** 2), 0, 0]);
    const r = await findTrajectoryExtrema(query({ sampling: 'adaptive', stepSeconds: .1, scope: { kind: 'windows', windows: [{ start: 0, end: duration }] } }), p);
    expect(r.status).toBe('complete');
    expect(r.results[0].et / duration).toBeCloseTo(.4137, 6);
    expect(r.results[0].value).toBeCloseTo(4, 10);
    expect(r.results[0].method.evaluations).toBeLessThan(5000);
    expect(r.results[0].method.stepSeconds).toBeGreaterThan(.1);
    expect(r.results[0].method.heightErrorBoundKm).toBeNull();
  });
  it('uses declared periods and retains a short source segment in a year-long search', async () => {
    const duration = 365 * 86400, peak = 200 * 86400;
    const p = provider(t => [12 + Math.max(0, 1 - ((t - peak) / .1) ** 2), 0, 0]);
    p.knots = () => [peak - .1, peak + .1];
    const r = await findTrajectoryExtrema(query({ sampling: 'adaptive', scope: { kind: 'windows', windows: [{ start: 0, end: duration }] } }), p);
    expect(r.status).toBe('complete');
    expect(r.results[0].et).toBeCloseTo(peak, 4);
    expect(r.results[0].value).toBeCloseTo(3, 7);
    const orbit = provider(t => [12 + Math.cos(2 * Math.PI * (t - 123) / 5400), 0, 0]);
    orbit.period = () => 5400;
    const day = await findTrajectoryExtrema(query({ sampling: 'adaptive', scope: { kind: 'windows', windows: [{ start: 0, end: 86400 }] } }), orbit);
    expect(day.status).toBe('complete');
    expect(day.results[0].value).toBeCloseTo(3, 8);
    expect(day.results[0].method.stepSeconds).toBeLessThanOrEqual(5400 / 32);
  });
  it('keeps fixed steps explicit and returns partial candidates when the budget cannot meet them', async () => {
    const p = provider(t => [12 + t / 86400, 0, 0]);
    const q = query({ scope: { kind: 'windows', windows: [{ start: 0, end: 86400 }] }, stepSeconds: .1, maxEvaluations: 100 });
    const fixed = await findTrajectoryExtrema(q, p);
    expect(fixed).toMatchObject({ status: 'partial', results: [{ coverage: 'partial' }], faults: [{ code: 'budget' }] });
    expect(fixed.results[0].method.evaluations).toBeLessThanOrEqual(100);
    const insufficient = await findTrajectoryExtrema({ ...q, sampling: 'adaptive', maxEvaluations: 2 }, p);
    expect(insufficient).toMatchObject({ status: 'partial', results: [{ coverage: 'partial' }], faults: [{ code: 'budget' }] });
  });
  it.each([[86400, 5400], [30 * 86400, 5400], [365 * 86400, 86400]])('samples periodic sources over %i seconds using their %i-second period', async (duration, period) => {
    const p = provider(t => [12 + Math.cos(2 * Math.PI * (t - 123) / period), 0, 0]);
    p.period = () => period;
    const r = await findTrajectoryExtrema(query({ sampling: 'adaptive', stepSeconds: .1, timeToleranceSeconds: .005, scope: { kind: 'windows', windows: [{ start: 0, end: duration }] } }), p);
    expect(r.status).toBe('complete');
    expect(r.results[0].value).toBeCloseTo(3, 8);
    expect(r.results[0].method.evaluations).toBeLessThan(200000);
    expect(r.results[0].method.heightErrorBoundKm).toBeNull();
  });
  it('refines an interior maximum and keeps numerical uncertainty distinct from tolerance', async () => {
    const response = await findTrajectoryExtrema(query(), provider(t => [14-(t-4.123)**2/10,0,0]));
    expect(response.status).toBe('complete');
    expect(response.results[0].et).toBeCloseTo(4.123, 3);
    expect(response.results[0].value).toBeCloseTo(4, 8);
    expect(response.results[0].method.heightErrorBoundKm).toBeNull();
    expect(response.results[0].source.classification).toBe('synthetic');
    expect(trajectoryExtremumEvent(response.results[0], 'search')).toMatchObject({ et: response.results[0].et, primaryRole: 'observer', bodies: { observer: 'drone' } });
  });
  it.each(['maximum','minimum'] as const)('includes exact endpoints for %s', async extremum => {
    const r=await findTrajectoryExtrema(query({ extremum }), provider(t => [11+t,0,0]));
    expect(r.results[0].et).toBe(extremum === 'maximum' ? 10 : 0);
  });
  it('evaluates spline interiors rather than ranking authored waypoint heights', async () => {
    const trajectory = new WaypointTrajectory([{ et:0,latDeg:0,lonDeg:0,altKm:0 },{ et:1,latDeg:0,lonDeg:0,altKm:1 },{ et:2,latDeg:0,lonDeg:0,altKm:1 },{ et:3,latDeg:0,lonDeg:0,altKm:0 }],10);
    const p=provider(t => trajectory.stateAt(t).position); p.knots=() => trajectory.waypoints.map(w => w.et);
    const r=await findTrajectoryExtrema(query({ scope: { kind:'windows', windows:[{ start:0,end:3 }] }, stepSeconds:10 }),p);
    expect(r.results[0].value).toBeCloseTo(1.125,8);
    expect(r.results[0].et).toBeCloseTo(1.5,4);
  });
  it('keeps radial and AGL rankings independent, including seam/polar positions', async () => {
    const p=provider(t => [0,0,12+t/10]);
    p.terrain=async position => ({ heightKm:(position[2]-12)*2,sourceUncertaintyKm:.05 });
    const radial=await findTrajectoryExtrema(query(),p);
    const agl=await findTrajectoryExtrema(query({ metric:'heightAbovePhysicalTerrain',terrain:{ id:'grid',revision:'v1' } }),p);
    expect(radial.results[0].et).toBe(10); expect(agl.results[0].et).toBe(0);
    expect(agl.results[0].location.latitudeDeg).toBe(90);
    expect(agl.results[0].terrain?.sourceUncertaintyKm).toBe(.05);
  });
  it('returns unavailable for missing grids without substituting radial height', async () => {
    const r=await findTrajectoryExtrema(query({ metric:'heightAbovePhysicalTerrain',terrain:{ id:'grid',revision:'v1' } }),provider(() => [13,0,0]));
    expect(r.status).toBe('unavailable'); expect(r.results).toEqual([]);
  });
  it('marks known coverage gaps even when a narrow gap falls between sample epochs', async () => {
    const p=provider(t => [12+t/10,0,0]); p.coverage=() => [{ start:0,end:4.01 },{ start:4.02,end:8 }];
    const r=await findTrajectoryExtrema(query(),p);
    expect(r.status).toBe('partial'); expect(r.results[0].coverage).toBe('partial');
    expect(r.results[0].et).toBe(8);
  });
  it('marks nonfinite states/frame failures partial and never bridges them during refinement', async () => {
    const p=provider(t => t===5 ? [NaN,0,0] : [13,0,0]);
    expect((await findTrajectoryExtrema(query(),p)).status).toBe('partial');
    p.position=() => { throw new Error('frame unavailable'); };
    expect((await findTrajectoryExtrema(query(),p)).status).toBe('unavailable');
  });
  it('honors explicit windows and excludes parked intervals under activity scope', async () => {
    const p=provider(t => [10+t,0,0]);
    p.activities=[{ version:1,id:'flight',name:'Flight',kind:'hop',vehicle:'drone',body:'Moon',temporality:'interval',start:2,end:3,provenance:{ source:'fixture',version:'v1',authority:'authored',timing:'exact',limitations:'synthetic' } }];
    const r=await findTrajectoryExtrema(query({ scope:{ kind:'activities',activityKind:'hop' } }),p);
    expect(r.results[0]).toMatchObject({ et:3,value:3,activityId:'flight',window:{ start:2,end:3 } });
  });
  it('returns structured invalid/no-trajectory/budget faults', async () => {
    const p=provider(() => null);
    expect((await findTrajectoryExtrema(query({ objects:[] }),p)).faults[0].code).toBe('invalid-query');
    expect((await findTrajectoryExtrema(query(),p)).status).toBe('unavailable');
    expect((await findTrajectoryExtrema(query({ maxEvaluations:2 }),provider(() => [12,0,0]))).faults[0].code).toBe('budget');
  });
  it('yields by elapsed work before 256 evaluations and observes cancellation immediately', async () => {
    let clock=0, positions=0, yields=0;
    const now=vi.spyOn(performance,'now').mockImplementation(()=>clock);
    const signal={aborted:false};
    const p=provider(()=>{positions++;clock+=5;return [12,0,0];});
    p.yield=async()=>{if(++yields===2)signal.aborted=true;};
    try {
      const result=await findTrajectoryExtrema(query(),p,{signal});
      expect(result).toMatchObject({status:'cancelled',results:[]});
      expect(yields).toBe(2);
      expect(positions).toBe(4);
    } finally {now.mockRestore();}
  });
  it('discards late results on cancellation or source revision changes', async () => {
    const signal={ aborted:false }, p=provider(() => [12,0,0]);
    p.terrain=async () => { signal.aborted=true; return { heightKm:1,sourceUncertaintyKm:null }; };
    const q=query({ metric:'heightAbovePhysicalTerrain',terrain:{ id:'grid',revision:'v1' } });
    expect(await findTrajectoryExtrema(q,p,{ signal })).toMatchObject({ status:'cancelled',results:[] });
    let revision=0; p.revision=() => revision;
    p.terrain=async () => { revision++; return { heightKm:1,sourceUncertaintyKm:null }; };
    expect(await findTrajectoryExtrema(q,p)).toMatchObject({ status:'stale',results:[] });
  });
  it('measures oblate ellipsoid normal height and rejects a sphere datum for that metric', async () => {
    const p=provider(() => [0,0,10]);
    const r=await findTrajectoryExtrema(query({ metric:'heightAboveReferenceEllipsoid',reference:{ kind:'ellipsoid',radiiKm:[10,10,8] } }),p);
    expect(r.results[0].value).toBeCloseTo(2,8);
    expect((await findTrajectoryExtrema(query({ metric:'heightAboveReferenceEllipsoid' }),p)).status).toBe('unavailable');
  });
});

describe('native trajectory Event Finder kind',()=>{
  it('runs through EventSearch without calling GF and preserves partial faults',async()=>{
    const {EventSearch}=await import('../geometry/events/search.js');
    const {builtinEventKinds}=await import('../geometry/events/kinds/index.js');
    const unavailable=()=>{throw Error('GF must not be called');};
    const numerical=await findTrajectoryExtrema(query(),provider(t=>t===5?null:[13,0,0]));
    const search=new EventSearch({registry:builtinEventKinds(),provider:{gfdist:unavailable,gfsep:unavailable,gfposc:unavailable,gfoclt:unavailable},trajectoryAnalysis:async()=>numerical});
    const found=await search.run({id:'height-search',kind:'trajectory-extremum',bodies:{center:'Moon'},window:{start:0,end:10}});
    expect(found).toMatchObject({ok:true,faults:[{code:'unavailable'}],events:[{kind:'trajectory-extremum',queryId:'height-search',primaryRole:'observer',trajectoryAnalysis:{coverage:'partial'}}]});
  });
  it('does not make complete intervals partial because a different interval hit a limit',async()=>{
    const {EventSearch}=await import('../geometry/events/search.js');
    const {builtinEventKinds}=await import('../geometry/events/kinds/index.js');
    const numerical=await findTrajectoryExtrema(query(),provider(()=>[13,0,0]));
    const unavailable=()=>{throw Error('GF must not be called');};
    const search=new EventSearch({registry:builtinEventKinds(),provider:{gfdist:unavailable,gfsep:unavailable,gfposc:unavailable,gfoclt:unavailable},trajectoryAnalysis:async()=>({...numerical,status:'partial',faults:[{code:'budget',object:'other',message:'Other interval reached its allowance.'}]})});
    const found=await search.run({id:'height-search',kind:'trajectory-extremum',bodies:{center:'Moon'},window:{start:0,end:10}});
    expect(found).toMatchObject({ok:true,faults:[{code:'unavailable'}],events:[{trajectoryAnalysis:{coverage:'sampled-complete'}}]});
  });
  it('allows activity-independent windows and reports unavailable host ports',async()=>{
    const {EventSearch}=await import('../geometry/events/search.js');
    const {builtinEventKinds}=await import('../geometry/events/kinds/index.js');
    const unavailable=()=>{throw Error('GF must not be called');};
    const search=new EventSearch({registry:builtinEventKinds(),provider:{gfdist:unavailable,gfsep:unavailable,gfposc:unavailable,gfoclt:unavailable}});
    const q={id:'height',kind:'trajectory-extremum',bodies:{center:'Moon'},window:{start:0,end:10}};
    expect(await search.run({...q,params:{scope:'window'}})).toMatchObject({ok:false,fault:{code:'unavailable'}});
    expect(await search.run(q)).toMatchObject({ok:false,fault:{code:'unavailable'}});
  });
});

describe('trajectory provider boundaries',()=>{
  it('cancels a pending physical-source wait without awaiting its shared download',async()=>{
    const controller=new AbortController(),p=provider(()=>[12,0,0]);
    p.terrain=()=>new Promise(()=>{});
    const pending=findTrajectoryExtrema(query({metric:'heightAbovePhysicalTerrain',terrain:{id:'grid',revision:'v1'}}),p,{signal:controller.signal});
    controller.abort();
    expect(await pending).toMatchObject({status:'cancelled',results:[]});
  });
  it('uses interpolation boundaries for short sampled-state overshoot and refuses inertial location frames',async()=>{
    const {Universe}=await import('../Universe.js');
    const {Body}=await import('../Body.js');
    const {FixedPointTrajectory}=await import('../trajectories/FixedPoint.js');
    const {FixedRotation}=await import('../rotations/FixedRotation.js');
    const {InterpolatedStatesTrajectory}=await import('../trajectories/InterpolatedStates.js');
    const {universeTrajectoryAnalysisProvider}=await import('../geometry/trajectory-extrema.js');
    const universe=new Universe();
    universe.addBody(new Body({name:'Moon',trajectory:new FixedPointTrajectory([0,0,0]),rotation:new FixedRotation([1,0,0,0],'ECLIPJ2000','IAU_MOON')}));
    const trajectory=new InterpolatedStatesTrajectory([
      {et:0,position:[11,0,0],velocity:[0,0,0]},
      {et:4.1,position:[11,0,0],velocity:[10,0,0]},
      {et:4.2,position:[11,0,0],velocity:[-10,0,0]},
      {et:10,position:[11,0,0],velocity:[0,0,0]},
    ],{frame:'IAU_MOON'});
    universe.addBody(new Body({name:'drone',parentName:'Moon',trajectory,description:'Estimated reconstruction, not telemetry; absolute accuracy unknown.'}));
    const p=universeTrajectoryAnalysisProvider(universe,()=>1);
    const found=await findTrajectoryExtrema(query({stepSeconds:100,frame:'IAU_MOON'}),p);
    expect(found.results[0].source).toMatchObject({classification:'unknown',description:'Estimated reconstruction, not telemetry; absolute accuracy unknown.'});
    expect(trajectoryExtremumEvent(found.results[0], 'query').trajectoryAnalysis?.source.description).toBe(found.results[0].source.description);
    expect(found.results[0].et).toBeCloseTo(4.15,3);
    expect(found.results[0].value).toBeCloseTo(1.25,6);
    expect((await findTrajectoryExtrema(query({frame:'J2000'}),p)).status).toBe('unavailable');
  });
  it('preserves separate SPICE coverage windows rather than searching their envelope',async()=>{
    const {Universe}=await import('../Universe.js');
    const {Body}=await import('../Body.js');
    const {SpiceTrajectory}=await import('../trajectories/SpiceTrajectory.js');
    const {universeTrajectoryAnalysisProvider}=await import('../geometry/trajectory-extrema.js');
    const spice={spkcov:()=>[{start:0,end:4},{start:6,end:10}]} as unknown as import('../spice-injection.js').SpiceInstance;
    const universe=new Universe(spice);
    universe.addBody(new Body({name:'probe',trajectory:new SpiceTrajectory(spice,'-1','Moon','J2000')}));
    const p=universeTrajectoryAnalysisProvider(universe,()=>1);
    expect(p.coverage!('probe')).toEqual([{start:0,end:4},{start:6,end:10}]);
  });
  it('returns structured faults for malformed requests and missing requested activity objects',async()=>{
    expect(await findTrajectoryExtrema({scope:null} as unknown as TrajectoryExtremaQuery,provider(()=>null))).toMatchObject({status:'unavailable',faults:[{code:'invalid-query'}]});
    const p=provider(()=>[12,0,0]);
    p.activities=[{version:1,id:'hop',name:'Hop',kind:'hop',vehicle:'drone',body:'Moon',temporality:'interval',start:0,end:10,provenance:{source:'observed-fixture',version:'1',authority:'observed',timing:'exact',limitations:'test'}}];
    p.source=()=>({id:'observed-fixture',revision:'1',classification:'source-observed'});
    const found=await findTrajectoryExtrema(query({objects:['drone','missing'],scope:{kind:'activities'}}),p);
    expect(found.status).toBe('partial'); expect(found.faults[0].object).toBe('missing');
    expect(found.results[0].source.classification).toBe('source-observed');
  });
});


describe('general activity-independent height scope',()=>{
  it('searches a source with no activities and keeps empty activity restrictions explicit',async()=>{
    const p=provider(t=>[10+t,0,0]);p.activities=[];
    expect(await findTrajectoryExtrema(query(),p)).toMatchObject({status:'complete',results:[{et:10,activityId:null}]});
    expect(await findTrajectoryExtrema(query({scope:{kind:'activities',activityKind:'flight'}}),p)).toMatchObject({status:'unavailable',results:[]});
  });
  it('filters rover drives and descent independently and clips explicit selected IDs',async()=>{
    const provenance={source:'fixture',version:'v1',authority:'authored' as const,timing:'exact' as const,limitations:'synthetic'};
    const p=provider(t=>[10+t,0,0]);
    p.activities=[{version:1,id:'drive',name:'Traverse',kind:'drive',vehicle:'drone',body:'Moon',temporality:'interval',start:2,end:4,provenance},{version:1,id:'descent',name:'Descent',kind:'descent',vehicle:'drone',body:'Moon',temporality:'interval',start:6,end:8,provenance}];
    expect(await findTrajectoryExtrema(query({scope:{kind:'activities',activityKind:'drive'}}),p)).toMatchObject({status:'complete',results:[{et:4,activityId:'drive'}]});
    expect(await findTrajectoryExtrema(query({scope:{kind:'activities',ids:['descent'],window:{start:0,end:7}}}),p)).toMatchObject({status:'complete',results:[{et:7,activityId:'descent'}]});
  });
});

// Source encoding precision is evidence, not a generic time tolerance.
describe('source epoch coverage semantics',()=>{
  it('reconciles only outer endpoints that encode to the actual retained Julian date',async()=>{
    const {assessTrajectoryCoverage}=await import('../geometry/trajectory-extrema.js');
    const start=672089519.3,end=672089558.4;
    const jd=(t:number)=>t/86400+2451545,et=(j:number)=>(j-2451545)*86400;
    const source={start:et(jd(start)),end:et(jd(end)),startJulianDate:jd(start),endJulianDate:jd(end)};
    const a=assessTrajectoryCoverage({start,end},[source]);
    expect(a.temporal).toBe('complete');expect(a.endpointReconciliations.length).toBeGreaterThan(0);
    const seen:number[]=[];const p=provider(t=>{seen.push(t);return [12,0,0];});p.coverage=()=>[source];
    const r=await findTrajectoryExtrema(query({scope:{kind:'windows',windows:[{start,end}]}}),p);
    expect(r).toMatchObject({status:'complete',results:[{coverage:'sampled-complete',completeness:{temporal:'complete',numerical:'complete',unavailableSamples:0}}]});
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(source.start);expect(Math.max(...seen)).toBeLessThanOrEqual(source.end);
    expect(r.results[0].window).toEqual({start,end});
    // The identical mismatch without source encoding evidence remains a gap.
    expect(assessTrajectoryCoverage({start,end},[{start:source.start,end:source.end}]).temporal).toBe('partial');
    expect(assessTrajectoryCoverage({start:start-.001,end},[source]).temporal).toBe('partial');
    const mid=(start+end)/2;
    expect(assessTrajectoryCoverage({start,end},[{...source,end:mid},{...source,start:mid+.000001}]).temporal).toBe('partial');
  });
  it('keeps temporal coverage, failed samples and numerical limits independent',async()=>{
    const p=provider(t=>t===5?null:[12+t,0,0]);p.coverage=()=>[{start:0,end:10}];
    const r=await findTrajectoryExtrema(query({maxEvaluations:8}),p);
    expect(r.results[0].completeness).toMatchObject({temporal:'complete',numerical:'budget-limited'});
    const missing=await findTrajectoryExtrema(query(),p);
    expect(missing.results[0].completeness).toMatchObject({temporal:'complete',numerical:'complete',unavailableSamples:1});
    expect(missing.results[0].coverage).toBe('partial');
  });
  it('audits all real Ingenuity activity endpoints against their retained XYZV encodings',async()=>{
    const {readFileSync}=await import('node:fs');
    const {parseXyzv}=await import('../trajectories/XyzvParser.js');
    const {assessTrajectoryCoverage}=await import('../geometry/trajectory-extrema.js');
    const root=new URL('../../../../apps/viewer/test-catalogs/',import.meta.url);
    const catalog=JSON.parse(readFileSync(new URL('ingenuity-jezero.json',root),'utf8'));
    let reconciled=0;
    for(const a of catalog.activities.filter((a:{kind:string})=>a.kind==='flight')) {
      const records=parseXyzv(readFileSync(new URL(a.references.sourceSegment,root),'utf8'));
      const first=records[0],last=records.at(-1)!;
      const assessment=assessTrajectoryCoverage(a,[{start:first.et,end:last.et,startJulianDate:first.julianDate,endJulianDate:last.julianDate}]);
      expect(assessment.temporal,a.id).toBe('complete');
      if(assessment.endpointReconciliations.length)reconciled++;
    }
    expect(catalog.activities.filter((a:{kind:string})=>a.kind==='flight')).toHaveLength(72);
    expect(reconciled).toBe(55);
  });
});
