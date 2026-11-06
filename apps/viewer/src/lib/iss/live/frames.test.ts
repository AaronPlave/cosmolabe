import { describe, it, expect } from 'vitest';
import {
  ISS_MODEL_TO_BODY, inertialToLvlh, lvlhAxes, matrixToQuat, quatConjugate, quatMultiply, quatRotate, telemetryToInertialToBody, type Quat,
} from './frames.js';
import type { Vec3 } from '../joints.js';

const close = (a: Vec3, b: Vec3, d = 1e-12) => { for (let k = 0; k < 3; k++) expect(a[k]).toBeCloseTo(b[k], -Math.log10(d)); };
const R: Vec3 = [7000, 0, 0], V: Vec3 = [0, 7.5, 0];

describe('LVLH', () => {
  it('has x forward, z nadir, y = z x x (hand-checked at a circular equatorial point)', () => {
    const a = lvlhAxes(R, V)!;
    close(a.x, [0, 1, 0]); close(a.z, [-1, 0, 0]); close(a.y, [0, 0, -1]);
  });

  it('removes the radial part of an eccentric velocity', () => {
    const a = lvlhAxes(R, [0.5, 7.5, 0])!;
    close(a.x, [0, 1, 0]);
  });

  it('maps nadir to +Z and the along-track direction to +X (an independent vector check of the quaternion)', () => {
    const q = inertialToLvlh(R, V)!;
    close(quatRotate(q, [-1, 0, 0]), [0, 0, 1]);
    close(quatRotate(q, [0, 1, 0]), [1, 0, 0]);
    close(quatRotate(q, [0, 0, 1]), [0, -1, 0]); // the orbit normal (+Z inertial here) is -Y_lvlh
  });

  it('is undefined when velocity is along the radius', () => {
    expect(lvlhAxes(R, [1, 0, 0])).toBeUndefined();
    expect(lvlhAxes([0, 0, 0], V)).toBeUndefined();
  });
});

describe('telemetryToInertialToBody', () => {
  const identity: Quat = [1, 0, 0, 0];
  const yaw90: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]; // +90 deg about Z, as v_to = q v q*

  it('identity LVLH attitude makes the body axes the LVLH axes', () => {
    const q = telemetryToInertialToBody(identity, { reference: 'LVLH', direction: 'reference-to-body' }, { position: R, velocity: V })!;
    close(quatRotate(q, [0, 1, 0]), [1, 0, 0]);
    close(quatRotate(q, [-1, 0, 0]), [0, 0, 1]);
  });

  it('applies the telemetry rotation after LVLH, in the stated direction', () => {
    const along: Vec3 = [0, 1, 0]; // inertial direction of travel = LVLH +X
    const body = telemetryToInertialToBody(yaw90, { reference: 'LVLH', direction: 'reference-to-body' }, { position: R, velocity: V })!;
    close(quatRotate(body, along), [0, 1, 0]); // +X_lvlh rotated +90 about Z is +Y in the body
    const reverse = telemetryToInertialToBody(yaw90, { reference: 'LVLH', direction: 'body-to-reference' }, { position: R, velocity: V })!;
    close(quatRotate(reverse, along), [0, -1, 0]); // the conjugate turns it the other way
  });

  it('passes an inertial-reference quaternion through, fixing only its direction', () => {
    const q: Quat = [0.5, 0.5, 0.5, 0.5];
    expect(telemetryToInertialToBody(q, { reference: 'inertial', direction: 'reference-to-body' })).toEqual(q);
    expect(telemetryToInertialToBody(q, { reference: 'inertial', direction: 'body-to-reference' })).toEqual([0.5, -0.5, -0.5, -0.5]);
  });

  it('needs an orbit state for LVLH and refuses degenerate input instead of guessing', () => {
    expect(telemetryToInertialToBody(identity, { reference: 'LVLH', direction: 'reference-to-body' })).toBeUndefined();
    expect(telemetryToInertialToBody([0, 0, 0, 0], { reference: 'inertial', direction: 'reference-to-body' })).toBeUndefined();
  });
});

describe('quaternion helpers', () => {
  it('multiply composes coordinate transforms right to left; conjugate inverts', () => {
    const a: Quat = [Math.SQRT1_2, Math.SQRT1_2, 0, 0], b: Quat = [Math.SQRT1_2, 0, Math.SQRT1_2, 0];
    const v: Vec3 = [0.3, -0.5, 0.8];
    close(quatRotate(quatMultiply(a, b), v), quatRotate(a, quatRotate(b, v)));
    close(quatRotate(quatConjugate(a), quatRotate(a, v)), v);
  });

  it('matrixToQuat round-trips every branch', () => {
    for (const m of [[[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[1, 0, 0], [0, -1, 0], [0, 0, -1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]], [[-1, 0, 0], [0, -1, 0], [0, 0, 1]], [[0, 0, 1], [-1, 0, 0], [0, -1, 0]]] as [Vec3, Vec3, Vec3][]) {
      const q = matrixToQuat(m);
      for (const [k, e] of ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]).entries()) close(quatRotate(q, e), [m[0][k], m[1][k], m[2][k]]);
    }
  });
});

describe('ISS model axes', () => {
  it('takes model +Z (forward) to body +X, model +Y (zenith) to body -Z (nadir is +Z) and model +X (port) to body -Y (starboard is +Y)', () => {
    close(quatRotate(ISS_MODEL_TO_BODY, [0, 0, 1]), [1, 0, 0]);
    close(quatRotate(ISS_MODEL_TO_BODY, [0, 1, 0]), [0, 0, -1]);
    close(quatRotate(ISS_MODEL_TO_BODY, [1, 0, 0]), [0, -1, 0]);
    // As the catalog `meshRotation` [w, x, y, z] quoted in the README.
    for (let k = 0; k < 4; k++) expect(ISS_MODEL_TO_BODY[k]).toBeCloseTo([0.5, -0.5, 0.5, -0.5][k], 12);
  });
});
