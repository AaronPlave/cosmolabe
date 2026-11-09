/**
 * Runs the rig against the real 44 MB NASA glb through three's GLTFLoader,
 * when the Git LFS asset is present (skipped on a pointer-only checkout).
 * Textures are stripped from the glTF JSON first: only nodes and geometry
 * matter here and the loader needs a browser to decode images.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { IssRig } from './rig.js';
import { sunTrackingJointAngles } from './joints.js';
import { buildIssModel } from './__fixtures__/build-model.js';

const GLB = path.resolve(import.meta.dirname, '../../../apps/viewer/test-catalogs/models/ISS_stationary.glb');
const present = fs.existsSync(GLB) && fs.statSync(GLB).size > 1_000_000;

function stripImages(glb: Buffer): ArrayBuffer {
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
  delete json.textures; delete json.images;
  for (const m of json.materials ?? []) {
    delete m.normalTextureInfo; delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
    if (m.pbrMetallicRoughness) { delete m.pbrMetallicRoughness.baseColorTexture; delete m.pbrMetallicRoughness.metallicRoughnessTexture; }
  }
  let text = JSON.stringify(json);
  while (Buffer.byteLength(text) % 4) text += ' ';
  const head = Buffer.from(text);
  const binStart = 20 + jsonLen;
  const bin = glb.subarray(binStart);
  const out = Buffer.alloc(12 + 8 + head.length + bin.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(head.length, 12); out.writeUInt32LE(0x4e4f534a, 16); head.copy(out, 20);
  bin.copy(out, 20 + head.length);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}

describe.skipIf(!present)('real ISS_stationary.glb', () => {
  it('loads through GLTFLoader, passes every rig check, and matches the committed node-tree fixture', async () => {
    const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) =>
      new GLTFLoader().parse(stripImages(fs.readFileSync(GLB)), '', resolve, reject));
    const root = new THREE.Group();
    root.add(gltf.scene);
    root.updateMatrixWorld(true);

    const { rig, diagnostic } = IssRig.attach(root);
    expect(diagnostic).toBeUndefined();
    expect(rig!.jointIds).toHaveLength(10);

    // The fixture the always-on tests use names the same nodes with the same rest transforms.
    const names = (o: THREE.Object3D) => { const s = new Map<string, THREE.Quaternion>(); o.traverse((n) => { if (n.name) s.set(n.name, n.quaternion.clone()); }); return s; };
    const real = names(root), fixture = names(buildIssModel());
    for (const n of ['23_S4_Truss', '20_P4_Truss', '23_S4_Truss_01', '08_P6_Truss_02', '22_S3_Truss', '17_P1_Truss']) {
      expect(real.has(n), n).toBe(true);
      expect(Math.abs(real.get(n)!.dot(fixture.get(n)!)), n).toBeGreaterThan(1 - 1e-6);
    }

    // Driving the real model keeps every wing normal on the Sun.
    const sun = new THREE.Vector3(0.1, -0.8, 0.5).normalize();
    const local = rig!.directionToModel(sun);
    rig!.apply(sunTrackingJointAngles([local.x, local.y, local.z])!);
    root.updateMatrixWorld(true);
    for (const name of ['23_S4_Truss_01', '32_S6_Truss_02', '20_P4_Truss_01', '08_P6_Truss_02']) {
      const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(root.getObjectByName(name)!.getWorldQuaternion(new THREE.Quaternion()));
      expect(normal.angleTo(sun), name).toBeLessThan(1e-9);
    }
  }, 60_000);
});
