/** Export actual loaded InterpolatedStates and drawn Float32 plot paths.
 * Binary rows: kind (0=Hermite,1=vertex,2=segment interior), ET, x/y/z km.
 * This audits an estimated model, not measured 3D telemetry.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const base=process.argv[2]??'http://localhost:5173/',out=process.argv[3]??'work/ingenuity-246/review-followup/path-samples';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),args:['--enable-gpu','--ignore-gpu-blocklist',process.platform==='darwin'?'--use-angle=metal':'--use-angle=swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:900}}),report={estimated:true,rows:[],passed:false,errors:[]};
page.on('pageerror',e=>report.errors.push(e.message));
try {
 await page.goto(`${base}?catalog=test-catalogs/ingenuity-jezero`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.renderer?.getBodyMesh('Mars')?.terrainManager?.cubeImageryStats?.version,null,{timeout:120000});
 await page.evaluate(async()=>{await window.renderer.waitForInitialAssets();window.cosmo.setPlaying(false);});
 for(let flight=1;flight<=72;flight++){
  const row=await page.evaluate(flight=>{
   const r=window.renderer,b=r.universe.getBody('Ingenuity'),arc=b.trajectory.arcs[flight-1],line=r.trajectoryLines.get(`Ingenuity__arc${flight-1}`),plot=r.trajectoryPlotFrames.get(line);
   if(!plot||plot.frame!=='IAU_MARS'||plot.sourceFrame!=='IAU_MARS')throw Error('Audit requires explicit native Mars-fixed plot coordinates');
   const records=arc.trajectory.records,output=[],add=(kind,t,p)=>output.push(kind,t,...p);
   for(let i=0;i<records.length-1;i++)for(let j=0;j<16;j++){const t=records[i].et+(records[i+1].et-records[i].et)*j/16;add(0,t,arc.trajectory.stateAt(t).position);}
   add(0,records.at(-1).et,records.at(-1).position);
   line.setUserVisible(true);line.invalidate();line.update(records.at(-1).et,r.scaleFactor,undefined,r.camera);
   const drawn=line.drawnTrail(),positions=[];let maxDeviationM=0,maxSegmentM=0,maxTimeGapS=0;
   for(let j=0;j<drawn.count;j++){
    const p=[drawn.positions[3*j]/r.scaleFactor+plot.anchor[0],drawn.positions[3*j+1]/r.scaleFactor+plot.anchor[1],drawn.positions[3*j+2]/r.scaleFactor+plot.anchor[2]],t=drawn.times[j];
    positions.push(p);add(1,t,p);
    const expected=arc.trajectory.stateAt(t).position;maxDeviationM=Math.max(maxDeviationM,Math.hypot(...p.map((v,k)=>v-expected[k]))*1000);
    if(j){const previous=positions[j-1],dt=t-drawn.times[j-1];if(dt<0)throw Error('Plotted times reversed');maxTimeGapS=Math.max(maxTimeGapS,dt);maxSegmentM=Math.max(maxSegmentM,Math.hypot(...p.map((v,k)=>v-previous[k]))*1000);
     for(const f of [.25,.5,.75]){const ti=drawn.times[j-1]+dt*f,q=p.map((v,k)=>previous[k]+f*(v-previous[k]));add(2,ti,q);const state=arc.trajectory.stateAt(ti).position;maxDeviationM=Math.max(maxDeviationM,Math.hypot(...q.map((v,k)=>v-state[k]))*1000);}
    }
   }
   const values=new Float64Array(output),bytes=new Uint8Array(values.buffer);let raw='';for(let k=0;k<bytes.length;k+=8192)raw+=String.fromCharCode(...bytes.subarray(k,k+8192));
   return {flight,binary:btoa(raw),samples:output.length/5,hermiteKnots:records.length,drawnVertices:drawn.count,cacheVertices:line.cache.count,maxDeviationM,maxSegmentM,maxTimeGapS,startEt:records[0].et,endEt:records.at(-1).et,first:records[0].position,last:records.at(-1).position,plotFrame:plot.frame,sourceFrame:plot.sourceFrame};
  },flight);
  const {binary,...meta}=row;assert.ok(meta.drawnVertices>2,`Flight ${flight}: endpoint-only plot`);
  await writeFile(`${out}/flight-${flight}.f64`,Buffer.from(binary,'base64'));report.rows.push(meta);
  console.log(JSON.stringify(meta));
 }
 assert.deepEqual(report.errors,[]);report.passed=true;
}finally{await writeFile(`${out}/samples.json`,JSON.stringify(report,null,2));await browser.close();}
