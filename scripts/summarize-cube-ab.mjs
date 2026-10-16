#!/usr/bin/env node
/**
 * Summarize `capture-cube-imagery.mjs --experiments profile --ab` records (#149 frame
 * overhead): per configuration and pose, the draw cull off → on pooled over every page's
 * ABBA/BAAB blocks — draws, drawn tiles, fenced wall/GPU medians and p95s with the paired
 * per-page change (on − off, median [min, max]), CPU stage means, animation-loop intervals —
 * plus the correctness gates (frame pixels differing, culled tiles with pixels).
 *
 *   node scripts/summarize-cube-ab.mjs DIR [--json OUT]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2], jsonOut = process.argv[3] === '--json' ? process.argv[4] : null;
const med = (xs) => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const f = (x, d = 2) => x == null ? '—' : x.toFixed(d);
const out = [];
for (const file of readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
  const rec = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const rows = rec.results.profile ?? [];
  const views = [...new Set(rows.map(r => r.view))];
  console.log(`\n## ${rec.label} (${rec.viewport.width}×${rec.viewport.height})`);
  console.log('view | pages | draws off→on | drawn tiles off→on | fenced wall med off→on (paired Δ med [min,max]) | wall p95 off→on | GPU med off→on (paired Δ) | CPU frame mean off→on | submit off→on | imagery off→on | anim interval med off→on | anim cpu mean off→on | frame diff max | culled w/ px');
  for (const view of views) {
    const rs = rows.filter(r => r.view === view);
    const arm = (on) => rs.flatMap(r => r.ab.filter(b => b.culling === on));
    const A = arm(false), B = arm(true);
    const pick = (bs, g) => bs.map(g);
    const paired = (g) => rs.map(r => mean(r.ab.filter(b => b.culling).map(g)) - mean(r.ab.filter(b => !b.culling).map(g)));
    const dWall = paired(b => b.fenced.wallMs.median), dGpu = paired(b => b.fenced.gpuMs?.median ?? NaN);
    const row = {
      label: rec.label, viewport: rec.viewport, view, pages: rs.length,
      drawsOff: med(pick(A, b => b.fenced.draws.calls)), drawsOn: med(pick(B, b => b.fenced.draws.calls)),
      drawnOff: med(pick(A, b => b.drawn)), drawnOn: med(pick(B, b => b.drawn)),
      wallOff: med(pick(A, b => b.fenced.wallMs.median)), wallOn: med(pick(B, b => b.fenced.wallMs.median)),
      wallP95Off: med(pick(A, b => b.fenced.wallMs.p95)), wallP95On: med(pick(B, b => b.fenced.wallMs.p95)),
      dWall: med(dWall), dWallMin: Math.min(...dWall), dWallMax: Math.max(...dWall),
      gpuOff: med(pick(A, b => b.fenced.gpuMs?.median)), gpuOn: med(pick(B, b => b.fenced.gpuMs?.median)),
      gpuP95Off: med(pick(A, b => b.fenced.gpuMs?.p95)), gpuP95On: med(pick(B, b => b.fenced.gpuMs?.p95)),
      dGpu: med(dGpu), dGpuMin: Math.min(...dGpu), dGpuMax: Math.max(...dGpu),
      cpuOff: mean(pick(A, b => b.fenced.stages.frame)), cpuOn: mean(pick(B, b => b.fenced.stages.frame)),
      tilesOff: mean(pick(A, b => b.fenced.stages.tiles)), tilesOn: mean(pick(B, b => b.fenced.stages.tiles)),
      prepOff: mean(pick(A, b => b.fenced.stages.prep)), prepOn: mean(pick(B, b => b.fenced.stages.prep)),
      submitOff: mean(pick(A, b => b.fenced.stages.submit)), submitOn: mean(pick(B, b => b.fenced.stages.submit)),
      imageryOff: mean(pick(A, b => b.fenced.stages.imagery)), imageryOn: mean(pick(B, b => b.fenced.stages.imagery)),
      animOff: med(pick(A, b => b.anim.intervalMs.median)), animOn: med(pick(B, b => b.anim.intervalMs.median)),
      animP95Off: med(pick(A, b => b.anim.intervalMs.p95)), animP95On: med(pick(B, b => b.anim.intervalMs.p95)),
      animCpuOff: mean(pick(A, b => b.anim.cpuMs.mean)), animCpuOn: mean(pick(B, b => b.anim.cpuMs.mean)),
      animGpuOff: med(pick(A, b => b.anim.gpuMs?.median)), animGpuOn: med(pick(B, b => b.anim.gpuMs?.median)),
      frameDiffMax: Math.max(...rs.map(r => r.frameDiff.differing)), culledWithPixels: rs.reduce((a, r) => a + r.footprint.culledWithPixels, 0),
      footprint: rs[0].footprint, error: rs[0].achievedErrorM ?? null, imagery: rs[0].imagery, memory: rs[0].memory,
    };
    out.push(row);
    console.log([view, row.pages, `${row.drawsOff}→${row.drawsOn}`, `${row.drawnOff}→${row.drawnOn}`,
      `${f(row.wallOff)}→${f(row.wallOn)} (${f(row.dWall)} [${f(row.dWallMin)},${f(row.dWallMax)}])`, `${f(row.wallP95Off)}→${f(row.wallP95On)}`,
      `${f(row.gpuOff)}→${f(row.gpuOn)} (${f(row.dGpu)} [${f(row.dGpuMin)},${f(row.dGpuMax)}])`,
      `${f(row.cpuOff)}→${f(row.cpuOn)}`, `${f(row.submitOff)}→${f(row.submitOn)}`, `${f(row.imageryOff)}→${f(row.imageryOn)}`,
      `${f(row.animOff)}→${f(row.animOn)}`, `${f(row.animCpuOff)}→${f(row.animCpuOn)}`, row.frameDiffMax, row.culledWithPixels].join(' | '));
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 1));
