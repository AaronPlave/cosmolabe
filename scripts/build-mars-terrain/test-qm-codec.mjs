#!/usr/bin/env node
/**
 * Round-trip a sample of .terrain files through the codec and assert
 * the decoded data is preserved exactly. This catches bit-level bugs in
 * delta/zigzag and HWM index encoding before we let the sync script
 * write thousands of tiles.
 */
import { readFileSync } from 'fs';
import { gunzipSync, gzipSync } from 'zlib';
import { decodeTile, encodeTile } from './qm-codec.mjs';
import { join } from 'path';

const BASE = '/Users/aplave/code/cosmolabe/apps/viewer/test-catalogs/data/mars-terrain';
// Sample across LODs and HiRISE/MOLA regions
const samples = [
  '0/0/0.terrain', '0/1/0.terrain',                  // root
  '5/22/9.terrain',                                  // mid-zoom MOLA
  '9/731/308.terrain', '9/732/308.terrain',         // z9 Jezero
  '12/5858/2467.terrain',                            // z12 WBF
  '15/46871/19741.terrain',                          // z15 WBF
];

let fail = 0;
for (const rel of samples) {
  const path = join(BASE, rel);
  let buf;
  try { buf = gunzipSync(readFileSync(path)); } catch (e) { console.log(`SKIP ${rel}: ${e.message}`); continue; }
  const t = decodeTile(buf);
  const enc = encodeTile(t);
  const t2 = decodeTile(enc);

  // Compare
  const mismatches = [];
  for (const k of ['centerX','centerY','centerZ','minHeight','maxHeight','sphereCenterX','sphereCenterY','sphereCenterZ','sphereRadius','horizonOcclusionX','horizonOcclusionY','horizonOcclusionZ']) {
    if (t.header[k] !== t2.header[k]) mismatches.push(`header.${k}: ${t.header[k]} → ${t2.header[k]}`);
  }
  if (t.vertexCount !== t2.vertexCount) mismatches.push(`vertexCount: ${t.vertexCount} → ${t2.vertexCount}`);
  for (const [name, a, b] of [['u', t.u, t2.u], ['v', t.v, t2.v], ['h', t.h, t2.h]]) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) { mismatches.push(`${name}[${i}]: ${a[i]} → ${b[i]}`); break; }
    }
  }
  if (t.triangles.length !== t2.triangles.length) mismatches.push(`triangleCount: ${t.triangles.length/3} → ${t2.triangles.length/3}`);
  else {
    for (let i = 0; i < t.triangles.length; i++) {
      if (t.triangles[i] !== t2.triangles[i]) { mismatches.push(`triangle[${i}]: ${t.triangles[i]} → ${t2.triangles[i]}`); break; }
    }
  }
  for (const dir of ['westIndices', 'southIndices', 'eastIndices', 'northIndices']) {
    if (t[dir].length !== t2[dir].length) mismatches.push(`${dir}.length: ${t[dir].length} → ${t2[dir].length}`);
    else for (let i = 0; i < t[dir].length; i++) {
      if (t[dir][i] !== t2[dir][i]) { mismatches.push(`${dir}[${i}]: ${t[dir][i]} → ${t2[dir][i]}`); break; }
    }
  }
  if (t.extensions.length !== t2.extensions.length) mismatches.push(`extension count: ${t.extensions.length} → ${t2.extensions.length}`);

  if (mismatches.length) {
    console.log(`FAIL ${rel} (${t.vertexCount} verts, ${t.triangles.length/3} tris, ${buf.byteLength}B → ${enc.byteLength}B):`);
    for (const m of mismatches.slice(0, 5)) console.log(`  ${m}`);
    fail++;
  } else {
    console.log(`PASS ${rel} (${t.vertexCount} verts, ${t.triangles.length/3} tris, ${buf.byteLength}B → ${enc.byteLength}B)`);
  }
}

process.exit(fail > 0 ? 1 : 0);
