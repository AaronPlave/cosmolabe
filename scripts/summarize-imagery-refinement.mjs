/** Compact comparable GPU evidence; retain raw traces outside the repository.
 * node scripts/summarize-imagery-refinement.mjs BEFORE FINAL OUTPUT
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const [beforeFile, afterFile, output] = process.argv.slice(2);
assert.ok(beforeFile && afterFile && output, 'BEFORE FINAL OUTPUT required');
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const [before, after] = await Promise.all([read(beforeFile), read(afterFile)]);
assert.ok(before.passed && after.passed, 'Both GPU runs must pass');
const distribution = values => {
  const a = values.filter(Number.isFinite).toSorted((a,b)=>a-b);
  return { n:a.length, p50:a[Math.floor(a.length*.5)]??null, p95:a[Math.floor(a.length*.95)]??null, max:a.at(-1)??null };
};
const common = phase => /^(warm|drag-|faulty-loading|faulty-settled|accelerated-follow|revisit)/.test(phase.name);
const summarize = mission => {
  const phases=mission.phases.filter(common), frames=phases.flatMap(p=>p.samples), last=phases.at(-1).samples.at(-1);
  return {
    gpu:phases[0].gpu, firstPoseToSettledMs:mission.firstPoseToSettledMs,
    frameIntervalMs:distribution(phases.flatMap(p=>p.intervals)),
    imageUpdateMs:distribution(frames.map(s=>s.imagery.updateMs)),
    maximumResidentBytes:Math.max(...frames.map(s=>s.imagery.textureBytes)),
    maximumAllocatedBytes:Math.max(...frames.map(s=>s.imagery.gpuAllocatedBytes??s.imagery.textureBytes)),
    maximumExtraDraws:Math.max(...frames.map(s=>s.imagery.extraDraws)),
    maximumDerivedGeometryBytes:Math.max(...frames.map(s=>s.imagery.blockGeometryBytes??0)),
    finalCounters:Object.fromEntries(['requests','aborted','evicted','failures','blockBuildMs','textureBytes','maxTextureBytes','budgetLimited','queued','inFlight'].map(k=>[k,last.imagery[k]])),
    revisitAnchor:last.anchor, faults:mission.faults, visibleImage:mission.visibleImage,
    perPhase:phases.map(p=>({name:p.name,frames:p.samples.length,
      frameIntervalMs:distribution(p.intervals),imageUpdateMs:distribution(p.samples.map(s=>s.imagery.updateMs)),
      churn:Object.fromEntries(['requests','evicted','aborted'].map(k=>[k,p.samples.at(-1).imagery[k]-p.samples[0].imagery[k]])),
      baseUncoveredMaximum:Math.max(...p.samples.map(s=>s.imagery.baseUncoveredBlocks)),
      committedGroups:p.samples.reduce((n,s)=>n+(s.imagery.committedGroups??0),0),
      maximumWaitingGroups:Math.max(...p.samples.map(s=>s.imagery.waitingGroups??0))})),
  };
};
const report={kind:'independent-imagery-gpu-comparison',version:1,passed:true,
  baselineCommit:'d9619bb473c262346a8f6453ad6a5c22162f1f7b',
  inputSha256:{},
  method:'Same actual mission catalogs, physical GPU, viewport, poses and native mouse movements. Common phases only: warm, eight drags, delayed/failing territory, accelerated follow and revisit. Captures at 500ms and 1200ms during adverse loading run in both versions; timing includes those captures. Allocation-failure, seams and context restoration are additional after-only gates.',
  limits:['First-pose time includes physical terrain coverage and a fixed 600ms settle delay; it is not isolated network latency.',
    'Old allocation bytes use its resident-texture estimate; new allocation includes the reserved array and integer page table.',
    'Both versions use the current catalog residency target to isolate architecture. This is not a comparison against the old 256MiB mission configuration.',
    'Requests and evictions include camera-history and after-only allocation fault effects; frame distributions exclude after-only phases.',
    'Measurements apply to the recorded Chrome/Metal device; no weaker-device claim.'],missions:[]};
for(const [key,file] of [['before',beforeFile],['after',afterFile]])report.inputSha256[key]=createHash('sha256').update(await readFile(file)).digest('hex');
for(const a of after.missions){
  const b=before.missions.find(m=>m.mission===a.mission);assert.ok(b);
  assert.deepEqual(a.errors,[]);
  const revisit=a.phases.find(p=>p.name==='revisit');assert.ok(revisit);
  for(const key of ['requests','evicted','aborted'])assert.equal(revisit.samples.at(-1).imagery[key],revisit.samples[0].imagery[key],`Settled revisit ${key} churn`);
  const extra=a.phases.filter(p=>!common(p));
  assert.ok(extra.some(p=>p.name==='context-restored'));
  assert.ok(extra.every(p=>p.samples.every(s=>s.imagery.baseUncoveredBlocks===0)));
  report.missions.push({mission:a.mission,before:summarize(b),after:summarize(a),
    additionalGates:extra.map(p=>({name:p.name,frames:p.samples.length,baseUncoveredMaximum:Math.max(...p.samples.map(s=>s.imagery.baseUncoveredBlocks))}))});
}
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify(report,null,2)+'\n');
const captures=join(dirname(output),'captures');await mkdir(captures,{recursive:true});
for(const mission of after.missions)for(const [label,file] of [['before',beforeFile],['after',afterFile]]){
  await copyFile(join(dirname(file),`${mission.mission}-faults-loading.png`),join(captures,`${mission.mission}-${label}-loading.png`));
  if(label==='after')await copyFile(join(dirname(file),`${mission.mission}-revisit.png`),join(captures,`${mission.mission}-after.png`));
}
console.log(JSON.stringify({output,missions:report.missions.map(m=>({mission:m.mission,before:m.before.frameIntervalMs.p95,after:m.after.frameIntervalMs.p95}))}));
