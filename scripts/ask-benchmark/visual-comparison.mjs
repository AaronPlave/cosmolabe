/** Goal evidence over independently captured render projection and full pose.
 * Geometry supports a comparison; manual screenshot/answer review is still required. */
export function comparisonEvidence(before, after, anchor, target) {
  const at = (t,n) => t.projection?.objects.find(o=>o.object===n);
  const a0=at(before,anchor), a1=at(after,anchor), b1=at(after,target);
  const c0=before.state?.camera, c1=after.state?.camera;
  const vector = c => c?.position.map((v,i)=>v-c.target[i]);
  const v0=vector(c0),v1=vector(c1);
  const orbitAngleDeg = v0 && v1 ? Math.acos(Math.max(-1,Math.min(1,v0.reduce((s,v,i)=>s+v*v1[i],0)/(Math.hypot(...v0)*Math.hypot(...v1)))))*180/Math.PI : null;
  const visible = o => o?.inView && o.drawEnabled && !o.occlusion && o.angularRadiusDeg >= 0.1;
  const checks = {
    clockHeld: before.state?.et===after.state?.et && after.state?.playing===false,
    anchorRangeHeld: !!a0 && !!a1 && Math.abs(a0.rangeKm-a1.rangeKm)<=Math.max(1e-6,a0.rangeKm*1e-3),
    trackedAnchor: after.state?.tracked===anchor,
    poseCaptured: [c0,c1].every(c=>['position','target','up'].every(k=>c?.[k]?.length===3 && c[k].every(Number.isFinite))),
    cameraSwung: orbitAngleDeg!==null && orbitAngleDeg>1,
    bothResolvedUnoccluded: !!visible(a1) && !!visible(b1),
    distinctCenters: !!a1?.ndc && !!b1?.ndc && Math.hypot(...a1.ndc.map((v,i)=>v-b1.ndc[i]))>0.1,
  };
  return {checks, geometricGoalSupported:Object.values(checks).every(Boolean), orbitAngleDeg,
    beforePose:c0,afterPose:c1,angularRadiiDeg:[a1?.angularRadiusDeg,b1?.angularRadiusDeg],
    limitation:'Analytic projection and full pose, not measured physical size or pixel-content proof. Manual visual-usefulness review required.'};
}
