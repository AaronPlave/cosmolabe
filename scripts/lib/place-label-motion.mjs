import assert from 'node:assert/strict';
// Gate the actual on-screen sequence, including fades, in both zoom directions.
export function checkZoom(result) {
  const sequences = new Map();
  for (const sample of result.samples) {
    const visible=sample.labels.filter(l=>l.opacity>.1);
    for(let i=0;i<visible.length;i++) for(let j=i+1;j<visible.length;j++) {
      const a=visible[i],b=visible[j];
      assert.ok(!(a.x<b.x+b.width && a.x+a.width>b.x && a.y<b.y+b.height && a.y+a.height>b.y),
        `Overlapping visible names ${JSON.stringify(a)} / ${JSON.stringify(b)} during ${result.phase}`);
    }
    for(const l of sample.labels) if(!sequences.has(l.id)) sequences.set(l.id,[]);
    for(const [id,seq] of sequences) seq.push({visible:visible.some(l=>l.id===id),accepted:sample.labels.some(l=>l.id===id&&l.accepted),range:sample.rangeKm});
  }
  const transitions=[];
  for(const [id,seq] of sequences) {
    const runs=seq.filter((v,i)=>i===0||v.visible!==seq[i-1].visible).map(v=>v.visible);
    const acceptedRuns=seq.filter((v,i)=>i===0||v.accepted!==seq[i-1].accepted).map(v=>v.accepted);
    assert.ok(runs.filter(Boolean).length<=2,`${id} repeatedly flashes during ${result.phase}: ${runs}`);
    assert.ok(acceptedRuns.filter(Boolean).length<=2,`${id} repeatedly loses ownership during ${result.phase}`);
    let lastExit;
    for(let i=1;i<seq.length;i++) {
      // Measure scale hysteresis from loss of ownership, when departure
      // actually starts. Measuring from the end of a 250ms fade makes the
      // assertion depend on GPU frame time. Unexplained opacity loss while
      // still accepted remains a separate immediate departure.
      if(!seq[i].accepted&&seq[i-1].accepted)lastExit=seq[i].range;
      if(!seq[i].visible&&seq[i-1].visible&&(seq[i].accepted||lastExit===undefined))lastExit=seq[i].range;
      if(seq[i].visible&&seq[i-1].visible&&seq[i].accepted)lastExit=undefined;
      if(seq[i].visible&&!seq[i-1].visible&&lastExit!==undefined) {
        const change=Math.max(seq[i].range,lastExit)/Math.min(seq[i].range,lastExit);
        assert.ok(change>=1.25,`${id} returns without meaningful zoom change (${change}) during ${result.phase}`);
        lastExit=undefined;
      }
    }
    transitions.push({id,runs,acceptedRuns});
  }
  const first=result.samples[0],last=result.samples.at(-1);
  assert.ok(last.handoffs-first.handoffs<=32,`Excessive collision handoffs during ${result.phase}`);
  result.sequences=transitions;
}
