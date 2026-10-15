#!/usr/bin/env node
// Real archive geometry checks; run after npm run build and fetch-rosetta-kernels.sh.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createSpiceBindings } from 'cspice-wasm';
import { Triangle, Vector3 } from 'three';

const root = fileURLToPath(new URL('../apps/viewer/test-catalogs/', import.meta.url));
const catalog = JSON.parse(readFileSync(`${root}rosetta.json`, 'utf8'));
const spice = await createSpiceBindings();
const bytes = (path) => {
  const raw = readFileSync(root + path);
  return new Uint8Array(path.endsWith('.gz') ? gunzipSync(raw) : raw);
};
spice.furnsh('naif0012.tls', bytes('kernels/naif0012.tls'));
for (const entry of catalog.spiceKernels) {
  const path = typeof entry === 'string' ? entry : entry.url;
  spice.furnsh(path.split('/').pop().replace(/\.gz$/, ''), bytes(path));
}
const shapes = new Map();
function inspect(body) {
  const geometries = body.geometry?.type === 'TimeSwitched'
    ? body.geometry.sequence.map((entry) => entry.geometry) : [body.geometry];
  for (const geometry of geometries) {
    if (geometry?.type !== 'Dsk') continue;
    const path = geometry.source;
    const shape = spice.readDsk(path.split('/').pop().replace(/\.gz$/, ''), bytes(path));
    assert.equal(shape.centerId, body.naifId, `${body.name}: DSK origin must match its trajectory origin`);
    const trajectories = body.arcs?.map((arc) => arc.trajectory) ?? [body.trajectory];
    for (const trajectory of trajectories) {
      assert.equal(Number(trajectory.target), shape.centerId, `${body.name}: trajectory target must be the DSK origin`);
    }
    shapes.set(body.name, shape);
    console.log(`${body.name}: ${shape.centerId}, ${shape.frame}, ${shape.vertices.length / 3} vertices`);
  }
  body.items?.forEach(inspect);
}
catalog.items.forEach(inspect);
const bus = catalog.items.find((item) => item.name === 'Rosetta');
for (const part of bus.items) {
  assert.equal(Number(part.trajectory.center), bus.naifId, `${part.name}: offset must be relative to the bus structure origin`);
}
for (const utc of ['2004-03-02T12:00:00', '2010-07-10T15:44:55', '2014-11-12T08:35:14', '2014-11-12T08:35:16', '2016-09-30T10:39:29']) {
  const et = spice.str2et(utc);
  const offset = spice.spkpos('-226000', et, 'ROS_SPACECRAFT', 'NONE', '-226').position;
  console.log(`${utc}: structure minus CoM (m): ${[offset.x, offset.y, offset.z].map((v) => (v * 1000).toFixed(6)).join(', ')}`);
  for (const part of bus.items) {
    const position = spice.spkpos(String(part.naifId), et, 'ROS_SPACECRAFT', 'NONE', String(bus.naifId)).position;
    assert.ok([position.x, position.y, position.z].every(Number.isFinite));
  }
}
// Measure the archived site against the actual selected DSK, without inventing
// a corrective translation or treating the bounding sphere as physical terrain.
const et = spice.str2et('2014-11-12T18:00:00');
const p = spice.spkpos('-226800', et, '67P/C-G_CK', 'NONE', '1000012').position;
const point = new Vector3(p.x, p.y, p.z);
const mesh = shapes.get('67P/Churyumov-Gerasimenko');
const triangle = new Triangle(), closest = new Vector3();
let nearestKm = Infinity;
for (let i = 0; i < mesh.plates.length; i += 3) {
  triangle.a.fromArray(mesh.vertices, 3 * mesh.plates[i]);
  triangle.b.fromArray(mesh.vertices, 3 * mesh.plates[i + 1]);
  triangle.c.fromArray(mesh.vertices, 3 * mesh.plates[i + 2]);
  triangle.closestPointToPoint(point, closest);
  nearestKm = Math.min(nearestKm, closest.distanceTo(point));
}
assert.ok(Number.isFinite(nearestKm));
console.log(`Abydos archived origin ${point.toArray().join(', ')} km: nearest K200 triangle ${(nearestKm * 1000).toFixed(6)} m`);
