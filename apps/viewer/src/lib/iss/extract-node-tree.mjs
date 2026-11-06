#!/usr/bin/env node
/**
 * Extract the node hierarchy and per-node geometry bounds of the NASA ISS
 * model into a small JSON fixture (#370), so articulation tests can run
 * without the 44 MB Git LFS asset. Reads only the glTF JSON chunk.
 *
 *   node apps/viewer/src/lib/iss/extract-node-tree.mjs [model.glb] [out.json]
 */
import fs from 'node:fs';

const input = process.argv[2] ?? 'apps/viewer/test-catalogs/models/ISS_stationary.glb';
const output = process.argv[3] ?? 'apps/viewer/src/lib/iss/__fixtures__/iss-node-tree.json';

const buf = fs.readFileSync(input);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${input} is not a GLB (is it an unfetched Git LFS pointer? run git lfs pull)`);
const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));

const round = (v) => Math.round(v * 1e6) / 1e6;
function bounds(node) {
  if (node.mesh === undefined) return undefined;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const prim of json.meshes[node.mesh].primitives) {
    const acc = json.accessors[prim.attributes.POSITION];
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], acc.min[k]); max[k] = Math.max(max[k], acc.max[k]); }
  }
  return { min: min.map(round), max: max.map(round) };
}
const tree = (index) => {
  const n = json.nodes[index];
  const out = { name: n.name };
  for (const key of ['translation', 'rotation', 'scale']) if (n[key]) out[key] = n[key].map(round);
  const b = bounds(n);
  if (b) out.bounds = b;
  if (n.children?.length) out.children = n.children.map(tree);
  return out;
};
const roots = json.scenes[json.scene ?? 0].nodes.map(tree);
fs.writeFileSync(output, JSON.stringify({ source: 'ISS_stationary.glb (NASA ISS 3D model)', roots }) + '\n');
console.log(`wrote ${output}: ${json.nodes.length} nodes`);
