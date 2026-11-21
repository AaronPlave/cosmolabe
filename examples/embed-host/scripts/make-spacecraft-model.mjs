// Writes public/spacecraft.gltf: a deliberately asymmetric spacecraft so its
// attitude reads at a glance — gold bus, blue solar wings along ±Y, a white
// boom along +X and a red instrument on +Z (the nadir axis for SC-1's LVLH).
// Model axes are the body axes. Run: node scripts/make-spacecraft-model.mjs
import { writeFileSync } from 'node:fs';

const parts = [
  { name: 'bus', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5], color: [0.85, 0.65, 0.2] },
  { name: 'wing+Y', min: [-0.4, 0.5, -0.02], max: [0.4, 2.5, 0.02], color: [0.15, 0.25, 0.7] },
  { name: 'wing-Y', min: [-0.4, -2.5, -0.02], max: [0.4, -0.5, 0.02], color: [0.15, 0.25, 0.7] },
  { name: 'boom+X', min: [0.5, -0.06, -0.06], max: [2.2, 0.06, 0.06], color: [0.95, 0.95, 0.95] },
  { name: 'instrument+Z', min: [-0.2, -0.2, 0.5], max: [0.2, 0.2, 1.1], color: [0.85, 0.15, 0.15] },
];

const faces = [
  [0, [1, 0, 0]], [0, [-1, 0, 0]], [1, [0, 1, 0]], [1, [0, -1, 0]], [2, [0, 0, 1]], [2, [0, 0, -1]],
];
const chunks = [];
const meshes = [];
const accessors = [];
const bufferViews = [];
let offset = 0;
const push = (array, target) => {
  const bytes = Buffer.from(array.buffer);
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
  chunks.push(bytes);
  offset += bytes.length;
  return bufferViews.length - 1;
};
for (const [i, p] of parts.entries()) {
  const pos = [], nrm = [], idx = [];
  for (const [axis, n] of faces) {
    const sign = n[axis];
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const base = pos.length / 3;
    for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const c = [0, 0, 0];
      c[axis] = sign > 0 ? p.max[axis] : p.min[axis];
      c[u] = a ? p.max[u] : p.min[u];
      c[v] = b ? p.max[v] : p.min[v];
      pos.push(...c); nrm.push(...n);
    }
    idx.push(...(sign > 0 ? [base, base + 1, base + 2, base, base + 2, base + 3] : [base, base + 2, base + 1, base, base + 3, base + 2]));
  }
  const pv = push(new Float32Array(pos), 34962), nv = push(new Float32Array(nrm), 34962), iv = push(new Uint16Array(idx), 34963);
  accessors.push(
    { bufferView: pv, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: p.min, max: p.max },
    { bufferView: nv, componentType: 5126, count: nrm.length / 3, type: 'VEC3' },
    { bufferView: iv, componentType: 5123, count: idx.length, type: 'SCALAR' },
  );
  meshes.push({ name: p.name, primitives: [{ attributes: { POSITION: 3 * i, NORMAL: 3 * i + 1 }, indices: 3 * i + 2, material: i }] });
}
const buffer = Buffer.concat(chunks);
const gltf = {
  asset: { version: '2.0', generator: 'cosmolabe embed-host fixture' },
  scene: 0,
  scenes: [{ nodes: parts.map((_, i) => i) }],
  nodes: parts.map((p, i) => ({ name: p.name, mesh: i })),
  meshes,
  materials: parts.map((p) => ({ name: p.name, pbrMetallicRoughness: { baseColorFactor: [...p.color, 1], metallicFactor: 0.2, roughnessFactor: 0.6 } })),
  accessors,
  bufferViews,
  buffers: [{ byteLength: buffer.length, uri: `data:application/octet-stream;base64,${buffer.toString('base64')}` }],
};
writeFileSync(new URL('../public/spacecraft.gltf', import.meta.url), JSON.stringify(gltf));
