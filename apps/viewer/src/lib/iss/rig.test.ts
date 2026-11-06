import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { IssRig } from './rig.js';
import { ARRAY_JOINTS, arrayNormal, sunTrackingJointAngles } from './joints.js';
import { buildIssModel, buildNonIssModel } from './__fixtures__/build-model.js';

const find = (root: THREE.Object3D, name: string) => root.getObjectByName(name)!;

describe('IssRig.attach (real ISS node tree)', () => {
  it('verifies the inspected axes, pivots and parent frames and finds all ten joints', () => {
    const { rig, diagnostic } = IssRig.attach(buildIssModel());
    expect(diagnostic).toBeUndefined();
    expect(rig!.jointIds.sort()).toEqual([
      ...ARRAY_JOINTS.map((j) => `array:${j}`), 'truss:P4', 'truss:S4',
    ].sort());
  });

  it('is independent of the container orientation and uniform scale', () => {
    const model = buildIssModel();
    model.quaternion.setFromEuler(new THREE.Euler(0.3, 1.1, -0.7));
    model.scale.setScalar(0.0004);
    model.position.set(5, -2, 9);
    expect(IssRig.attach(model).rig).toBeDefined();
  });

  it('reports a model that is not the ISS as such, without a diagnostic', () => {
    const r = IssRig.attach(buildNonIssModel());
    expect(r.rig).toBeUndefined();
    expect(r.notIss).toBe(true);
    expect(r.diagnostic).toBeUndefined();
  });

  it('reports missing joint nodes with a bounded one-line diagnostic', () => {
    const model = buildIssModel();
    for (const name of ['23_S4_Truss_01', '23_S4_Truss_02', '32_S6_Truss_01', '32_S6_Truss_02', '20_P4_Truss_01']) find(model, name).removeFromParent();
    const { rig, diagnostic } = IssRig.attach(model);
    expect(rig).toBeUndefined();
    expect(diagnostic).toMatch(/^ISS articulation unavailable: model has no .* and 1 more$/);
    expect(diagnostic).not.toContain('\n');
  });

  it('refuses a truss whose rest rotation is not about the model X axis', () => {
    const model = buildIssModel();
    find(model, '23_S4_Truss').quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5);
    model.updateMatrixWorld(true);
    expect(IssRig.attach(model).diagnostic).toMatch(/S4 Truss rest rotation is not about the model X axis/);
  });

  it('refuses a rotated parent frame (a model whose axes differ from the inspected ones)', () => {
    const model = buildIssModel();
    find(model, '22_S3_Truss').quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.2);
    model.updateMatrixWorld(true);
    expect(IssRig.attach(model).diagnostic).toMatch(/parent frame is not aligned/);
  });

  it('refuses an array whose geometry is not a wing along Z rooted at its pivot', () => {
    const model = buildIssModel();
    const wing = find(model, '23_S4_Truss_01');
    wing.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.translate(0, 0, -10); });
    model.updateMatrixWorld(true);
    expect(IssRig.attach(model).diagnostic).toMatch(/23|S4_01.*not a wing along Z/);
  });
});

describe('IssRig.apply / restore', () => {
  it('rotates only the ten joint nodes, about the documented axes, and restores them exactly', () => {
    const model = buildIssModel();
    const before = new Map<string, THREE.Quaternion>();
    model.traverse((o) => before.set(o.uuid, o.quaternion.clone()));
    const rig = IssRig.attach(model).rig!;

    rig.apply({ truss: { S4: 0.4, P4: -1.2 }, arrays: { S6_02: 2.5 } });
    const a = rig.angles();
    expect(a.truss.S4).toBeCloseTo(0.4, 12);
    expect(a.truss.P4).toBeCloseTo(-1.2, 12);
    expect(a.arrays.S6_02).toBeCloseTo(2.5, 12);
    expect(a.arrays.S4_01).toBeCloseTo(0, 12); // untouched

    const moved: string[] = [];
    model.traverse((o) => { if (o.quaternion.angleTo(before.get(o.uuid)!) > 1e-9) moved.push(o.name); });
    expect(moved.sort()).toEqual(['20_P4_Truss', '23_S4_Truss', '32_S6_Truss_02']);

    rig.restore();
    model.traverse((o) => expect(o.quaternion.angleTo(before.get(o.uuid)!)).toBeLessThan(1e-12));
  });

  it('ignores non-finite angles rather than moving a joint', () => {
    const rig = IssRig.attach(buildIssModel()).rig!;
    rig.apply({ truss: { S4: NaN } });
    expect(rig.angles().truss.S4).toBeCloseTo(Math.PI / 3, 6); // authored 60 degrees
  });

  it('never moves the station body: the root and the hull modules keep their transforms', () => {
    const model = buildIssModel();
    const hull = find(model, '09_Destiny_Space_Laboratory');
    const rootBefore = model.quaternion.clone(), hullBefore = hull.quaternion.clone();
    const rig = IssRig.attach(model).rig!;
    rig.apply(sunTrackingJointAngles([0.4, -0.2, 0.9])!);
    expect(model.quaternion.angleTo(rootBefore)).toBe(0);
    expect(hull.quaternion.angleTo(hullBefore)).toBe(0);
  });
});

describe('Sun tracking through the real node hierarchy', () => {
  it('points every wing normal at the Sun in model-local axes after driving the nodes', () => {
    const model = buildIssModel();
    model.quaternion.setFromEuler(new THREE.Euler(0.6, -0.4, 1.2));
    model.updateMatrixWorld(true);
    const rig = IssRig.attach(model).rig!;

    const sunWorld = new THREE.Vector3(0.2, -0.9, 0.35).normalize();
    const local = rig.directionToModel(sunWorld);
    rig.apply(sunTrackingJointAngles([local.x, local.y, local.z])!);
    model.updateMatrixWorld(true);

    for (const id of ARRAY_JOINTS) {
      const node = find(model, ({
        P4_01: '20_P4_Truss_01', P4_02: '20_P4_Truss_02', P6_01: '08_P6_Truss_01', P6_02: '08_P6_Truss_02',
        S4_01: '23_S4_Truss_01', S4_02: '23_S4_Truss_02', S6_01: '32_S6_Truss_01', S6_02: '32_S6_Truss_02',
      } as const)[id]);
      // The wing's +Y (normal), in world.
      const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion()));
      expect(normal.angleTo(sunWorld)).toBeLessThan(1e-9);
    }
    // And the pure forward model agrees.
    const j = sunTrackingJointAngles([local.x, local.y, local.z])!;
    const n = arrayNormal(j.truss!.S4!, j.arrays!.S4_01!);
    expect(Math.hypot(n[0] - local.x, n[1] - local.y, n[2] - local.z)).toBeLessThan(1e-9);
  });
});
